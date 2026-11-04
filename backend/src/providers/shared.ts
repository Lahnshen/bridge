import type { Hex } from 'viem'
import { sameAddress, tokenFor, type ChainInfo, type Source } from '../chains'
import type { CosmosMessage } from '../cosmos'

// Bridges and solvers besides CCTP, each behind the same small interface (see ./index.ts). Chains come from the registry
// (../chains.ts), which has each provider's own id for them. Amounts are strings of base units.

export type ProviderId = Source

export { NATIVE, SOL } from '../chains'
// The chain's gas token, in the app's terms (its token list's address for it).
export const isNative = (chain: ChainInfo, token: string) => !!chain.native && sameAddress(token, chain.native.address)

export type QuoteRequest = {
  from: ChainInfo
  to: ChainInfo
  fromToken: string // in the app's terms: the chain's token list's address or denom (see tokenFor for a provider's)
  toToken: string
  amount: bigint // of fromToken, in base units
  sender: string // the wallet sending: 0x…, base58 or bech32
  recipient: string // the wallet receiving on the destination chain, in its format
  addresses: { chain: ChainInfo; address: string }[] // the user's other accounts, for chains a route passes through
  slippageBps: number
  preview: boolean // sender or recipient is a placeholder: only the price matters, steps may be left out
}

// Both chains on the provider's list, and a source the app can sign for: EVM chains and Solana, Cosmos chains with Skip,
// and Hyperliquid with Relay.
export const reaches = (id: ProviderId, from: ChainInfo, to: ChainInfo) =>
  from.id !== to.id &&
  from.ids[id] !== undefined &&
  to.ids[id] !== undefined &&
  (from.kind === 'evm' || from.kind === 'solana' || (from.kind === 'cosmos' && id === 'skip') || (from.kind === 'hypercore' && id === 'relay'))

// The provider's own id for the chain and address for a token.
export const idOn = (id: ProviderId, chain: ChainInfo) => chain.ids[id]!
export const tokenOn = (id: ProviderId, chain: ChainInfo, token: string) => tokenFor(chain, id, token)

// What the wallet does, in order. The app skips an approve step when the allowance already covers it.
export type Step =
  | { kind: 'approve'; chainId: number; token: Hex; spender: Hex; amount: string }
  | { kind: 'evm'; chainId: number; to: Hex; data: Hex; value: string; gas?: string }
  | { kind: 'solana'; transaction: string } // base64 serialized transaction (legacy or v0) for the wallet to sign
  | { kind: 'cosmos'; chainId: string; signer: string; messages: CosmosMessage[]; memo?: string } // see ../cosmos.ts
  // EIP-712 typed data the EVM wallet signs, then posted to url with ?signature=. It only authorizes, so the wallet signs
  // at whatever chain it's on: that chain's id goes in the domain's chainId and the body's signatureChainId.
  | { kind: 'signature'; typedData: TypedData; post: { url: string; body: Record<string, unknown> } }
  // A Hyperliquid transfer: the action, signed by the EVM wallet (EIP-712, domain HyperliquidSignTransaction, at its current
  // chain, which the action's signatureChainId repeats), then sent to api's /exchange. order: the bridge's id for the transfer.
  | { kind: 'hyperliquid'; api: string; action: { type: string } & Record<string, unknown>; nonce: number; types: TypedData['types']; primaryType: string; order: string }

export type TypedData = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }

export type Quote = {
  provider: ProviderId
  via?: string // the bridge or solver underneath an aggregator's route, e.g. "Stargate"
  amountOut: string // expected, of toToken
  minAmountOut: string // the least it delivers (after slippage)
  seconds: number // usual time to arrive
  feeUsd?: number // fees taken out of the transfer (already counted in amountOut)
  usdIn?: number // the amount sent in USD, as the bridge prices it
  usdOut?: number // the amount out in USD, likewise
  costUsd?: number // paid by the sender on top: source chain gas and fees charged in the gas token
  costNative?: string // the fees charged in the source chain's gas token (tx value beyond the amount), when there's no USD price
  steps: Step[] // empty for previews
  needs?: string[] // chains the route passes through where it needs one of the user's addresses (registry ids)
  side?: string // for a chain with a Cosmos side (Injective): that side's registry id, when the route starts or ends there
  track: Record<string, string> // what status() needs besides the source tx hash
}

export type TrackRef = { txHash: string; from: ChainInfo; to: ChainInfo; track: Record<string, string> }
export type Progress = {
  status: 'pending' | 'done' | 'failed' | 'refunded'
  destinationTx?: string // on the destination chain, once delivered (or refunded)
  amountOut?: string // what actually arrived, when the provider says
  note?: string
}

export type Provider = {
  id: ProviderId
  name: string
  enabled: boolean // false without a required API key
  supports(from: ChainInfo, to: ChainInfo): boolean // cheap check before quoting
  quote(req: QuoteRequest, signal: AbortSignal): Promise<Quote | undefined> // undefined: no route
  status(ref: TrackRef): Promise<Progress>
}

// A provider's answer that isn't a quote: its own message, kept short.
export class ProviderError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// JSON over HTTP, with the provider's error message on failure. 10 s unless the caller's signal ends sooner.
export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  const headers = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }
  const res = await fetch(url, { ...init, headers, signal })
  const body = await res.json().catch(() => undefined)
  if (!res.ok) {
    const b = body as { message?: string; error?: string | { message?: string }; errorMessage?: string } | undefined
    const message = b?.message ?? (typeof b?.error === 'string' ? b.error : b?.error?.message) ?? b?.errorMessage ?? res.statusText
    throw new ProviderError(res.status, String(message).slice(0, 300))
  }
  return body as T
}

// Hex or decimal to a decimal string (APIs return tx values either way).
export const decimal = (value: string | number | bigint | undefined | null) => (value == null || value === '' ? '0' : BigInt(value).toString())
export const sum = (values: (number | string | undefined)[]) => values.reduce<number>((total, v) => total + (Number(v) || 0), 0)
// A USD value from an API, when it gives a real one.
export const usdValue = (value?: number | string | null) => (Number(value) > 0 ? Number(value) : undefined)

// An ERC-20 approve the app can skip when the allowance already covers it, for the transfer's amount (not the unlimited
// one some APIs ask for). A reset to 0, which USDT needs before a new allowance, stays an ordinary transaction.
export function approval(tx: { chainId: number; to: Hex; data: Hex }, amount: bigint): Step | undefined {
  if (!/^0x095ea7b3[0-9a-f]{128}$/i.test(tx.data) || BigInt(`0x${tx.data.slice(74)}`) === 0n) return
  return { kind: 'approve', chainId: tx.chainId, token: tx.to, spender: `0x${tx.data.slice(34, 74)}`, amount: amount.toString() }
}
