export type Hex = `0x${string}`

export type EvmChain = {
  kind: 'evm'
  domain: number
  name: string
  chainId: number
  usdc: Hex
  rpc: string
  explorer?: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
}

// Addresses are base58. tokenMessenger and messageTransmitter are the CCTP V2 programs.
export type SolanaChain = {
  kind: 'solana'
  domain: number
  name: string
  usdc: string
  rpc: string
  explorer: string
  tokenMessenger: string
  messageTransmitter: string
}

export type Chain = EvmChain | SolanaChain

export type Config = {
  network: 'mainnet' | 'testnet'
  autoRedeem: boolean
  swap: boolean // USDC → INJ swaps for gas
  tokenMessenger: Hex
  messageTransmitter: Hex
  chains: Omit<EvmChain, 'kind'>[]
  solana?: Omit<SolanaChain, 'kind'>
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
  const res = await fetch(API_URL + path, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch(() => {
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
