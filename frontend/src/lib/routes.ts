import cctpLogo from '../assets/providers/cctp.svg'
import { injectiveAddress, parseAddress, walletKind } from './address'
import { broadcastCosmosTx, cosmosTxStatus, INJECTIVE, prepareCosmosTx, type Chain, type CosmosChain, type EvmChain, type Hex, type Quote, type Step, type Token, type TypedData } from './api'
import { chainById } from './app.svelte'
import { addressFromWallet, connectCosmosWallet, cosmosKey, cosmosWallet, derivedAddress, signCosmos } from './cosmos-wallet.svelte'
import { amountString, encode } from './evm'
import { sendWithEvmWallet } from './injective-eip712'
import { sendSigned } from './solana'
import { signSolanaTransaction, solanaWallet } from './solana-wallet.svelte'
import { addRecent } from './transfers.svelte'
import { call, connectWallet, currentChain, sendTx, signTypedData, sleep, switchChain, waitForReceipt, wallet } from './wallet.svelte'

// Bridges other than CCTP: their logos, the connected wallets' accounts on a route's chains, running the steps of one of
// their quotes with the connected wallet, and the transfer it sent into Recent. The Bridge and Onboard tabs both send so.

const files = import.meta.glob<string>('../assets/providers/*.{svg,png,jpg}', { eager: true, query: '?url', import: 'default' })
export const providerLogo = (id: string) => (id === 'cctp' ? cctpLogo : Object.entries(files).find(([path]) => path.split('/').pop()!.split('.')[0] === id)?.[1])

// USDT on Ethereum refuses to change an allowance that isn't zero.
export const RESET_FIRST = new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7'])

const base64Bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

// ---- Accounts -----------------------------------------------------------------------------------

// The connected wallet's address on a chain: the EVM wallet's on EVM chains (and Hyperliquid, Lighter), the Solana
// wallet's on Solana and Eclipse, and on Cosmos chains the Cosmos wallet's, which it gives per chain. To receive, an
// address the account surely has there does too (see derivedAddress). On Injective without an EVM wallet, the Cosmos
// wallet's inj1… account, as 0x… (the same account).
export function addressOn(chain: Chain, receiving = false) {
  const kind = walletKind(chain)
  if (kind === 'evm') return wallet.address?.toLowerCase() ?? cosmosSideAddress(chain)
  if (kind === 'solana') return solanaWallet.address
  if (chain.kind !== 'cosmos') return
  return receiving ? derivedAddress(chain) : cosmosWallet.addresses[chain.id]
}
const cosmosSideAddress = (chain: Chain) => {
  const theirs = chain.kind === 'evm' && chain.cosmos ? cosmosWallet.addresses[chain.cosmos.id] : undefined
  return theirs && parseAddress(chain, theirs)
}

// Injective's Cosmos side, when a route starts or ends there (side: its id): the transfer's transactions are that side's.
export const sideOf = (chain: Chain, side?: string) => (chain.kind === 'evm' && chain.cosmos && chain.cosmos.id === side ? chain.cosmos : undefined)

// The account that signs on Injective's Cosmos side: Keplr's where it's connected, else the EVM wallet's (its inj1… form),
// which signs there as EIP-712 typed data (see injective-eip712.ts).
export async function cosmosSigner(side: CosmosChain, progress: (label: string) => void) {
  if (!cosmosWallet.connected && wallet.address) return injectiveAddress(wallet.address)
  if (!cosmosWallet.connected) {
    void connectWallet()
    throw new Error(`This route starts on ${side.name}'s Cosmos side: connect a wallet, then try again.`)
  }
  progress(`Getting your ${side.name} address…`)
  return cosmosWallet.addresses[side.id] ?? (await addressFromWallet(side))
}

// The user's addresses on chains a route passes through (for the transfer to stop at, should it stop on the way), from
// the Cosmos wallet, which may ask to allow each chain.
export async function addressesFor(ids: string[], progress: (label: string) => void) {
  const found: Record<string, string> = {}
  for (const id of ids) {
    const chain = chainById(id)
    if (chain?.kind !== 'cosmos') throw new Error(`This route needs your address on ${chain?.name ?? id}, which no wallet here gives.`)
    if (!cosmosWallet.connected) {
      void connectCosmosWallet(chain)
      throw new Error(`This route passes through ${chain.name}: connect Keplr for your address there, then try again.`)
    }
    progress(`Getting your ${chain.name} address…`)
    found[id] = derivedAddress(chain) ?? (await addressFromWallet(chain))
  }
  return found
}

// ---- Sending ------------------------------------------------------------------------------------

// eth_signTypedData_v4 wants the domain's own type spelled out, field by field.
const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']]
const withDomainType = (data: TypedData) => ({
  ...data,
  types: { EIP712Domain: DOMAIN_FIELDS.filter(([name]) => name! in data.domain).map(([name, type]) => ({ name, type })), ...data.types },
})

async function postJson<T>(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => undefined)) as T | undefined
  if (!res.ok || !json) throw new Error((json as { message?: string } | undefined)?.message ?? `${new URL(url).host} answered ${res.status}.`)
  return json
}

// A Hyperliquid transfer's hash: its API doesn't return one, but the sender's ledger lists the transfer by its nonce.
async function hyperliquidHash(api: string, user: string, nonce: number) {
  type Update = { hash: string; delta: { nonce?: number } }
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    const updates = await postJson<Update[]>(`${api}/info`, { type: 'userNonFundingLedgerUpdates', user, startTime: Date.now() - 300_000 }).catch(() => [])
    const found = updates.find((u) => u.delta.nonce === nonce)
    if (found) return found.hash
  }
}

// Returns the hash (or Solana signature) of the last transaction: the transfer itself.
export async function runSteps(chain: Chain, steps: Step[], progress: (label: string) => void, devnet = false): Promise<string> {
  let hash: string | undefined
  for (const [i, step] of steps.entries()) {
    const last = i === steps.length - 1
    if (step.kind === 'solana') {
      progress('Confirm the transfer in your wallet…')
      const signed = await signSolanaTransaction(base64Bytes(step.transaction), devnet)
      progress('Sending…')
      hash = await sendSigned(signed)
      continue
    }
    if (step.kind === 'signature' || step.kind === 'hyperliquid') {
      // Hyperliquid isn't an EVM chain: the wallet signs these messages at whatever chain it's on, and says which in them.
      const chainId = await currentChain()
      if (step.kind === 'signature') {
        progress('Sign the authorization in your wallet…')
        const signature = await signTypedData(withDomainType({ ...step.typedData, domain: { ...step.typedData.domain, chainId } }))
        await postJson(`${step.post.url}?signature=${signature}`, { ...step.post.body, signatureChainId: chainId })
        continue
      }
      progress('Confirm the transfer in your wallet…')
      const action = { ...step.action, signatureChainId: `0x${chainId.toString(16)}` }
      const domain = { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' }
      const signature = await signTypedData(withDomainType({ domain, types: step.types, primaryType: step.primaryType, message: action }))
      progress('Sending…')
      const [r, s, v] = [signature.slice(0, 66), `0x${signature.slice(66, 130)}`, parseInt(signature.slice(130, 132), 16)]
      const sent = await postJson<{ status: string; response?: unknown }>(`${step.api}/exchange`, { action, nonce: step.nonce, signature: { r, s, v: v < 27 ? v + 27 : v } })
      if (sent.status !== 'ok') throw new Error(`Hyperliquid refused the transfer: ${typeof sent.response === 'string' ? sent.response : 'try again.'}`)
      progress('Waiting for Hyperliquid…')
      hash = (await hyperliquidHash(step.api, wallet.address!, step.nonce)) ?? step.order
      continue
    }
    if (step.kind === 'cosmos') {
      // The server builds the transaction (and simulates it for the gas), the wallet signs it, the server broadcasts it.
      // From Injective that's on its Cosmos side, where the EVM wallet signs when Keplr isn't connected (see cosmosSigner),
      // or when it's from the EVM wallet's account and not Keplr's (another of the user's accounts, in Onboard).
      const cosmos = chain.kind === 'evm' && chain.cosmos ? chain.cosmos : (chain as CosmosChain)
      if (step.chainId !== cosmos.cosmosId) throw new Error('This route sends from another chain, pick it again.')
      const evmSigns = !!wallet.address && (!cosmosWallet.connected || (step.signer === injectiveAddress(wallet.address) && cosmosWallet.addresses[cosmos.id] !== step.signer))
      if (cosmos !== chain && evmSigns) {
        hash = await sendWithEvmWallet(cosmos, step, progress, last ? 'Confirm the transfer in your wallet…' : 'Confirm in your wallet…')
        if (!last && !(await cosmosConfirmed(cosmos, hash))) throw new Error('The transaction failed.')
        continue
      }
      progress('Preparing the transaction…')
      const key = await cosmosKey(cosmos)
      if (key.address !== step.signer) throw new Error('Your wallet changed accounts: pick the route again.')
      const tx = await prepareCosmosTx({ chain: cosmos.id, signer: step.signer, pubKey: key.pubKey, algo: key.algo, messages: step.messages, memo: step.memo })
      progress(last ? 'Confirm the transfer in your wallet…' : 'Confirm in your wallet…')
      const signed = await signCosmos(cosmos, step.signer, tx)
      progress('Sending…')
      hash = (await broadcastCosmosTx({ chain: cosmos.id, ...signed })).txHash
      if (!last && !(await cosmosConfirmed(cosmos, hash))) throw new Error('The transaction failed.')
      continue
    }
    const evm = chain as EvmChain
    if (step.chainId !== evm.chainId) throw new Error('This route sends from another chain, pick it again.')
    progress(`Switching to ${evm.name}…`)
    await switchChain(evm)
    const padGas = evm.domain === INJECTIVE
    if (step.kind === 'approve') {
      const allowance = BigInt(await call(step.token, encode.allowance(wallet.address!, step.spender)))
      const amount = BigInt(step.amount)
      if (allowance >= amount) continue
      for (const value of allowance > 0n && RESET_FIRST.has(step.token.toLowerCase()) ? [0n, amount] : [amount]) {
        progress('Approve the token in your wallet…')
        const approval = await sendTx(evm, { to: step.token, data: encode.approve(step.spender, value) }, { padGas })
        progress('Approving…')
        if (!(await waitForReceipt(approval, evm))) throw new Error('The approval failed.')
      }
      continue
    }
    progress(last ? 'Confirm the transfer in your wallet…' : 'Confirm in your wallet…')
    hash = await sendTx(evm, { to: step.to, data: step.data as Hex, value: BigInt(step.value), gas: step.gas ? BigInt(step.gas) : undefined }, { padGas })
    // A route with several transactions sends each once the one before it went through.
    if (!last) {
      progress('Waiting for the transaction…')
      if (!(await waitForReceipt(hash as Hex, evm))) throw new Error('The transaction failed.')
    }
  }
  if (!hash) throw new Error('This route has nothing to send.')
  return hash
}

// A transfer through another bridge, into Recent, which follows it to the end. The sides are Injective's Cosmos side where
// the route starts or ends there. Solana's and Hyperliquid's transfers are final once accepted ('pending'); elsewhere
// the transaction still has to confirm ('confirming').
export type Sent = { hash: string; from: Chain; to: Chain; fromSide?: Chain; toSide?: Chain; amount: bigint; fromToken: Token; toToken: Token; quote: Pick<Quote, 'provider' | 'name' | 'via' | 'track' | 'amountOut'>; createdAt?: number }
export function addRouteRecent({ hash, from, to, fromSide, toSide, amount, fromToken, toToken, quote, createdAt = Date.now() }: Sent) {
  const info = ({ address, symbol, decimals, logo }: Token) => ({ address, symbol, decimals, logo })
  return addRecent({
    txHash: hash,
    from: (fromSide ?? from).id,
    to: (toSide ?? to).id,
    sourceDomain: from.domain,
    destinationDomain: to.domain,
    amount: amountString(amount, fromToken.decimals),
    createdAt,
    status: from.kind === 'solana' || from.kind === 'hypercore' ? 'pending' : 'confirming',
    route: { provider: quote.provider, name: quote.name, via: quote.via, track: quote.track, fromToken: info(fromToken), toToken: info(toToken), amountOut: quote.amountOut },
  })
}

// Resolves to whether a Cosmos transaction succeeded, once a block has it (blocks take a few seconds).
export async function cosmosConfirmed(chain: CosmosChain, hash: string, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const { status } = await cosmosTxStatus(chain.id, hash).catch(() => ({ status: 'pending' as const }))
    if (status !== 'pending') return status === 'success'
  }
  throw new Error('The transaction is taking a while to confirm, check your wallet.')
}

// "~6 s", "~20 min", "~1.5 h"
export function duration(seconds: number) {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`
  return `~${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} h`
}

export const usd = (value: number) => (value < 0.01 ? '< $0.01' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
