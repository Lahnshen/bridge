import { isAddress } from 'viem'
import { HttpError } from '../cctp'
import { addressOnSide, canSend, chainById, placeholder, resolveChain, sameAccount, validAddress, type ChainInfo } from '../chains'
import { network } from '../config'
import { publicKey } from '../solana'
import { denomOnSide } from '../tokens'
import { across } from './across'
import { debridge } from './debridge'
import { layerzero } from './layerzero'
import { lifi } from './lifi'
import { relay } from './relay'
import { skip } from './skip'
import { usdt0 } from './usdt0'
import { ProviderError, SOL, type Provider, type ProviderId, type Quote, type QuoteRequest, type TrackRef } from './shared'

// Every provider asked at once; the best quote (most delivered) first.

const providers: Provider[] = [lifi, skip, debridge, relay, across, usdt0, layerzero]
export const providerOf = (id: string) => providers.find((p) => p.id === id)
// Mainnet only: the bridges' APIs know mainnet chains, and testnet tokens aren't worth routing.
const active = (p?: Provider) => !!p?.enabled && network === 'mainnet'
export const providerList = () => providers.filter(active).map(({ id, name }) => ({ id, name }))
// The providers that reach a chain (send from it or to it).
export const providersOn = (chain: ChainInfo) => providers.filter((p) => active(p) && chain.ids[p.id] !== undefined).map((p) => p.id)

export type QuoteBody = {
  from: string | number // chain id, or CCTP domain
  to: string | number
  fromToken: string
  toToken: string
  amount: string
  sender?: string
  recipient?: string
  addresses?: Record<string, string> // the user's accounts on other chains, by chain id, for routes passing through them
  slippageBps?: number
  providers?: string[]
}

// A token the way the chain's token list writes it: a 0x address or a mint, else a denom (ibc/…, factory/…), a coin type…
// Injective's list has denoms too, for tokens without an ERC20 twin.
const DENOM = /^[\w\-./:]{1,200}$/
const validToken = (chain: ChainInfo, value: string) =>
  chain.kind === 'evm' ? isAddress(value) || (!!chain.cosmosSide && DENOM.test(value)) : chain.kind === 'solana' ? value === SOL || !!publicKey(value) : DENOM.test(value)

// Without a sender (no wallet connected yet) it's a preview: prices only, with stand-in addresses.
export function quoteRequest(body: QuoteBody): QuoteRequest {
  const { fromToken, toToken } = body
  const [from, to] = [resolveChain(body.from), resolveChain(body.to)]
  // Injective takes its inj1… form too: from here on, its 0x… one.
  const evmForm = (chain: ChainInfo | undefined, address?: string) => (address && chain?.cosmosSide ? addressOnSide(address, chain) : address)
  const [sender, recipient] = [evmForm(from, body.sender), evmForm(to, body.recipient)]
  if (!from || !to || from.id === to.id) throw new HttpError(400, 'Pick two different supported chains.')
  if (!canSend(from)) throw new HttpError(400, `Sending from ${from.name} isn't supported.`)
  if (!validToken(from, fromToken) || !validToken(to, toToken)) throw new HttpError(400, 'Invalid token.')
  if (!/^\d{1,40}$/.test(body.amount) || BigInt(body.amount) === 0n) throw new HttpError(400, 'Invalid amount.')
  if ((sender && !validAddress(from, sender)) || (recipient && !validAddress(to, recipient))) throw new HttpError(400, 'Invalid address.')
  const addresses = Object.entries(body.addresses ?? {}).flatMap(([id, address]) => {
    const chain = resolveChain(id)
    return chain && validAddress(chain, address) ? [{ chain, address }] : []
  })
  // Sending to your own account on the other side needs an address there: the same key's, where it gives one.
  const own = sender && sameAccount(sender, from, to)
  return {
    from,
    to,
    fromToken,
    toToken,
    amount: BigInt(body.amount),
    sender: sender ?? placeholder(from)!,
    recipient: recipient ?? own ?? placeholder(to)!,
    addresses,
    slippageBps: Math.min(Math.max(body.slippageBps ?? 50, 1), 500),
    preview: !sender || (!recipient && !own),
  }
}

// Providers that answered 429 sit out for a minute.
const coolingUntil = new Map<ProviderId, number>()
// Identical requests within a few seconds (typing, several tabs) share one round of quotes.
const recent = new Map<string, { at: number; result: ReturnType<typeof collect> }>()

export function quotes(req: QuoteRequest, only?: ProviderId[]) {
  const { from, to, amount, addresses, ...rest } = req
  const key = JSON.stringify({ ...rest, from: from.id, to: to.id, amount: amount.toString(), addresses: addresses.map((a) => [a.chain.id, a.address]), only })
  for (const [k, v] of recent) if (Date.now() - v.at > 10_000) recent.delete(k)
  const hit = recent.get(key)
  if (hit) return hit.result
  const result = collect(req, only)
  recent.set(key, { at: Date.now(), result })
  return result
}

// Injective is one chain to the user, with an EVM and a Cosmos side (see ONE_CHAIN in ../chains.ts). A transfer to or from
// it is asked on both: on the EVM side with ERC20s and 0x addresses, on the Cosmos side (only Skip reaches it) with bank
// denoms and inj1 addresses. A token with no twin on one side isn't asked there. Into Injective both land in the same
// account, so a bridge's better route is enough; out of it, each side signs with its own wallet, so both stay.
async function collect(req: QuoteRequest, only?: ProviderId[]) {
  const [fromSide, toSide] = [req.from.cosmosSide && chainById(req.from.cosmosSide), req.to.cosmosSide && chainById(req.to.cosmosSide)]
  if (!fromSide && !toSide) return ask(req, only)
  const asks: Promise<Collected>[] = []
  if ((!fromSide || isAddress(req.fromToken)) && (!toSide || isAddress(req.toToken))) asks.push(ask(req, only))
  const [fromToken, toToken] = await Promise.all([
    fromSide ? denomOnSide(req.from, req.fromToken) : req.fromToken,
    toSide ? denomOnSide(req.to, req.toToken) : req.toToken,
  ])
  if (fromToken && toToken) {
    const side = (fromSide || toSide) as ChainInfo
    // The Cosmos wallet's own account where it gave one: it signs on that side, and may hold a different key.
    const sender = fromSide ? (req.addresses.find((a) => a.chain.id === fromSide.id)?.address ?? addressOnSide(req.sender, fromSide)) : req.sender
    const recipient = toSide ? addressOnSide(req.recipient, toSide) : req.recipient
    const cosmos = { ...req, from: fromSide || req.from, to: toSide || req.to, fromToken, toToken, sender, recipient }
    asks.push(ask(cosmos, only).then((r) => ({ ...r, quotes: r.quotes.map((q) => ({ ...q, side: side.id })) })))
  }
  const rounds = await Promise.all(asks)
  let found = rounds.flatMap((r) => r.quotes)
  if (!fromSide) {
    const best = new Map<ProviderId, Collected['quotes'][number]>()
    for (const q of found) if (!best.has(q.provider) || BigInt(q.amountOut) > BigInt(best.get(q.provider)!.amountOut)) best.set(q.provider, q)
    found = [...best.values()]
  }
  found.sort(byAmount)
  // A bridge's error only when it has no route on either side, once.
  const errors = rounds.flatMap((r) => r.errors).filter((e, i, all) => !found.some((q) => q.provider === e.provider) && all.findIndex((o) => o.provider === e.provider) === i)
  return { quotes: found, errors }
}

type Collected = Awaited<ReturnType<typeof ask>>
const byAmount = (a: Quote, b: Quote) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : a.seconds - b.seconds)

async function ask(req: QuoteRequest, only?: ProviderId[]) {
  const asked = providers.filter(
    (p) => active(p) && (!only || only.includes(p.id)) && (coolingUntil.get(p.id) ?? 0) < Date.now() && p.supports(req.from, req.to),
  )
  const results = await Promise.all(
    asked.map(async (p) => {
      try {
        return { quote: await p.quote(req, AbortSignal.timeout(12_000)) }
      } catch (err) {
        if (err instanceof ProviderError && err.status === 429) coolingUntil.set(p.id, Date.now() + 60_000)
        console.warn(`[quote] ${p.id}: ${(err as Error).message}`)
        return { error: { provider: p.id, message: (err as Error).message.slice(0, 200) } }
      }
    }),
  )
  const found = results.flatMap((r) => (r.quote && valid(req, r.quote) ? [{ ...r.quote, name: providerOf(r.quote.provider)!.name }] : []))
  found.sort(byAmount)
  return { quotes: found, errors: results.flatMap((r) => (r.error ? [r.error] : [])) }
}

const isAmount = (value: string) => /^\d+$/.test(value)
// Every transaction has to be on the source chain the user picked, signed by the sender.
const valid = (req: QuoteRequest, q: Quote) =>
  isAmount(q.amountOut) &&
  isAmount(q.minAmountOut) &&
  BigInt(q.amountOut) > 0n &&
  q.steps.every((s) =>
    s.kind === 'solana'
      ? req.from.kind === 'solana'
      : s.kind === 'cosmos'
        ? s.chainId === req.from.cosmosId && s.signer === req.sender
        : s.kind === 'signature' || s.kind === 'hyperliquid'
          ? req.from.kind === 'hypercore'
          : s.chainId === req.from.chainId,
  ) &&
  (req.preview || q.steps.length > 0 || !!q.needs?.length)

export function status(provider: string, ref: { txHash: string; from: string | number; to: string | number; track: TrackRef['track'] }) {
  const p = providerOf(provider)
  const [from, to] = [resolveChain(ref.from), resolveChain(ref.to)]
  if (!p) throw new HttpError(404, 'Unknown provider.')
  if (!from || !to) throw new HttpError(400, 'Unknown chain.')
  return p.status({ ...ref, from, to })
}
