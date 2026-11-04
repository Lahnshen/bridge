import { encode } from './evm'

export type Hex = `0x${string}`

export type Kind = 'evm' | 'solana' | 'cosmos' | 'bitcoin' | 'tron' | 'sui' | 'zcash' | 'ton' | 'xrp' | 'eclipse' | 'hypercore' | 'lighter' | 'aptos' | 'stellar' | 'starknet' | 'iota'
export type Asset = { address: string; symbol: string; name: string; decimals: number; logo?: string }

// A chain the bridges reach (/chains networks). The ones CCTP reaches have a domain.
type ChainBase = {
  id: string // in links and the API: "ethereum", "osmosis", "bitcoin"
  name: string
  logo?: string
  domain?: number
  explorer?: string // a transaction's page, {tx} standing for its hash
  native?: Asset // the gas token, as the chain's token list writes it
  via: string[] // the bridges that reach it
  send: boolean // the app can send from it; the others are destinations only
}
// cosmos: the chain's Cosmos side, when the two are one chain (Injective): its routes over IBC start and end there.
export type EvmChain = ChainBase & { kind: 'evm'; chainId: number; rpc?: string; usdc?: Hex; cosmos?: CosmosChain }
// Addresses are base58. tokenMessenger and messageTransmitter are the CCTP V2 programs.
export type SolanaChain = ChainBase & { kind: 'solana'; usdc: string; rpc?: string; tokenMessenger: string; messageTransmitter: string }
// slip44 is the key type: chains with the same one share an account (60 is Ethereum's: inj1… is the 0x… address).
export type CosmosChain = ChainBase & { kind: 'cosmos'; cosmosId: string; bech32: string; slip44: number; rpc?: string; rest?: string; gas?: { denom: string; price: string } }
export type OtherChain = ChainBase & { kind: Exclude<Kind, 'evm' | 'solana' | 'cosmos'> }
export type Chain = EvmChain | SolanaChain | CosmosChain | OtherChain
// A chain CCTP reaches, with its USDC.
export type CctpChain = (EvmChain & { domain: number; usdc: Hex }) | (SolanaChain & { domain: number })

export type Config = {
  network: 'mainnet' | 'testnet'
  autoRedeem: boolean
  swap: boolean // USDC → INJ swaps for gas
  providers: { id: string; name: string }[] // bridges quoted besides CCTP
  tokenMessenger: Hex
  messageTransmitter: Hex
  solana?: { usdc: string; tokenMessenger: string; messageTransmitter: string }
  networks: (Omit<Chain, 'kind'> & { kind: Kind } & Record<string, unknown>)[]
}

export type Transfer = {
  sourceDomain: number
  sourceChain: string
  destinationDomain: number
  destinationChain: string
  txHash: string
  txUrl?: string
  nonce?: string
  amount?: string
  fee?: string
  sender?: string
  recipient?: string
  status: 'pending' | 'ready' | 'redeemed' | 'restricted'
  note?: string
  redeemTx?: string
  redeemTxUrl?: string
  message?: Hex
  attestation?: Hex
  time?: number // when it was sent (unix seconds), for transfers the server has indexed
}

// fastBps: Fast Transfer fee (bps of the amount), forwardFee: USDC Circle takes to deliver from Injective,
// standardTime: average wait for a standard transfer. Each is null when it doesn't apply.
export type Fees = { fastBps: number | null; forwardFee: string | null; standardTime: string | null }

export const INJECTIVE = 29
export const SOLANA = 5

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')

// A hung request would stall the transfer tracking loop. Redeems wait for the mint, and sometimes for Circle to re-sign.
async function call<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const res = await fetch(API_URL + path, { ...init, signal }).catch(() => {
    throw new ApiError(0, 'Could not reach the bridge server. Please try again.')
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`)
  return data
}

// A Solana signature is 64 bytes (~88 base58 characters), a Solana address 32 (32–44 characters).
export const isTxHash = (q: string) => /^0x[0-9a-fA-F]{64}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(q)
export const isAddress = (q: string) => /^0x[0-9a-fA-F]{40}$/.test(q) || /^inj1[02-9ac-hj-np-z]{38}$/i.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)

export const getConfig = () => call<Config>('/chains')
// recipientSetup: to Solana, include creating the recipient's USDC account.
export const getFees = (from: number, to: number, recipientSetup = false) => call<Fees>(`/fees/${from}/${to}${recipientSetup ? '?recipientSetup=true' : ''}`)
export const getBalance = (domain: number, address: string) => call<{ balance: string }>(`/balance/${domain}/${address}`)
export const getAddressTransfers = (address: string) => call<{ transfers: Transfer[] }>(`/address/${address}`)
// A page of every transfer from or to an address, newest first. next is the offset of the next page.
export const getHistory = (address: string, offset = 0) =>
  call<{ transfers: Transfer[]; next: number | null }>(`/history/${address}?offset=${offset}`, undefined, 60_000)
export const getTxTransfers = (hash: string, domain?: number) =>
  call<{ transfers: Transfer[] }>(`/tx/${hash}${domain === undefined ? '' : `?domain=${domain}`}`)
// ---- USDC → INJ on Injective, gas free ----------------------------------------------------------------

// What a swap of `amount` USDC buys now, and what the wallet signs to pay for it: an EIP-3009 ReceiveWithAuthorization
// moving the USDC to the relayer (`to`), on the USDC contract's EIP-712 domain.
export type SwapQuote = {
  amount: string // USDC
  inj: string // expected
  minInj: string // the least the swap goes through for
  price: string // USDC per INJ
  to: Hex
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex }
}
export type SwapRequest = { from: Hex; value: string; validAfter: number; validBefore: number; nonce: Hex; signature: Hex; minInj: string }
// pending: the order went through, and the server sends the INJ as soon as it sees the fill.
export type SwapResult = { status: 'done' | 'pending'; txHash: Hex | null; txUrl?: string; inj: string; refund: string | null }

export const getSwapQuote = (amount: string) => call<SwapQuote>(`/swap/quote?amount=${amount}`)
export const swap = (body: SwapRequest) =>
  call<SwapResult>('/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 120_000)

// The few Solana RPC calls a transfer from Solana needs, through the server.
export const solanaRpc = async <T>(method: string, params: unknown[]) =>
  (await call<{ result: T }>('/solana', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })).result

export const redeem = (txHash: string, domain: number) =>
  call<{ transfers: Transfer[] }>(
    '/redeem',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, domain }) },
    150_000,
  )

// ---- Other bridges: tokens, quotes, tracking ------------------------------------------------------------

export const NATIVE = '0x0000000000000000000000000000000000000000' // an EVM chain's gas token
export const SOL = '11111111111111111111111111111111'
const sameAddress = (a: string, b: string) => (a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b)
// The chain's gas token: NATIVE on EVM chains, SOL on Solana, the fee denom on Cosmos chains.
export const isNative = (chain: Chain, address: string) => !!chain.native && sameAddress(address, chain.native.address)

export type Token = {
  chain: string // chain id
  address: string // 0x…, a Solana mint, a Cosmos denom…; the chain's native address for its gas token
  symbol: string
  name: string
  decimals: number
  logo?: string
  priceUsd?: number
  verified: boolean
}
export const sameToken = (a: Token, b: Token) => a.chain === b.chain && sameAddress(a.address, b.address)

// What the wallet does, in order. Approvals are skipped when the allowance already covers them.
export type Step =
  | { kind: 'approve'; chainId: number; token: Hex; spender: Hex; amount: string }
  | { kind: 'evm'; chainId: number; to: Hex; data: Hex; value: string; gas?: string }
  | { kind: 'solana'; transaction: string } // base64, for the wallet to sign
  | { kind: 'cosmos'; chainId: string; signer: string; messages: { typeUrl: string; value: string }[]; memo?: string } // protobuf, base64
  // From Hyperliquid, both signed by the EVM wallet at whatever chain it's on (see runSteps): a message authorizing the
  // transfer, posted to url, then the transfer itself, a Hyperliquid action sent to its API. order: the bridge's id for it.
  | { kind: 'signature'; typedData: TypedData; post: { url: string; body: Record<string, unknown> } }
  | { kind: 'hyperliquid'; api: string; action: { type: string } & Record<string, unknown>; nonce: number; types: TypedData['types']; primaryType: string; order: string }
export type TypedData = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }

// Amounts in base units of the destination token. feeUsd is already taken out of amountOut; costUsd / costNative
// (gas token base units) are paid on top.
export type Quote = {
  provider: string
  name: string
  via?: string
  amountOut: string
  minAmountOut: string
  seconds: number
  feeUsd?: number
  costUsd?: number
  costNative?: string
  usdIn?: number // the amount sent and the amount out in USD, as the bridge prices them
  usdOut?: number
  steps: Step[] // empty until asked with the sender's address
  needs?: string[] // chains the route passes through where it needs one of the user's addresses (chain ids)
  side?: string // the id of Injective's Cosmos side, when the route starts or ends there instead of the EVM side
  track: Record<string, string>
}
export type QuoteBody = {
  from: string
  to: string
  fromToken: string
  toToken: string
  amount: string
  sender?: string
  recipient?: string
  addresses?: Record<string, string> // the user's accounts on other chains, by chain id
  slippageBps?: number
  providers?: string[]
}
export type Progress = { status: 'pending' | 'done' | 'failed' | 'refunded'; destinationTx?: string; amountOut?: string; note?: string }

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export const getTokens = (chain: string, q = '') => call<{ popular: Token[]; tokens: Token[] }>(`/tokens/${chain}${q ? `?q=${encodeURIComponent(q)}` : ''}`)

// A token's balance in base units. On EVM chains the browser also asks the chain's public RPC itself, and the first answer
// wins: the server may have better RPCs, but where it uses the public ones, its indexer has used up much of their rate limit.
// Solana's public RPC turns browsers away, so Solana (and Cosmos) balances come from the server only.
export function tokenBalance(chain: Chain, owner: string, token: string, signal?: AbortSignal): Promise<bigint> {
  const server = call<{ raw: string }>(`/balance/${chain.id}/${owner}?token=${encodeURIComponent(token)}`, { signal }).then((r) => BigInt(r.raw))
  if (chain.kind !== 'evm' || !chain.rpc || !token.startsWith('0x')) return server // Injective's denoms: the server reads them
  const direct = token === NATIVE
    ? rpc(chain.rpc, 'eth_getBalance', [owner, 'latest'], signal)
    : rpc(chain.rpc, 'eth_call', [{ to: token, data: encode.balanceOf(owner as Hex) }, 'latest'], signal)
  return Promise.any([server, direct.then(BigInt)])
}

async function rpc(url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(10_000)
  const res = await fetch(url, { ...post({ jsonrpc: '2.0', id: 1, method, params }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  const data = await res.json()
  if (typeof data.result !== 'string') throw new Error(data.error?.message ?? `RPC error (${res.status})`)
  return data.result
}

export const getQuotes = (body: QuoteBody, signal?: AbortSignal) =>
  call<{ quotes: Quote[]; errors: { provider: string; message: string }[] }>('/quotes', { ...post(body), signal }, 20_000)
export const getRouteStatus = (body: { provider: string; txHash: string; from: string | number; to: string | number; track: Record<string, string> }) =>
  call<Progress>('/quotes/status', post(body))

// ---- Sending from Cosmos chains: the server builds the transaction, the wallet signs it, the server broadcasts it -----

export type PreparedTx = { chainId: string; accountNumber: string; bodyBytes: string; authInfoBytes: string; fee: { denom: string; amount: string; gas: string } }
export const prepareCosmosTx = (body: { chain: string; signer: string; pubKey: string; algo?: string; messages: { typeUrl: string; value: string }[]; memo?: string }) =>
  call<PreparedTx>('/cosmos/prepare', post(body), 45_000)
export const broadcastCosmosTx = (body: { chain: string; bodyBytes: string; authInfoBytes: string; signature: string }) => call<{ txHash: string }>('/cosmos/broadcast', post(body))
export const cosmosTxStatus = (chain: string, hash: string) => call<{ status: 'pending' | 'success' | 'failed'; height?: string; error?: string }>(`/cosmos/tx/${chain}/${hash}`)
