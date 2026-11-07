import { formatUnits, parseEther, parseUnits } from 'viem'
import { fees, HttpError, within, type Fees } from './cctp'
import { addressOnSide, canSend, chainById, ready, sameAccount, sameAddress, SOL, USDT0_MESH, validAddress, type ChainInfo } from './chains'
import { INJECTIVE_DOMAIN, minRedeemAmount, relayer } from './config'
import { scanChains } from './holdings'
import { GAS, gasPrice, reserveOf, STABLE_GAS, txCost, type Tx } from './onboard-gas'
import { nativePrice } from './prices'
import { providerOf, providersOn, quoteRequest, quotes } from './providers'
import type { ProviderId, Quote } from './providers/shared'
import { base58Encode, publicKey, solanaRpc, usdcAccount } from './solana'
import { STABLES, stableOf, type Stable, type StableKind } from './stables'
import { MIN_USDC, swapQuote, swapsEnabled } from './swap'
import { findEntry, gasToken, publicToken, type Token } from './tokens'

// Onboarding: what a wallet holds on other chains, moved into one stablecoin on one chain. GET /onboard lists where to,
// POST /onboard/plan turns a selection of holdings into legs (same-chain swaps, bridge routes, CCTP burns, Get INJ) for the
// app to run in order. Every amount in a plan is an estimate from preview quotes: the app quotes each leg again with the
// real addresses and amounts before the wallet signs it.

// deBridge isn't used for routes: a fixed fee of ~$2.25 per transfer on most chains, and it misprices Injective's USDC (it
// delivered half while reporting 173%). LayerZero has no contract allowlist (./safety.ts refuses its routes). deBridge
// does bring gas from Injective, which Relay and Across don't reach: there its fixed fee is 0.09 INJ (~$0.75, Nov 2026).
const UNUSED = new Set<string>(['debridge', 'layerzero'])
const GAS_FROM_INJECTIVE: ProviderId[] = ['debridge']
// Its cost is about the same whatever the size (the fee and ~$0.30 of spread), so it brings at least this much.
const DEBRIDGE_GAS_USD = 2

// ---- Destinations -----------------------------------------------------------------------------------

export type Destination = { chain: string; tokens: Token[]; gas: { stable: boolean; starterUsd: number; hasGasUsd: number }; receiveOnly: boolean }

// Every chain with a canonical USDC or USDT (./stables.ts: exact addresses, never by symbol) that's in the registry and
// that CCTP or a bridge reaches. Receive-only ones (Tron, Sui) need a pasted recipient and get no gas planning.
let loaded = false
void ready.then(() => (loaded = true))
let table: { at: number; ttl: number; list: Promise<Destination[]> } | undefined
export function destinations(): Promise<Destination[]> {
  if (!table || Date.now() - table.at > table.ttl) {
    // Kept 10 minutes, or 30 seconds while the chain list or a token list is still loading.
    const entry = { at: Date.now(), ttl: loaded ? 600_000 : 30_000, list: Promise.resolve([] as Destination[]) }
    entry.list = buildDestinations(() => (entry.ttl = 30_000))
    table = entry
    entry.list.catch(() => table === entry && (table = undefined))
  }
  return table.list
}

const NAMES: Record<StableKind, string> = { usdc: 'USD Coin', usdt: 'Tether USD' }
async function buildDestinations(partial: () => void): Promise<Destination[]> {
  // Logos and names from the chain's token list, where it answers in time; the address, decimals and symbol are the table's.
  const listed = (chain: ChainInfo, address: string) => Promise.race([findEntry(chain, address).catch(() => undefined), Bun.sleep(5000).then(partial)])
  const ethereum = chainById('ethereum')
  const usual = Promise.all((['usdc', 'usdt'] as const).map((k) => (ethereum ? listed(ethereum, STABLES.ethereum![k]!.address).then((t) => t?.logo) : undefined)))
  const token = async (chain: ChainInfo, kind: StableKind, s: Stable): Promise<Token> => {
    const [t, logos] = await Promise.all([listed(chain, s.address), usual])
    const symbol = kind === 'usdc' ? 'USDC' : s.symbol.endsWith('0') ? 'USDT0' : 'USDT'
    return { chain: chain.id, address: s.address, symbol: t?.symbol ?? symbol, name: t?.name ?? NAMES[kind], decimals: s.decimals, logo: t?.logo ?? logos[kind === 'usdc' ? 0 : 1], priceUsd: 1, verified: true }
  }
  const list = await Promise.all(
    Object.entries(STABLES).map(async ([id, stables]): Promise<Destination[]> => {
      const chain = chainById(id)
      if (!chain || (chain.domain === undefined && !providersOn(chain).some((p) => !UNUSED.has(p)))) return []
      const tokens = await Promise.all((['usdc', 'usdt'] as const).flatMap((k) => (stables[k] ? [token(chain, k, stables[k]!)] : [])))
      const [starterUsd, hasGasUsd] = GAS[id] ?? [0.5, 0.05]
      return [{ chain: id, tokens, gas: { stable: STABLE_GAS.has(id), starterUsd, hasGasUsd }, receiveOnly: !canSend(chain) }]
    }),
  )
  return list.flat()
}

// GET /onboard: the destinations, the chains holdings are read on (POST /holdings), the smallest CCTP transfer to
// Injective this server mints, and the gas-free USDC → INJ swap (see ./swap.ts) with its minimum.
export async function onboardConfig() {
  await Promise.race([ready, Bun.sleep(8000)])
  return {
    destinations: await destinations(),
    scan: scanChains(),
    minRedeemUsdc: formatUnits(minRedeemAmount, 6),
    getInj: { enabled: swapsEnabled, min: (Number(MIN_USDC) / 1e6).toFixed(2) },
  }
}

// ---- Plans ------------------------------------------------------------------------------------------

type Accounts = { evm?: string; solana?: string; cosmos?: Record<string, string> }
type Wallet = 'evm' | 'solana' | 'cosmos'
// What one group of accounts moves (an EVM account and a Solana one, say): its holdings, and its gas tokens' balances.
type Part = { sender: Accounts; items: { chain: string; token: string; amount: string; usd?: number }[]; natives: Record<string, string> }
// others: the user's other accounts in the same wallets, each group planned on its own (see plan). The destination's gas
// is planned for the first group, the recipient's when it's one of them.
export type PlanBody = Part & {
  to: string
  toToken: string
  recipient?: string
  others?: Part[]
  gas?: boolean
  slippageBps?: number
}
// One transaction (or signature) of the plan, amounts in base units. base: the part of amount the selection holds up
// front; the rest comes from the legs in inputs (their output, on this leg's chain, in its fromToken). after: legs to
// finish first. cctp: the burn's options, with Circle's fees as /fees gives them (the app sets maxFee from the real amount).
export type Leg = {
  id: string
  kind: 'swap' | 'bridge' | 'cctp' | 'get-inj'
  purpose: 'consolidate' | 'gas' | 'refuel'
  from: string
  to: string
  fromToken: Token
  toToken: Token
  amount: string
  base: string
  inputs?: string[]
  after?: string[]
  provider: string
  name: string
  via?: string
  side?: string
  wallet: Wallet
  amountOut: string
  minAmountOut: string
  seconds: number
  feeUsd?: number
  costUsd?: number
  usdIn?: number
  usdOut?: number
  topupGasUsd?: number
  feeNative?: string // what it pays in its chain's gas token on top of the amount (deBridge's fixed fee)
  cctp?: { fast: boolean; forward: boolean; fastBps: number | null; forwardFee: string | null; recipientSetup: boolean }
  needs?: string[]
  group?: number // the group of accounts that sends it, by its place in the body (absent: the first)
}
type Reason = 'too-small' | 'no-route' | 'high-loss' | 'illiquid' | 'needs-gas' | 'needs-wallet' | 'unsupported'
type Left = { chain: string; token: Token; amount: string; usd?: number; reason: Reason; detail: string; group?: number }
type GasPlan = { kind: 'none' | 'has-gas' | 'stable' | 'get-inj' | 'topup' | 'leg' | 'unavailable'; usd?: number; detail: string }
export type Plan = {
  legs: Leg[]
  kept: { chain: string; token: Token; amount: string; usd?: number; group?: number }[]
  dropped: Left[]
  summary: { usdIn: number; amountOut: string; minAmountOut: string; feesUsd: number; costUsd: number; seconds: number }
  gas: GasPlan
}

// A holding to move. usd: what it's worth (the client's estimate). native: the chain's gas token. usdc: its CCTP USDC.
// gasUsd: the part of it taken out for gas legs (still moved, as gas).
type Item = { chain: ChainInfo; token: Token; amount: bigint; usd: number; native: boolean; usdc: boolean; gasUsd?: number }
// A way to move an item: a swap (into its chain's USDC for the burn there, or into the target on the destination), a
// swap into the stablecoin its chain's carry moves (see carryOf), a bridge route straight to the target, or one to USDC on
// the hub (Base) for the hub's burn.
type Option = { kind: 'swap' | 'carry' | 'direct' | 'hub'; to: ChainInfo; toToken: Token; providers: ProviderId[]; found: Found[]; errors: string[] }
type Found = Quote & { name: string }
// net: what it's worth after costs; rank: that less the wait (see choose).
type Scored = { option: Option; quote: Found; out: number; net: number; rank: number }
// Where an item goes: into its chain's CCTP burn or carry as it is ('base'), or through its own leg. direct: for a hub or
// carry route, its best route without them, for when the hub can't pay for its burn or the carry is refused.
type Route = { item: Item; kind: 'base' | 'swap' | 'direct' | 'hub'; leg?: Leg; direct?: Leg }
// A CCTP burn to the destination: fast when Circle offers it and the standard wait is long, forwarded by Circle except to
// Injective (this server mints there). plain: to a Solana recipient without a USDC account, the fees without creating it
// (only the first burn there pays for that).
type Burn = { fees: Fees; fast: boolean; forward: boolean; plain?: Fees }
// A chain's carry, where its burn can't take its tokens to the destination: they're swapped into one of its stablecoins
// (token) on its own venues, and one bridge route moves all of it. quote: that route for amount (worth usd); ratio: the
// share of the value it delivers after its costs.
// topup: the destination's gas it brings (Relay's top-up, see carryTopUp).
type Carry = { chain: ChainInfo; token: Token; quote: Found; amount: bigint; usd: number; ratio: number; topup?: number }

type Ctx = {
  to: ChainInfo
  toToken: Token
  dest: Destination
  usdc: boolean // the target is the destination's CCTP USDC
  recipient: string
  own: boolean // the recipient is the user's own account on the destination
  gasWanted: boolean
  accounts: Accounts
  addresses: Record<string, string> // the user's accounts by chain id, for routes through other chains
  natives: Record<string, bigint>
  slippageBps: number
  started: number
  until: number // when to stop asking the bridges: routing's deadline, then the gas steps'
  lifi: { left: number } // LI.FI quotes this plan may still ask for: its anonymous quota is ~75 per 2 hours, shared
  limit: Limit
  relay: Limit // Relay answers bursts with 429 and then sits out a minute for every user, so fewer of its quotes at once
  loading: Map<string, Promise<void>>
  prices: Map<string, number | undefined>
  gasPrices: Map<string, bigint | undefined>
  decimals: Map<string, number> // of the gas token, where it isn't 18 (wei) or 9 (lamports)
  burns: Map<string, Burn | string> // per source chain: its burn to the destination, or why there's none
  carried: Map<string, number> // per source chain: the USD its burn would carry
  setup: boolean // to Solana: the recipient has no USDC account yet
  hub?: { chain: ChainInfo; usdc: Token; burn: Burn; usd: number }
  carries: Map<string, Carry> // per source chain that carries
  gasFrom: Map<string, string> // chain id → the leg bringing gas there; that chain's legs wait for it
  kept: Plan['kept']
  dropped: Left[]
}

// Quotes asked at once (Relay's of them), and how long a plan takes: the bridges answer in 1–12 s each, and the gas steps
// after routing get at least GAS_TIME of it.
const PARALLEL = 4
const RELAY_PARALLEL = 2
const BUDGET = 25_000
const GAS_TIME = 6000
const LIFI_PER_PLAN = 6
const MAX_ITEMS = 300
// Providers per kind of leg. Swaps: Skip (no fee) and Relay; Skip has none on Solana. LI.FI only when these have nothing
// good enough (see fallback).
const SWAP: ProviderId[] = ['skip', 'relay']
const INJECTIVE_SWAP: ProviderId[] = ['skip', 'orderbook'] // on Injective: Skip's venues there, and its orderbook
const DIRECT: ProviderId[] = ['relay', 'across', 'skip', 'usdt0']
const HUB: ProviderId[] = ['relay', 'across']
const REFUEL: ProviderId[] = ['across', 'relay']
// Below these an item costs too much of itself to move: Ethereum's gas makes small amounts there not worth it.
const MIN_USD = 1
const MIN_USD_L1 = 15
const HUB_TOPUP_USD = 0.3 // gas for the burn on the hub when the user has none there (via Relay's top-up)
const REFUEL_USD = 0.5
const REFUEL_USD_L1 = 5
const REFUEL_MAX_USD = 20 // a chain that needs more gas than this for its legs keeps its holdings
const TOPUP_MAX_USD = 5 // the most Relay's top-up brings

// Each group of accounts plans on its own, all at once: its legs send from its accounts, and what it carries through other
// chains stops at its accounts there. They share the bridges' limits and LI.FI's quota, and only the first plans the
// destination's gas. One plan of them all comes back, the others' legs marked with their group.
export async function plan(body: PlanBody): Promise<Plan> {
  // The bridges' chain lists, after a restart (each waits 30 s at most): without them most chains are unknown.
  await ready
  const started = Date.now()
  const parts = [body, ...(body.others ?? [])]
  if (parts.reduce((n, p) => n + p.items.length, 0) > MAX_ITEMS) throw new HttpError(400, `At most ${MAX_ITEMS} holdings at once.`)
  const shared: Shared = { limit: limiter(Math.min(PARALLEL * parts.length, 2 * PARALLEL)), relay: limiter(RELAY_PARALLEL), lifi: { left: LIFI_PER_PLAN } }
  const plans = await Promise.all(parts.map((p, g) => planPart({ ...body, ...p, gas: g === 0 && body.gas }, started, shared)))
  return merge(plans)
}

type Shared = Pick<Ctx, 'limit' | 'relay' | 'lifi'>

async function planPart(body: PlanBody, started: number, shared: Shared): Promise<Plan> {
  const ctx = await context(body, started, shared)
  const items = await itemsOf(ctx, body.items)
  await prepare(ctx, items)
  const routes = await routeItems(ctx, items)
  // The gas steps' own time, however long routing took.
  ctx.until = Math.max(Date.now() + GAS_TIME, started + BUDGET)
  const extra: Leg[] = []
  let gas = await destinationGas(ctx, routes, extra)
  await sourceGas(ctx, routes, extra)
  capNatives(ctx, routes, extra)
  await settleCarries(ctx, routes)
  // The burns and carries last: one whose swaps came out too small drops its chain's items, and their legs with them.
  const { legs: burns, refused } = outlets(ctx, routes)
  // A route with a good one of its own takes that instead.
  for (const { group, detail } of refused)
    for (const r of group) {
      if (r.direct) Object.assign(r, { kind: 'direct', leg: r.direct, direct: undefined })
      else drop(ctx, r.item, 'too-small', detail), routes.splice(routes.indexOf(r), 1)
    }
  let legs = [...itemLegs(routes), ...burns, ...extra]
  // Gas brought to a chain that has nothing left to send isn't needed.
  legs = legs.filter((l) => l.purpose !== 'refuel' || legs.some((o) => o.from === l.to && o !== l))
  for (const [id, leg] of ctx.gasFrom) if (!legs.some((l) => l.id === leg)) ctx.gasFrom.delete(id)
  if ((gas.kind === 'topup' || gas.kind === 'leg') && !ctx.gasFrom.has(ctx.to.id)) gas = unavailable(`The route that was to bring gas to ${ctx.to.name} was left out.`)
  if (gas.kind === 'get-inj') gas = await getInj(ctx, routes, legs)
  const ordered = order(ctx, legs)
  return { legs: ordered, kept: ctx.kept, dropped: ctx.dropped, summary: summary(ctx, routes, ordered), gas }
}

// ---- Validation and context -------------------------------------------------------------------------

// The groups' plans as one: the others' legs (and what they keep or leave) with their group, their ids apart from the
// first's, and the totals of them all.
function merge(plans: Plan[]): Plan {
  if (plans.length === 1) return plans[0]!
  const ids = (g: number, list?: string[]) => list?.map((id) => `${g}/${id}`)
  const legs = plans.flatMap((p, g) => (g ? p.legs.map((l) => ({ ...l, id: `${g}/${l.id}`, after: ids(g, l.after), inputs: ids(g, l.inputs), group: g })) : p.legs))
  const marked = <T>(list: (p: Plan) => T[]) => plans.flatMap((p, g) => list(p).map((x) => (g ? { ...x, group: g } : x)))
  const sum = (key: 'usdIn' | 'feesUsd' | 'costUsd') => round(plans.reduce((s, p) => s + p.summary[key], 0))
  const units = (key: 'amountOut' | 'minAmountOut') => plans.reduce((s, p) => s + BigInt(p.summary[key]), 0n).toString()
  return {
    legs,
    kept: marked((p) => p.kept),
    dropped: marked((p) => p.dropped),
    summary: { usdIn: sum('usdIn'), amountOut: units('amountOut'), minAmountOut: units('minAmountOut'), feesUsd: sum('feesUsd'), costUsd: sum('costUsd'), seconds: Math.max(...plans.map((p) => p.summary.seconds)) },
    gas: plans[0]!.gas,
  }
}

async function context(body: PlanBody, started: number, shared: Shared): Promise<Ctx> {
  const to = chainById(body.to)
  const dest = to && (await destinations()).find((d) => d.chain === to.id)
  if (!to || !dest) throw new HttpError(400, 'Pick one of the destinations.')
  const toToken = dest.tokens.find((t) => sameAddress(t.address, body.toToken))
  if (!toToken) throw new HttpError(400, `Pick ${dest.tokens.map((t) => t.symbol).join(' or ')} on ${to.name}.`)
  const accounts = accountsOf(body.sender)
  const mine = ownAccount(to, accounts)
  const recipient = body.recipient?.trim() || mine
  if (!recipient) throw new HttpError(400, dest.receiveOnly ? `Paste the address on ${to.name} to send to.` : `Connect a wallet that receives on ${to.name}, or paste an address.`)
  if (!validAddress(to, recipient)) throw new HttpError(400, 'Invalid recipient.')
  const addresses: Record<string, string> = { ...accounts.cosmos }
  if (accounts.evm) addresses.ethereum = accounts.evm
  if (accounts.solana) addresses.solana = accounts.solana
  const natives: Record<string, bigint> = {}
  for (const [id, raw] of Object.entries(body.natives ?? {})) if (/^\d{1,78}$/.test(raw)) natives[id] = BigInt(raw)
  return {
    to,
    toToken,
    dest,
    usdc: !!to.usdc && sameAddress(to.usdc, toToken.address),
    recipient,
    own: !!mine && sameOn(to, mine, recipient),
    gasWanted: body.gas !== false,
    accounts,
    addresses,
    natives,
    slippageBps: Math.min(Math.max(Math.round(body.slippageBps ?? 50), 1), 500),
    started,
    until: started + BUDGET - GAS_TIME,
    ...shared,
    loading: new Map(),
    prices: new Map(),
    gasPrices: new Map(),
    decimals: new Map(),
    burns: new Map(),
    carried: new Map(),
    carries: new Map(),
    setup: false,
    gasFrom: new Map(),
    kept: [],
    dropped: [],
  }
}

// Tasks run at most n at a time, the rest in turn: the highest priority first (a holding's value), else in order.
type Limit = <T>(task: () => Promise<T>, priority?: number) => Promise<T>
function limiter(n: number): Limit {
  let active = 0
  const queue: { priority: number; start: () => void }[] = []
  return async (task, priority = 0) => {
    if (active >= n)
      await new Promise<void>((start) => {
        queue.push({ priority, start })
        queue.sort((a, b) => b.priority - a.priority)
      })
    active++
    try {
      return await task()
    } finally {
      active--
      queue.shift()?.start()
    }
  }
}

function accountsOf(sender: Accounts): Accounts {
  const invalid = () => new HttpError(400, 'Invalid address.')
  if (sender.evm !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(sender.evm)) throw invalid()
  const sol = chainById('solana')
  if (sender.solana !== undefined && (!sol || !validAddress(sol, sender.solana))) throw invalid()
  for (const [id, address] of Object.entries(sender.cosmos ?? {})) {
    const chain = chainById(id)
    if (chain?.kind !== 'cosmos' || !validAddress(chain, address)) throw invalid()
  }
  return { evm: sender.evm, solana: sender.solana, cosmos: sender.cosmos ?? {} }
}

// The user's own account on a chain: the EVM wallet's on EVM chains and Hyperliquid (on Injective, else its Keplr
// account's 0x form), the Solana wallet's, or the Keplr account there (or one derived from another of the same key type).
function ownAccount(chain: ChainInfo, a: Accounts): string | undefined {
  if (chain.kind === 'solana') return a.solana
  if (chain.kind === 'evm' || chain.kind === 'hypercore') {
    const keplr = chain.cosmosSide ? a.cosmos?.[chain.cosmosSide] : undefined
    return a.evm ?? (keplr ? addressOnSide(keplr, chain) : undefined)
  }
  if (chain.kind !== 'cosmos') return
  if (a.cosmos?.[chain.id]) return a.cosmos[chain.id]
  for (const [id, address] of Object.entries(a.cosmos ?? {})) {
    const from = chainById(id)
    const same = from && sameAccount(address, from, chain)
    if (same) return same
  }
}
// The same account, in either of Injective's forms.
const sameOn = (chain: ChainInfo, a: string, b: string) => (chain.cosmosSide ? sameAddress(addressOnSide(a, chain), addressOnSide(b, chain)) : sameAddress(a, b))

// Which wallet signs a quote from a chain. On Injective's Cosmos side, Keplr where it's connected, else the EVM wallet,
// which signs there as EIP-712 typed data (see ./cosmos.ts).
const walletOf = (from: ChainInfo, side?: string, ctx?: Ctx): Wallet =>
  from.cosmosSide && side === from.cosmosSide
    ? ctx && !ctx.accounts.cosmos?.[from.cosmosSide] && ctx.accounts.evm
      ? 'evm'
      : 'cosmos'
    : from.kind === 'solana'
      ? 'solana'
      : from.kind === 'cosmos'
        ? 'cosmos'
        : 'evm'
function hasWallet(ctx: Ctx, from: ChainInfo, wallet: Wallet) {
  if (wallet === 'evm') return !!ctx.accounts.evm
  if (wallet === 'solana') return !!ctx.accounts.solana
  return !!ctx.accounts.cosmos?.[from.cosmosSide ?? from.id] || (!!from.cosmosSide && !!ctx.accounts.evm)
}

const lower = (address: string) => (address.startsWith('0x') ? address.toLowerCase() : address)
const drop = (ctx: Ctx, item: Pick<Item, 'chain' | 'token' | 'amount' | 'usd'>, reason: Reason, detail: string) =>
  void ctx.dropped.push({ chain: item.chain.id, token: item.token, amount: item.amount.toString(), usd: round(item.usd), reason, detail })
const round = (usd: number) => Math.round(usd * 1e6) / 1e6
const dollars = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`

// The items as listed tokens with a value, the same token twice summed (in any of its forms, such as Injective's 'inj' and
// its 0x address: they'd be one leg). Unlisted tokens are never planned: that's how airdropped scam tokens stay out.
async function itemsOf(ctx: Ctx, list: PlanBody['items']): Promise<Item[]> {
  const scan = scanChains()
  const scanned = new Set([...scan.evm, ...scan.cosmos, ...(scan.solana ? ['solana'] : []), ...(scan.hyperliquid ? ['hyperliquid'] : [])])
  const parsed = list.map((i) => {
    const chain = chainById(i.chain)
    if (!chain) throw new HttpError(400, `Unknown chain ${i.chain}.`)
    if (!/^\d{1,78}$/.test(i.amount) || BigInt(i.amount) === 0n) throw new HttpError(400, 'Invalid amount.')
    const usd = i.usd !== undefined && Number.isFinite(i.usd) && i.usd >= 0 ? i.usd : undefined
    return { chain, address: i.token, amount: BigInt(i.amount), usd }
  })
  const entries = await Promise.all(parsed.map((m) => (scanned.has(m.chain.id) && canSend(m.chain) ? findEntry(m.chain, m.address).catch(() => undefined) : undefined)))
  const merged = new Map<string, { chain: ChainInfo; token: Token; amount: bigint; usd?: number }>()
  parsed.forEach((m, n) => {
    const entry = entries[n]
    if (!entry) {
      const stub = { chain: m.chain.id, address: m.address, symbol: '?', name: 'Unlisted token', decimals: 0, verified: false }
      return drop(ctx, { ...m, token: stub, usd: m.usd ?? 0 }, 'unsupported', 'Only listed tokens on the scanned networks can be moved.')
    }
    const token = publicToken(entry)
    const key = `${m.chain.id}:${lower(token.address)}`
    const was = merged.get(key)
    if (was) [was.amount, was.usd] = [was.amount + m.amount, was.usd !== undefined && m.usd !== undefined ? was.usd + m.usd : undefined]
    else merged.set(key, { chain: m.chain, token, amount: m.amount, usd: m.usd })
  })
  return [...merged.values()].flatMap(({ chain, token, amount, usd: given }): Item[] => {
    const units = Number(amount) / 10 ** token.decimals
    const usd = given ?? (stableOf(chain.id, token.address) ? units : token.priceUsd ? units * token.priceUsd : undefined)
    if (usd === undefined) {
      drop(ctx, { chain, token, amount, usd: 0 }, 'unsupported', `${token.symbol} has no price, so its value isn't known.`)
      return []
    }
    // Already there: nothing to do for the user's own account. For another recipient there's no leg that sends it as it is.
    if (chain.id === ctx.to.id && sameAddress(token.address, ctx.toToken.address)) {
      if (ctx.own) ctx.kept.push({ chain: chain.id, token, amount: amount.toString(), usd: round(usd) })
      else drop(ctx, { chain, token, amount, usd }, 'unsupported', `It's already on ${chain.name}, in your wallet: send it to the recipient from there.`)
      return []
    }
    const gas = gasToken(chain)
    return [{ chain, token, amount, usd, native: !!gas && sameAddress(gas, token.address), usdc: !!chain.usdc && sameAddress(chain.usdc, token.address) }]
  })
}

// What the plan needs to know up front: the gas token's price and the gas price on every chain involved, and Circle's
// fees from each CCTP chain to the destination.
async function prepare(ctx: Ctx, items: Item[]) {
  const chains = new Map<string, ChainInfo>([[ctx.to.id, ctx.to]])
  for (const i of items) chains.set(i.chain.id, i.chain)
  const base = chainById('base')
  if (base && ctx.usdc) chains.set(base.id, base)
  const setup = ctx.to.kind === 'solana' && ctx.usdc ? hasUsdcAccount(ctx.recipient).then((has) => (ctx.setup = !has)) : undefined
  await Promise.all([...chains.values()].map((c) => load(ctx, c)))
  await setup
  if (!ctx.usdc || ctx.to.domain === undefined) return
  await Promise.all(
    [...chains.values()].map(async (c) => {
      if (c.domain === undefined || c.id === ctx.to.id) return
      const feesFor = (setup: boolean) => within(fees(c.domain!, ctx.to.domain!, setup), 8000).catch(() => undefined)
      const [f, plain] = await Promise.all([feesFor(ctx.setup), ctx.setup ? feesFor(false) : undefined])
      if (f) ctx.burns.set(c.id, { ...burnWith(ctx, f), ...(plain ? { plain } : {}) })
      else ctx.burns.set(c.id, `Circle's fees from ${c.name} couldn't be loaded.`)
    }),
  )
}

function load(ctx: Ctx, chain: ChainInfo): Promise<void> {
  let loading = ctx.loading.get(chain.id)
  if (!loading) {
    const decimals = chain.kind === 'cosmos' && chain.gas ? findEntry(chain, chain.gas.denom).then((t) => t?.decimals).catch(() => undefined) : undefined
    loading = Promise.all([within(nativePrice(chain.id), 6000).catch(() => undefined), chain.kind === 'evm' ? gasPrice(chain) : undefined, decimals]).then(([price, gas, d]) => {
      ctx.prices.set(chain.id, price)
      ctx.gasPrices.set(chain.id, gas)
      if (d !== undefined) ctx.decimals.set(chain.id, d)
    })
    ctx.loading.set(chain.id, loading)
  }
  return loading
}

// Whether a Solana wallet has its USDC account (CCTP mints there; Circle creates it for a higher fee). When Solana doesn't
// answer it's taken as there: the app checks again before the burn.
async function hasUsdcAccount(owner: string) {
  const key = publicKey(owner)
  if (!key) return true
  const answer = await solanaRpc<{ value: unknown }>('getAccountInfo', [base58Encode(usdcAccount(key)), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => undefined)
  return answer?.value !== null
}

// ---- Gas and value helpers ----------------------------------------------------------------------------

// The gas token's base units on the chain: wei, lamports, or the Cosmos fee denom's.
const nativeDecimals = (ctx: Ctx, chain: ChainInfo) => (chain.kind === 'solana' ? 9 : chain.kind === 'cosmos' ? (ctx.decimals.get(chain.id) ?? 6) : chain.kind === 'hypercore' ? 6 : 18)
function usdOf(ctx: Ctx, chain: ChainInfo, units?: bigint) {
  const price = ctx.prices.get(chain.id)
  return units === undefined || price === undefined ? undefined : (Number(units) / 10 ** nativeDecimals(ctx, chain)) * price
}
const costOfTx = (ctx: Ctx, chain: ChainInfo, tx: Tx, erc20: boolean) => txCost(chain, tx, erc20, ctx.gasPrices.get(chain.id))
const isGas = (chain: ChainInfo, token: string) => {
  const gas = gasToken(chain)
  return !!gas && sameAddress(gas, token)
}
// A leg's transaction on its source chain.
const txOf = (leg: Leg): Tx | undefined => (leg.kind === 'swap' ? 'swap' : leg.kind === 'bridge' ? 'bridge' : leg.kind === 'cctp' ? 'cctp' : undefined)

// What a quote costs on top of what it delivers: what the bridge charges besides the amount, and the gas. Relay, LI.FI and
// Across include the source gas in costUsd when they estimate it; for the others it's this plan's estimate.
function costOf(ctx: Ctx, chain: ChainInfo, q: Quote, tx: Tx, erc20: boolean) {
  const gas = usdOf(ctx, chain, costOfTx(ctx, chain, tx, erc20)) ?? 0
  const native = q.costUsd === undefined && q.costNative ? (usdOf(ctx, chain, BigInt(q.costNative)) ?? 0) : 0
  const counted = (q.costUsd ?? 0) > 0 && (q.provider === 'relay' || q.provider === 'lifi' || q.provider === 'across')
  return (q.costUsd ?? 0) + native + (counted ? 0 : gas)
}

function burnWith(ctx: Ctx, f: Fees): Burn {
  // Fast only pays off where a standard transfer is slow (as in the Bridge tab), and to Injective this server mints.
  return { fees: f, fast: f.fastBps !== null && !!f.standardTime, forward: ctx.to.domain !== INJECTIVE_DOMAIN }
}
// Whether a burn from the chain works for this much: this server mints to Injective above its minimum; elsewhere Circle
// delivers it, for at most 1% (5% to Solana, where it's the only way). Ethereum's forwarding fee (up to ~$27) and chains
// Circle doesn't deliver to (Morph, Pharos, Cronos, Plasma, X Layer) get the other bridges' routes instead.
function burnFor(ctx: Ctx, chain: ChainInfo, usd: number): Burn | string {
  const burn = ctx.burns.get(chain.id)
  if (!burn || typeof burn === 'string') return burn ?? 'No CCTP route.'
  if (!burn.forward) {
    if (!relayer) return `This server doesn't mint transfers to ${ctx.to.name}.`
    const least = Number(formatUnits(minRedeemAmount, 6))
    return usd >= least ? burn : `Below ${least} USDC, transfers to ${ctx.to.name} aren't minted for you.`
  }
  const fee = burn.fees.forwardFee === null ? undefined : Number(burn.fees.forwardFee)
  if (fee === undefined) return `Circle doesn't deliver to ${ctx.to.name}.`
  if (fee > (ctx.to.kind === 'solana' ? 0.05 : 0.01) * usd) return `Circle's delivery fee (${fee} USDC) is too much for this amount.`
  return burn
}
// What Circle keeps of a burn (as the app's cctpFees computes it): the fast fee in bps, with headroom unless forwarded
// (then Circle keeps the whole maxFee), and the forwarding fee.
function burnFees(b: Burn, amount: bigint) {
  const fastFee = b.fast && amount ? (amount * BigInt(Math.round(b.fees.fastBps! * 1000)) + 9_999_999n) / 10_000_000n : 0n
  const forwardFee = b.forward ? parseUnits(b.fees.forwardFee!, 6) : 0n
  const maxFee = b.forward ? fastFee + forwardFee : b.fast ? (fastFee * 3n) / 2n + 1n : 0n
  return { fee: b.forward ? maxFee : fastFee, maxFee }
}
// An item's share of its chain's burn fees, for comparing routes.
const burnShare = (b: Burn, out: number, total: number) => (b.fast ? (out * b.fees.fastBps!) / 10_000 : 0) + (b.forward ? (Number(b.fees.forwardFee) * out) / Math.max(total, out) : 0)
function burnSeconds(b: Burn) {
  if (b.fast || !b.fees.standardTime) return 30
  const m = /(\d+)\D*?(min|h)/.exec(b.fees.standardTime)
  return m ? Number(m[1]) * (m[2] === 'h' ? 3600 : 60) : 1200
}

// ---- Quotes -------------------------------------------------------------------------------------------

// gas: a gas leg, which deBridge may quote from Injective.
type Ask = { from: ChainInfo; to: ChainInfo; fromToken: string; toToken: string; amount: bigint; providers: ProviderId[]; topupGasUsd?: number; priority?: number; gas?: boolean }
// Preview quotes (no sender: prices only) from some providers, at most PARALLEL at once (by priority), until the current
// step's time is up (ctx.until). Relay's are asked on their own, RELAY_PARALLEL at once, so the others aren't held back by it.
async function ask(ctx: Ctx, a: Ask): Promise<{ found: Found[]; errors: string[] }> {
  const providers = a.providers.filter((p) => !UNUSED.has(p) || (a.gas && a.from.cosmosSide && GAS_FROM_INJECTIVE.includes(p)))
  const run = async (only: ProviderId[]) => {
    const until = ctx.until
    if (Date.now() > until - 1000) return { found: [], errors: ['Ran out of time asking the bridges, so plan it again after this run.'] }
    const req = quoteRequest({
      from: a.from.id,
      to: a.to.id,
      fromToken: a.fromToken,
      toToken: a.toToken,
      amount: a.amount.toString(),
      addresses: ctx.addresses,
      slippageBps: ctx.slippageBps,
      ...(a.topupGasUsd ? { topupGasUsd: Math.min(Math.max(a.topupGasUsd, 0.1), 5) } : {}),
    })
    const { quotes: found, errors } = await within(quotes(req, only), until - Date.now())
    // Routes signed by a wallet the user hasn't connected are left out, and so are routes through Cosmos chains that need
    // an address there (Skip's Go Fast to Injective needs an Osmosis one) without Keplr to give it.
    const keplr = Object.keys(ctx.accounts.cosmos ?? {}).length > 0
    return {
      found: found.filter((q) => only.includes(q.provider) && hasWallet(ctx, a.from, walletOf(a.from, q.side, ctx)) && (keplr || !q.needs?.length) && (!a.topupGasUsd || !!q.gasTopup)),
      errors: errors.map((e) => `${providerOf(e.provider)?.name ?? e.provider}: ${e.message}`),
    }
  }
  const safe = (task: Promise<{ found: Found[]; errors: string[] }>) =>
    task.catch((err: Error) => ({ found: [], errors: [err.message === 'timeout' ? 'The bridges took too long to answer.' : err.message] }))
  const others = providers.filter((p) => p !== 'relay')
  const parts = await Promise.all([
    ...(others.length ? [safe(ctx.limit(() => run(others), a.priority))] : []),
    ...(others.length < providers.length ? [safe(ctx.relay(() => ctx.limit(() => run(['relay']), a.priority), a.priority))] : []),
  ])
  return { found: parts.flatMap((p) => p.found), errors: [...new Set(parts.flatMap((p) => p.errors))] }
}

// LI.FI when the others have nothing good enough, while this plan's share of its quota lasts. Not for swaps on Injective:
// its only route there is on the EVM side, which has no USDC liquidity (LI.FI refuses it for price impact).
async function fallback(ctx: Ctx, a: Ask) {
  if (ctx.lifi.left <= 0 || Date.now() > ctx.until - 1000 || !providersOn(a.from).includes('lifi') || !providersOn(a.to).includes('lifi') || (a.from.id === a.to.id && a.from.cosmosSide)) return
  ctx.lifi.left--
  return ask(ctx, { ...a, providers: ['lifi'] })
}

// ---- Routing ------------------------------------------------------------------------------------------

async function routeItems(ctx: Ctx, items: Item[]): Promise<Route[]> {
  const D = ctx.to
  // What could go into each chain's burn: its USDC, and what's swapped into it there. Not on Ethereum, where a swap costs
  // ~$1–2 of gas: its other tokens take one-transaction routes. Injective's swaps are on its Cosmos side, and its burn on
  // its EVM side: the EVM wallet signs both (Keplr may sign the swaps).
  const swapsThere = (c: ChainInfo) => c.kind === 'solana' || (c.kind === 'evm' && c.id !== 'ethereum' && (!c.cosmosSide || !!ctx.accounts.evm))
  const feeds = (i: Item) =>
    ctx.usdc && i.chain.domain !== undefined && D.domain !== undefined && i.chain.id !== D.id && (i.usdc ? !i.chain.cosmosSide || !!ctx.accounts.evm : swapsThere(i.chain))
  for (const i of items) if (feeds(i)) ctx.carried.set(i.chain.id, (ctx.carried.get(i.chain.id) ?? 0) + i.usd)
  // The hub, for tokens whose own routes to the destination are poor or missing: USDC on Base through Relay or Across,
  // then Base's burn (with Base's own USDC). For Ethereum's tokens besides USDC, and chains without CCTP.
  const base = chainById('base')
  const hubbed = (i: Item) =>
    !!base &&
    ctx.usdc &&
    !!ctx.accounts.evm &&
    D.domain !== undefined &&
    ![D.id, 'base'].includes(i.chain.id) &&
    ((i.chain.id === 'ethereum' && !i.usdc) || (i.chain.domain === undefined && (i.chain.kind === 'evm' || i.chain.kind === 'hypercore')))
  const hubUsd = items.filter(hubbed).reduce((sum, i) => sum + i.usd, 0)
  if (base && hubUsd) {
    const usd = (ctx.carried.get('base') ?? 0) + hubUsd
    const burn = burnFor(ctx, base, usd)
    const usdc = await tokenOn(base, base.usdc!)
    if (typeof burn !== 'string' && usdc && !tooCostly(ctx, base, burn, usd)) ctx.hub = { chain: base, usdc, burn, usd }
  }
  // A burn that costs over 5% of what it carries isn't worth it: those tokens take their own routes.
  for (const [id, usd] of ctx.carried) {
    const chain = chainById(id)!
    const total = id === ctx.hub?.chain.id ? ctx.hub.usd : usd
    const burn = burnFor(ctx, chain, total)
    ctx.burns.set(id, typeof burn !== 'string' && tooCostly(ctx, chain, burn, total) ? 'Too little to burn.' : burn)
  }
  const burnOn = (c: ChainInfo) => {
    const b = ctx.burns.get(c.id)
    return b && typeof b !== 'string' ? b : undefined
  }

  // Chains whose burn can't take their tokens to the destination (none to it, Circle's delivery fee too high, a USDT
  // target), but whose venues can swap them: into one of the chain's stablecoins, which one route then carries on whole
  // (see carryOf), instead of each token's own route (Skip's from Injective lose half on USDT). Not the hub's chains.
  const carrying = (c: ChainInfo) => c.id !== D.id && swapsThere(c) && !burnOn(c) && !!STABLES[c.id] && !(ctx.hub && c.domain === undefined)
  const carried = new Map<string, Item[]>()

  const planned: { item: Item; options: Option[] }[] = []
  const routes: Route[] = []
  const option = (kind: Option['kind'], to: ChainInfo, toToken: Token, providers: ProviderId[]): Option => ({ kind, to, toToken, providers, found: [], errors: [] })
  const directOf = (S: ChainInfo) => option('direct', D, ctx.toToken, S.kind === 'cosmos' || S.cosmosSide ? ['skip'] : S.kind === 'hypercore' ? ['relay'] : DIRECT)
  const swappingOn = (S: ChainInfo): ProviderId[] => (S.kind === 'solana' ? ['relay'] : S.cosmosSide ? INJECTIVE_SWAP : S.kind === 'cosmos' ? ['skip'] : SWAP)
  for (const i of items) {
    const S = i.chain
    const wallet = S.kind === 'solana' ? 'solana' : S.kind === 'cosmos' ? 'cosmos' : 'evm'
    if (!S.cosmosSide && !hasWallet(ctx, S, wallet)) {
      drop(ctx, i, 'needs-wallet', `Connect ${wallet === 'solana' ? 'a Solana wallet' : wallet === 'cosmos' ? 'Keplr' : 'an EVM wallet'} to move it.`)
      continue
    }
    const direct = directOf(S)
    const swapping = swappingOn(S)
    let options: Option[]
    if (S.cosmosSide && !i.usdc && !ctx.accounts.cosmos?.[S.cosmosSide] && !ctx.accounts.evm) {
      drop(ctx, i, 'needs-wallet', `Connect a wallet to swap it on ${S.name}.`)
      continue
    }
    if (S.cosmosSide && i.usdc && !ctx.accounts.evm && !ctx.accounts.cosmos?.[S.cosmosSide]) {
      drop(ctx, i, 'needs-wallet', `Connect a wallet to move it from ${S.name}.`)
      continue
    }
    const usdc = feeds(i) && burnOn(S) ? await tokenOn(S, S.usdc!) : undefined
    // Skip's swaps and Injective's orderbook pay the wallet that swaps: for another recipient, only Relay's (and LI.FI's).
    const paying = ctx.own ? swapping : swapping.filter((p) => p === 'relay')
    if (S.id === D.id && !paying.length && (S.cosmosSide || !providersOn(S).includes('lifi'))) {
      drop(ctx, i, 'unsupported', `Swaps on ${S.name} pay your own wallet: swap it there, then send it to the recipient.`)
      continue
    }
    if (S.id === D.id) options = [option('swap', D, ctx.toToken, paying)]
    else if (usdc) {
      if (i.usdc) {
        routes.push({ item: i, kind: 'base' })
        continue
      }
      // Into the chain's USDC for its burn; a big holding also asks for a direct route, which wins when clearly better.
      options = [option('swap', S, usdc, swapping), ...(i.usd >= 50 ? [direct] : [])]
    } else if (carrying(S)) {
      // Planned once the chain's carry is known.
      carried.set(S.id, [...(carried.get(S.id) ?? []), i])
      continue
    } else options = [direct, ...(ctx.hub && hubbed(i) ? [option('hub', ctx.hub.chain, ctx.hub.usdc, S.kind === 'hypercore' ? ['relay' as const] : HUB)] : [])]
    // On Solana a swap's cost allows for making the token account it pays into, which on the destination the plan makes
    // anyway.
    let small = tooSmall(ctx, i, options[0]!.kind === 'swap' && !(S.id === D.id && S.kind === 'solana') ? 'swap' : 'bridge')
    // Too small for a swap and then its chain's burn, but not for one route of its own: that alone.
    if (small && options[0]!.kind === 'swap' && S.id !== D.id && !tooSmall(ctx, i, 'bridge')) [small, options] = [undefined, [direct]]
    if (small) drop(ctx, i, 'too-small', small)
    else planned.push({ item: i, options })
  }

  // Every option's quotes, then LI.FI where none of them is good enough (no route, or one losing too much), the biggest
  // holdings first (what's left when time runs out is the smallest). The gas steps after this keep GAS_TIME.
  const fill = async (i: Item, o: Option, lifi = false) => {
    const asked = { from: i.chain, to: o.to, fromToken: i.token.address, toToken: o.toToken.address, amount: i.amount, providers: o.providers, priority: i.usd }
    const r = lifi ? await fallback(ctx, asked) : await ask(ctx, asked)
    if (r) [o.found, o.errors] = [[...o.found, ...r.found], [...o.errors, ...r.errors]]
  }
  planned.sort((a, b) => b.item.usd - a.item.usd)
  const asked = planned.flatMap((p) => p.options.map((o) => fill(p.item, o)))
  // Meanwhile each carrying chain's carry, and its tokens' swaps into the likeliest stablecoin for it (again once it's
  // another), with a big holding's direct route too (every holding's, when the carry takes over 5 minutes). The stablecoin
  // itself goes as it is; without a carry they take their direct routes. Its stablecoins aren't too small for gas: they
  // add no transaction of their own.
  type Asked = { o: Option; filled: Promise<void> }
  const carries = [...carried].map(async ([id, list]) => {
    const S = chainById(id)!
    const asking = (i: Item, o: Option): Asked => ({ o, filled: fill(i, o) })
    // One too small for a swap into the carry may still take a route of its own (one transaction).
    const alone: Asked[] = []
    const keep = list
      .sort((a, b) => b.usd - a.usd)
      .filter((i) => {
        const small = stableOf(S.id, i.token.address) ? undefined : tooSmall(ctx, i, 'swap')
        if (!small) return true
        if (tooSmall(ctx, i, 'bridge')) drop(ctx, i, 'too-small', small)
        else {
          const direct = asking(i, directOf(S))
          planned.push({ item: i, options: [direct.o] })
          alone.push(direct)
        }
        return false
      })
    const tokens = await carriers(ctx, S)
    const swapsInto = (token?: Token) => new Map(token ? keep.filter((i) => !sameAddress(i.token.address, token.address)).map((i) => [i, asking(i, option('carry', S, token, swappingOn(S)))]) : [])
    let swaps = swapsInto(tokens[0])
    const directs = new Map(keep.filter((i) => i.usd >= 50).map((i) => [i, asking(i, directOf(S))]))
    const carry = await carryOf(ctx, S, keep.reduce((sum, i) => sum + i.usd, 0), tokens)
    if (carry) ctx.carries.set(id, carry)
    if (carry && carry.token !== tokens[0]) swaps = swapsInto(carry.token)
    const mine: Asked[] = [...alone]
    for (const i of keep) {
      if (carry && sameAddress(i.token.address, carry.token.address)) {
        routes.push({ item: i, kind: 'base' })
        continue
      }
      const swap = carry ? swaps.get(i) : undefined
      const direct = directs.get(i) ?? (!carry || carry.quote.seconds > 300 ? asking(i, directOf(S)) : undefined)
      const asked = [swap, direct].filter((a): a is Asked => !!a)
      planned.push({ item: i, options: asked.map((a) => a.o) })
      mine.push(...asked)
    }
    await Promise.all(mine.map((a) => a.filled))
  })
  await Promise.all([...asked, ...carries])
  // A carried token with no good swap into its carry gets its direct route asked too.
  const poor = planned.filter((p) => 'reason' in choose(ctx, p.item, p.options)).sort((a, b) => b.item.usd - a.item.usd)
  const late = poor.flatMap((p) => {
    if (p.item.chain.id === D.id || p.options.some((o) => o.kind === 'direct')) return []
    const direct = directOf(p.item.chain)
    p.options.push(direct)
    return [fill(p.item, direct)]
  })
  await Promise.all([...poor.map((p) => fill(p.item, p.options[0]!, true)), ...late])

  for (const { item, options } of planned) {
    const chosen = choose(ctx, item, options)
    if ('reason' in chosen) {
      drop(ctx, item, chosen.reason, chosen.detail)
      continue
    }
    const { option, quote, out } = chosen
    const kind = option.kind === 'swap' || option.kind === 'carry' ? 'swap' : option.kind === 'hub' ? 'hub' : 'direct'
    const direct = option.kind === 'hub' || option.kind === 'carry' ? choose(ctx, item, options.filter((o) => o !== option)) : undefined
    routes.push({ item, kind, leg: legOf(ctx, item, option, quote, out), ...(direct && !('reason' in direct) ? { direct: legOf(ctx, item, direct.option, direct.quote, direct.out) } : {}) })
  }
  return routes
}

// A token of the chain's list, by its exact address.
const tokenOn = (chain: ChainInfo, address: string) => findEntry(chain, address).then((t) => t && publicToken(t), () => undefined)

// Gas for its own transactions over 5% of an item's value, or under $1 ($15 on Ethereum): not worth moving.
function tooSmall(ctx: Ctx, i: Item, tx: 'swap' | 'bridge') {
  const least = i.chain.id === 'ethereum' ? MIN_USD_L1 : MIN_USD
  if (i.usd < least) return `Worth under ${dollars(least)}: moving it would cost too much of it.`
  const gas = usdOf(ctx, i.chain, costOfTx(ctx, i.chain, tx, !i.native))
  if (gas !== undefined && gas > 0.05 * i.usd) return `Gas on ${i.chain.name} (~${dollars(gas)}) would take over 5% of it.`
}
// The stablecoins a chain could carry in, likeliest first: USDC, which every bridge moves, unless the target is USDT0 and
// the chain is on its mesh (USDT0 moves it 1:1).
async function carriers(ctx: Ctx, chain: ChainInfo) {
  const mesh = stableOf(ctx.to.id, ctx.toToken.address) === 'usdt' && !!chain.chainId && !!USDT0_MESH[chain.chainId] && !!ctx.to.chainId && !!USDT0_MESH[ctx.to.chainId]
  const stables = (mesh ? (['usdt', 'usdc'] as const) : (['usdc', 'usdt'] as const)).flatMap((k) => STABLES[chain.id]?.[k] ?? [])
  return (await Promise.all(stables.map((s) => tokenOn(chain, s.address)))).filter((t): t is Token => !!t)
}

// A carrying chain's carry: each of its stablecoins asked for one route of the chain's whole value to the target, ahead
// of the holdings' own quotes; the one delivering the most after costs and waiting, if that's at least 97% of it. LI.FI's
// when the others have none that good, a stablecoin at a time (Injective's USDT goes for 44% where its USDC gets 99.5%).
async function carryOf(ctx: Ctx, chain: ChainInfo, usd: number, tokens: Token[]): Promise<Carry | undefined> {
  if (usd < MIN_USD || !tokens.length) return
  const asks = tokens.map((token) => ({ from: chain, to: ctx.to, fromToken: token.address, toToken: ctx.toToken.address, amount: parseUnits(usd.toFixed(6), token.decimals), providers: DIRECT, priority: Infinity, token }))
  const scored = (a: (typeof asks)[number], found: Found[]) =>
    found.map((quote) => {
      const net = Number(quote.amountOut) / 10 ** ctx.toToken.decimals - costOf(ctx, chain, quote, 'bridge', true)
      return { chain, token: a.token, quote, amount: a.amount, usd, ratio: net / usd, rank: net - usd * 0.0001 * (quote.seconds / 60) }
    })
  const pick = (list: ReturnType<typeof scored>) => list.filter((c) => c.ratio >= 0.97).sort((a, b) => b.rank - a.rank)[0]
  let best = pick((await Promise.all(asks.map(async (a) => scored(a, (await ask(ctx, a)).found)))).flat())
  for (const a of asks) if (!best) best = pick(scored(a, (await fallback(ctx, a))?.found ?? []))
  if (!best) return
  const { rank, ...carry } = best
  return carry
}

// A burn whose gas and fees take over 5% of what it carries.
function tooCostly(ctx: Ctx, chain: ChainInfo, burn: Burn, usd: number) {
  const gas = usdOf(ctx, chain, costOfTx(ctx, chain, 'cctp', true)) ?? 0
  return gas + burnShare(burn, usd, usd) > 0.05 * usd
}

// The best quote of each option by net value: what it delivers, at $1 for the stablecoin (never the bridge's own USD
// figure: deBridge reported 173% while delivering 52%), less what it costs on top and its share of a burn's fees (or of
// what the carry loses). Like
// the Bridge tab's ranking, 0.01% of the value less per minute of waiting (with the burn's), so a route a few cents
// better but twenty minutes slower doesn't win. Routes that deliver under 80% of the value look illiquid, and under 95%
// after costs lose too much. Of the rest, the first option (swap into the burn, or the direct route) unless another beats
// it by more than max($0.10, 0.2%).
function choose(ctx: Ctx, i: Item, options: Option[]): Scored | { reason: Reason; detail: string } {
  const scored = options.flatMap((option) => {
    const burn = option.kind === 'hub' ? ctx.hub?.burn : option.kind === 'swap' && option.to.id !== ctx.to.id ? (ctx.burns.get(i.chain.id) as Burn) : undefined
    const total = option.kind === 'hub' ? (ctx.hub?.usd ?? 0) : (ctx.carried.get(i.chain.id) ?? 0)
    const carry = option.kind === 'carry' ? ctx.carries.get(i.chain.id) : undefined
    const best = option.found
      .map((quote): Scored => {
        const out = Number(quote.amountOut) / 10 ** option.toToken.decimals
        const cost = costOf(ctx, i.chain, quote, option.kind === 'direct' || option.kind === 'hub' ? 'bridge' : 'swap', !i.native)
        const net = out - cost - (burn ? burnShare(burn, out, total) : carry ? out * (1 - carry.ratio) : 0)
        const wait = quote.seconds + (burn ? burnSeconds(burn) : carry ? carry.quote.seconds : 0)
        return { option, quote, out, net, rank: net - i.usd * 0.0001 * (wait / 60) }
      })
      .sort((a, b) => b.rank - a.rank)[0]
    return best ? [best] : []
  })
  const ok = scored.filter((s) => s.out >= 0.8 * i.usd && s.net >= 0.95 * i.usd)
  if (!ok.length) {
    const best = scored.sort((a, b) => b.net - a.net)[0]
    const errors = [...new Set(options.flatMap((o) => o.errors))]
    if (!best) return { reason: 'no-route', detail: errors.length ? `No route: ${errors.slice(0, 2).join('; ')}` : 'No bridge has a route for it.' }
    const share = (value: number) => `${Math.max(0, Math.round((value / i.usd) * 100))}%`
    if (best.out < 0.8 * i.usd) return { reason: 'illiquid', detail: `The best route (${best.quote.name}) returns ${share(best.out)} of its value: it may not sell for its price.` }
    return { reason: 'high-loss', detail: `The best route (${best.quote.name}) would lose ${share(i.usd - best.net)} to fees and gas.` }
  }
  const primary = ok.find((s) => s.option === options[0])
  const other = ok.filter((s) => s !== primary).sort((a, b) => b.rank - a.rank)[0]
  return primary && !(other && other.rank > primary.rank + Math.max(0.1, 0.002 * i.usd)) ? primary : (other ?? primary)!
}

function legOf(ctx: Ctx, i: Item, o: Option, q: Found, out: number): Leg {
  const swap = o.kind === 'swap' || o.kind === 'carry'
  const prefix = swap ? 'swap' : o.kind === 'hub' ? 'hub' : 'bridge'
  return {
    id: `${prefix}:${i.chain.id}:${lower(i.token.address)}`,
    kind: swap ? 'swap' : 'bridge',
    purpose: 'consolidate',
    from: i.chain.id,
    to: o.to.id,
    fromToken: i.token,
    toToken: o.toToken,
    amount: i.amount.toString(),
    base: i.amount.toString(),
    provider: q.provider,
    name: q.name,
    via: q.via,
    side: q.side,
    wallet: walletOf(i.chain, q.side, ctx),
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    seconds: Math.max(q.seconds, 10),
    feeUsd: q.feeUsd === undefined ? undefined : round(q.feeUsd),
    costUsd: round(costOf(ctx, i.chain, q, swap ? 'swap' : 'bridge', !i.native)),
    usdIn: round(i.usd),
    usdOut: round(out),
    needs: q.needs,
  }
}

// A leg sending less than planned: its outputs shrink in proportion.
function shrink(leg: Leg, amount: bigint) {
  const was = BigInt(leg.amount)
  if (!was || amount >= was) return
  const part = (value: string) => ((BigInt(value) * amount) / was).toString()
  const ratio = Number(amount) / Number(was)
  Object.assign(leg, {
    amount: amount.toString(),
    base: amount.toString(),
    amountOut: part(leg.amountOut),
    minAmountOut: part(leg.minAmountOut),
    usdIn: leg.usdIn === undefined ? undefined : round(leg.usdIn * ratio),
    usdOut: leg.usdOut === undefined ? undefined : round(leg.usdOut * ratio),
  })
}
// An item moving less than planned: kept back as a reserve, or taken out for gas (forGas: it's still spent).
function take(route: Route, amount: bigint, forGas = false) {
  const i = route.item
  if (amount >= i.amount) return
  const usd = i.amount ? (i.usd * Number(amount)) / Number(i.amount) : 0
  if (forGas) i.gasUsd = (i.gasUsd ?? 0) + i.usd - usd
  i.usd = usd
  i.amount = amount
  if (route.leg) shrink(route.leg, amount)
}

// ---- Legs -----------------------------------------------------------------------------------------------

const itemLegs = (routes: Route[]) => routes.flatMap((r) => (r.leg ? [r.leg] : []))

// The chain whose burn an item's route feeds, if any: its USDC as it is, its swap into USDC there, or the hub's. A carrying
// chain's go into its carry instead.
function burnChain(ctx: Ctx, r: Route) {
  if (carryOn(ctx, r)) return
  if (r.kind === 'base') return r.item.chain
  if (r.kind === 'swap' && r.leg!.to !== ctx.to.id) return r.item.chain
  if (r.kind === 'hub') return ctx.hub!.chain
}

// One CCTP burn per chain, of its USDC and what its swaps (or, on the hub, the hub routes) add, and the chains whose burn
// would be refused, with their routes (plan drops them). To a Solana recipient without a USDC account the biggest burn
// pays Circle for creating it; the others wait for it to land, so they don't pay for it too.
function burnLegs(ctx: Ctx, routes: Route[]): { legs: Leg[]; refused: { group: Route[]; detail: string }[] } {
  const groups = new Map<string, { chain: ChainInfo; routes: Route[] }>()
  for (const r of routes) {
    const chain = burnChain(ctx, r)
    if (!chain) continue
    const g = groups.get(chain.id) ?? { chain, routes: [] }
    g.routes.push(r)
    groups.set(chain.id, g)
  }
  const planned: { chain: ChainInfo; group: Route[]; burn: Burn; base: bigint; inputs: Leg[]; amount: bigint; least: bigint; usd: number }[] = []
  const refused: { group: Route[]; detail: string }[] = []
  for (const { chain, routes: group } of groups.values()) {
    const burn = chain.id === ctx.hub?.chain.id ? ctx.hub.burn : (ctx.burns.get(chain.id) as Burn)
    const base = group.filter((r) => r.kind === 'base').reduce((sum, r) => sum + r.item.amount, 0n)
    const inputs = group.flatMap((r) => (r.leg ? [r.leg] : []))
    const amount = base + inputs.reduce((sum, l) => sum + BigInt(l.amountOut), 0n)
    const least = base + inputs.reduce((sum, l) => sum + BigInt(l.minAmountOut), 0n)
    const usd = Number(amount) / 1e6
    // The burn's minimum and costs, now that the swaps' outputs are known.
    const refusal = burnFor(ctx, chain, usd)
    if (typeof refusal === 'string' || tooCostly(ctx, chain, burn, usd)) {
      refused.push({ group, detail: typeof refusal === 'string' ? refusal : `Moving ${dollars(usd)} from ${chain.name} with CCTP costs over 5% of it.` })
      continue
    }
    planned.push({ chain, group, burn, base, inputs, amount, least, usd })
  }
  const first = ctx.setup ? planned.reduce<(typeof planned)[number] | undefined>((a, b) => (!a || b.amount > a.amount ? b : a), undefined) : undefined
  const legs = planned.map(({ chain, group, burn, base, inputs, amount, least, usd }): Leg => {
    const waits = !!first && first.chain !== chain && !!burn.plain
    const fees = waits ? burn.plain! : burn.fees
    const { fee, maxFee } = burnFees({ ...burn, fees }, amount)
    const after = [...inputs.map((l) => l.id), ...(waits ? [`cctp:${first.chain.id}`] : [])]
    // The chain's USDC: what its swaps and hub routes deliver, or the holding itself.
    const fromToken = inputs[0]?.toToken ?? group[0]!.item.token
    return {
      id: `cctp:${chain.id}`,
      kind: 'cctp',
      purpose: 'consolidate',
      from: chain.id,
      to: ctx.to.id,
      fromToken,
      toToken: ctx.toToken,
      amount: amount.toString(),
      base: base.toString(),
      ...(inputs.length ? { inputs: inputs.map((l) => l.id) } : {}),
      ...(after.length ? { after } : {}),
      provider: 'cctp',
      name: 'Circle CCTP',
      wallet: chain.kind === 'solana' ? 'solana' : 'evm',
      amountOut: (amount > fee ? amount - fee : 0n).toString(),
      minAmountOut: (least > maxFee ? least - maxFee : 0n).toString(),
      seconds: burnSeconds(burn),
      feeUsd: round(Number(fee) / 1e6),
      costUsd: round(usdOf(ctx, chain, costOfTx(ctx, chain, 'cctp', true)) ?? 0),
      usdIn: round(usd),
      usdOut: round(Number(amount - fee) / 1e6),
      cctp: { fast: burn.fast, forward: burn.forward, fastBps: fees.fastBps, forwardFee: fees.forwardFee, recipientSetup: ctx.setup && !waits },
    }
  })
  return { legs, refused }
}

// The carry an item's route feeds, if any: its stablecoin as it is, or its swap into it.
function carryOn(ctx: Ctx, r: Route) {
  const carry = ctx.carries.get(r.item.chain.id)
  if (carry && (r.kind === 'base' || (r.kind === 'swap' && r.leg!.to !== ctx.to.id))) return carry
}

// One bridge leg per carrying chain, of what it held of the stablecoin and what its swaps bring, its route's amounts in
// proportion to the amount quoted; refused (plan drops its routes) when it would lose over 5% after costs, now that the
// swaps' outputs are known.
function carryLegs(ctx: Ctx, routes: Route[]): { legs: Leg[]; refused: { group: Route[]; detail: string }[] } {
  const legs: Leg[] = []
  const refused: { group: Route[]; detail: string }[] = []
  for (const [carry, { group, base, inputs, amount, least }] of carryGroups(ctx, routes)) {
    const { chain, token, quote: q } = carry
    const part = (value: string, of: bigint) => ((BigInt(value) * of) / carry.amount).toString()
    const [usd, out] = [Number(amount) / 10 ** token.decimals, Number(part(q.amountOut, amount)) / 10 ** ctx.toToken.decimals]
    const cost = costOf(ctx, chain, q, 'bridge', true)
    // The gas a top-up brings comes out of the amount: it isn't lost.
    if (out + (carry.topup ?? 0) - cost < 0.95 * usd) {
      refused.push({ group, detail: `Moving ${dollars(usd)} of ${token.symbol} from ${chain.name} with ${q.name} would lose over 5% of it.` })
      continue
    }
    const ids = inputs.map((l) => l.id)
    legs.push({
      id: `carry:${chain.id}`,
      kind: 'bridge',
      purpose: 'consolidate',
      from: chain.id,
      to: ctx.to.id,
      fromToken: token,
      toToken: ctx.toToken,
      amount: amount.toString(),
      base: base.toString(),
      ...(ids.length ? { inputs: ids, after: ids } : {}),
      provider: q.provider,
      name: q.name,
      via: q.via,
      side: q.side,
      wallet: walletOf(chain, q.side, ctx),
      amountOut: part(q.amountOut, amount),
      minAmountOut: part(q.minAmountOut, least),
      ...(carry.topup ? { topupGasUsd: carry.topup } : {}),
      seconds: Math.max(q.seconds, 10),
      feeUsd: q.feeUsd === undefined ? undefined : round((q.feeUsd * usd) / carry.usd),
      costUsd: round(cost),
      usdIn: round(usd),
      usdOut: round(out),
      needs: q.needs,
    })
  }
  return { legs, refused }
}

// Each carry's routes: what it held of the stablecoin (base), the swaps into it (inputs), and what they add up to.
function carryGroups(ctx: Ctx, routes: Route[]) {
  const groups = new Map<Carry, { group: Route[]; base: bigint; inputs: Leg[]; amount: bigint; least: bigint }>()
  for (const r of routes) {
    const carry = carryOn(ctx, r)
    if (!carry) continue
    const g = groups.get(carry) ?? { group: [], base: 0n, inputs: [], amount: 0n, least: 0n }
    g.group.push(r)
    if (r.kind === 'base') [g.base, g.amount, g.least] = [g.base + r.item.amount, g.amount + r.item.amount, g.least + r.item.amount]
    else if (r.leg) g.inputs.push(r.leg), (g.amount += BigInt(r.leg.amountOut)), (g.least += BigInt(r.leg.minAmountOut))
    groups.set(carry, g)
  }
  return groups
}

// A carry that now moves far from what it was quoted for (holdings left out or cut back since) is asked again for it, by
// its own bridge, so a fixed fee doesn't hide in the proportion. LI.FI's only while this plan's share of its quota lasts.
async function settleCarries(ctx: Ctx, routes: Route[]) {
  const tasks = [...carryGroups(ctx, routes)].map(async ([carry, { amount }]) => {
    if (!amount || (amount * 4n >= carry.amount * 3n && amount * 4n <= carry.amount * 5n)) return
    const provider = carry.quote.provider
    if (provider === 'lifi' && ctx.lifi.left-- <= 0) return
    const a = { from: carry.chain, to: ctx.to, fromToken: carry.token.address, toToken: ctx.toToken.address, amount, providers: [provider], ...(carry.topup ? { topupGasUsd: carry.topup } : {}) }
    const q = (await ask(ctx, a)).found.find((f) => f.provider === provider && f.side === carry.quote.side)
    if (q) Object.assign(carry, { quote: q, amount, usd: Number(amount) / 10 ** carry.token.decimals })
  })
  await Promise.all(tasks)
}

// The legs that take each chain's USDC (or stablecoin) on: burns and carries.
function outlets(ctx: Ctx, routes: Route[]) {
  const [burns, carries] = [burnLegs(ctx, routes), carryLegs(ctx, routes)]
  return { legs: [...burns.legs, ...carries.legs], refused: [...burns.refused, ...carries.refused] }
}

// ---- Gas ---------------------------------------------------------------------------------------------

// The gas token a chain has for the plan's transactions: its balance less what refuels and gas legs take from it, and
// the fixed fees they pay in it. Moving
// the gas token itself keeps a reserve (see capNatives), so that doesn't count here.
function nativeLeft(ctx: Ctx, chain: ChainInfo, extra: Leg[]) {
  const spent = extra.filter((l) => l.from === chain.id).reduce((sum, l) => sum + (isGas(chain, l.fromToken.address) ? BigInt(l.amount) : 0n) + BigInt(l.feeNative ?? 0), 0n)
  const left = (ctx.natives[chain.id] ?? 0n) - spent
  return left > 0n ? left : 0n
}
// The gas the plan's transactions on a chain need, in its gas token's base units (undefined when the gas price isn't known).
function gasNeed(ctx: Ctx, chain: ChainInfo, legs: Leg[]) {
  let need = 0n
  for (const leg of legs) {
    const tx = leg.from === chain.id ? txOf(leg) : undefined
    if (!tx) continue
    const cost = costOfTx(ctx, chain, tx, !isGas(chain, leg.fromToken.address))
    if (cost === undefined) return
    need += cost
  }
  return need
}
// Whether a chain can pay for a few more transactions as it is.
function funded(ctx: Ctx, chain: ChainInfo, legs: Leg[]) {
  if (STABLE_GAS.has(chain.id) || chain.kind === 'hypercore') return true
  const need = gasNeed(ctx, chain, legs)
  const tx = costOfTx(ctx, chain, 'bridge', true)
  const left = ctx.natives[chain.id] ?? 0n
  return need === undefined || tx === undefined ? left > 0n : left >= need + 2n * tx
}

// Gas on the destination, when asked for and the user's own account there has too little (natives are the sender's
// balances; another recipient's isn't known, so it gets none): Get INJ on Injective (planned once the legs are known, see
// getInj); on EVM chains Relay's top-up on a Relay route landing there, else a small route of a stablecoin (or a gas
// token) to the gas token there; on Solana the same, to SOL. Elsewhere it isn't planned.
async function destinationGas(ctx: Ctx, routes: Route[], extra: Leg[]): Promise<GasPlan> {
  const D = ctx.to
  const symbol = D.native?.symbol ?? 'gas'
  if (ctx.dest.receiveOnly) return { kind: 'none', detail: '' }
  if (!ctx.own) return { kind: 'none', detail: "Gas isn't added for another recipient." }
  if (ctx.dest.gas.stable) return { kind: 'stable', detail: D.kind === 'hypercore' ? `${D.name} needs no gas.` : `Gas on ${D.name} is paid in ${ctx.dest.tokens[0]?.symbol ?? 'its stablecoin'}.` }
  if (!ctx.gasWanted) return { kind: 'none', detail: '' }
  const { starterUsd, hasGasUsd } = ctx.dest.gas
  const left = nativeLeft(ctx, D, extra)
  const price = ctx.prices.get(D.id)
  if (price ? (Number(left) / 10 ** nativeDecimals(ctx, D)) * price >= hasGasUsd : left > 0n) return { kind: 'has-gas', detail: `You have ${symbol} for gas on ${D.name}.` }
  if (D.domain === INJECTIVE_DOMAIN) return { kind: 'get-inj', usd: starterUsd, detail: '' }
  if (D.kind !== 'evm' && D.kind !== 'solana') return unavailable(`Get some ${symbol} on ${D.name} for gas yourself.`)
  // Relay's top-up adds the gas token to a route it fills there (EVM chains only).
  const landing = D.kind === 'evm' ? relayInto(routes, D) : undefined
  if (landing && (await topUp(ctx, landing, starterUsd))) {
    ctx.gasFrom.set(D.id, landing.id)
    return { kind: 'topup', usd: starterUsd, detail: `~${dollars(starterUsd)} of ${symbol} comes with the ${landing.name} transfer.` }
  }
  const carry = await carryTopUp(ctx, D, starterUsd)
  if (carry) {
    ctx.gasFrom.set(D.id, `carry:${carry.chain.id}`)
    return { kind: 'topup', usd: starterUsd, detail: `~${dollars(starterUsd)} of ${symbol} comes with the ${carry.quote.name} transfer from ${carry.chain.name}.` }
  }
  // Ethereum's stablecoins last: a transaction there costs about what this gas is worth.
  const leg =
    (await gasFromStable(ctx, routes, extra, D, starterUsd, false)) ?? (await gasFromNative(ctx, routes, extra, D, starterUsd, 'gas')) ?? (await gasFromStable(ctx, routes, extra, D, starterUsd, true))
  if (!leg) return unavailable(`No route found to get ${symbol} on ${D.name}.`)
  extra.push(leg)
  ctx.gasFrom.set(D.id, leg.id)
  const usd = leg.usdIn || starterUsd
  return { kind: 'leg', usd, detail: `~${dollars(usd)} of ${leg.fromToken.symbol} on ${chainById(leg.from)?.name} goes to ${symbol} on ${D.name}.` }
}
const unavailable = (detail: string): GasPlan => ({ kind: 'unavailable', detail })

// The biggest route landing on a chain with something besides its gas token, Relay's first: Relay can top it up with
// gas. Relay reaches EVM chains from EVM chains, Solana and Hyperliquid.
const RELAY_TOPUP_FROM = new Set(['evm', 'solana', 'hypercore'])
function relayInto(routes: Route[], chain: ChainInfo) {
  if (chain.kind !== 'evm') return
  return routes
    .flatMap((r) => (r.leg && r.leg.kind === 'bridge' && r.leg.to === chain.id && !isGas(chain, r.leg.toToken.address) && !r.leg.topupGasUsd && RELAY_TOPUP_FROM.has(r.item.chain.kind) ? [r.leg] : []))
    .sort((a, b) => Number(b.provider === 'relay') - Number(a.provider === 'relay') || (b.usdOut ?? 0) - (a.usdOut ?? 0))[0]
}

// The route asked again from Relay with its gas top-up, which comes out of the amount. Another bridge's route moves to
// Relay when that costs little more than the gas it brings: one transaction fewer than a separate gas route.
async function topUp(ctx: Ctx, leg: Leg, usd: number) {
  const [from, to] = [chainById(leg.from)!, chainById(leg.to)!]
  const topup = Math.min(Math.max(usd, 0.1), 5)
  const { found } = await ask(ctx, { from, to, fromToken: leg.fromToken.address, toToken: leg.toToken.address, amount: BigInt(leg.amount), providers: ['relay'], topupGasUsd: topup })
  const q = found[0]
  if (!q) return false
  const [was, out] = [Number(leg.amountOut), Number(q.amountOut)].map((v) => v / 10 ** leg.toToken.decimals) as [number, number]
  if (leg.provider !== 'relay' && out + topup < was - Math.max(0.1, 0.003 * was)) return false
  Object.assign(leg, {
    provider: q.provider,
    name: q.name,
    via: q.via,
    side: q.side,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    seconds: Math.max(q.seconds, 10),
    feeUsd: q.feeUsd === undefined ? undefined : round(q.feeUsd),
    costUsd: round(costOf(ctx, from, q, 'bridge', !isGas(from, leg.fromToken.address))),
    usdOut: round(out),
    needs: q.needs,
    topupGasUsd: topup,
  })
  return true
}

// A carry into the destination asked again from Relay with its gas top-up, as topUp does for a route: the biggest one Relay
// carries, else the biggest from a chain Relay reaches.
async function carryTopUp(ctx: Ctx, chain: ChainInfo, usd: number) {
  if (chain.kind !== 'evm' || chain.id !== ctx.to.id) return
  const carry = [...ctx.carries.values()]
    .filter((c) => !c.topup && RELAY_TOPUP_FROM.has(c.chain.kind))
    .sort((a, b) => Number(b.quote.provider === 'relay') - Number(a.quote.provider === 'relay') || b.usd - a.usd)[0]
  if (!carry) return
  const topup = Math.min(Math.max(usd, 0.1), 5)
  const { found } = await ask(ctx, { from: carry.chain, to: chain, fromToken: carry.token.address, toToken: ctx.toToken.address, amount: carry.amount, providers: ['relay'], topupGasUsd: topup })
  const q = found[0]
  if (!q) return
  const [was, out] = [carry.quote.amountOut, q.amountOut].map((v) => Number(v) / 10 ** ctx.toToken.decimals) as [number, number]
  if (carry.quote.provider !== 'relay' && out + topup < was - Math.max(0.1, 0.003 * was)) return
  return Object.assign(carry, { quote: q, topup })
}

const best = (found: Found[]) => found.sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : 0))[0]

// The bridges for a gas leg: deBridge from Injective, Relay to Solana, else Across first between EVM chains.
const gasProviders = (from: ChainInfo, to: ChainInfo): ProviderId[] => (from.cosmosSide ? GAS_FROM_INJECTIVE : to.kind === 'solana' ? ['relay'] : REFUEL)
// Whether a chain's gas token pays a gas leg's fixed fee on top (deBridge's), besides what the leg sends of it (spend) and
// the chain's reserve.
function affords(ctx: Ctx, chain: ChainInfo, extra: Leg[], legs: Leg[], spend: bigint, q: Found) {
  const fee = BigInt(q.costNative ?? 0)
  if (!fee) return true
  const need = (gasNeed(ctx, chain, legs) ?? 0n) + (costOfTx(ctx, chain, 'bridge', !spend) ?? 0n)
  return nativeLeft(ctx, chain, extra) >= spend + fee + reserveOf(chain, 18, ctx.prices.get(chain.id), need)
}

// Gas taken out of a stablecoin the plan moves on another EVM chain that has gas (Ethereum's only when l1): a small
// route of it to the gas token there (see gasProviders; LI.FI when they have none).
async function gasFromStable(ctx: Ctx, routes: Route[], extra: Leg[], to: ChainInfo, usd: number, l1: boolean): Promise<Leg | undefined> {
  const legs = draft(ctx, routes, extra)
  const candidates = routes
    .filter((r) => {
      const c = r.item.chain
      return c.kind === 'evm' && c.id !== to.id && (c.id === 'ethereum') === l1 && !!stableOf(c.id, r.item.token.address) && r.item.usd >= 3 * usd && funded(ctx, c, legs)
    })
    .sort((a, b) => b.item.usd - a.item.usd)
    .slice(0, 2)
  if (!candidates.length) return
  const gas = to.kind === 'solana' ? SOL : gasToken(to)
  const toToken = gas && (await tokenOn(to, gas))
  if (!toToken) return
  for (const r of candidates) {
    const i = r.item
    const want = i.chain.cosmosSide ? Math.max(usd, DEBRIDGE_GAS_USD) : usd
    const amount = BigInt(Math.round(want * 1e6)) * 10n ** BigInt(Math.max(i.token.decimals - 6, 0))
    const a = { from: i.chain, to, fromToken: i.token.address, toToken: toToken.address, amount, providers: gasProviders(i.chain, to), gas: true }
    const answer = await ask(ctx, a)
    const q = best(answer.found) ?? best((await fallback(ctx, a))?.found ?? [])
    if (!q || !affords(ctx, i.chain, extra, legs, 0n, q)) continue
    take(r, i.amount - amount, true)
    return gasLeg(ctx, `gas:${to.id}`, 'gas', i.chain, to, i.token, toToken, amount, q)
  }
}

// Gas from the chain where the user has the most of a gas token (at least $3; Injective, then Ethereum, last), native to
// native: Across, else Relay (deBridge from Injective). For a chain's own transactions (a refuel), or the destination's gas. What the
// source chain keeps for its own transactions stays untouched (its gas token moving is cut back to leave it, see capNatives).
async function gasFromNative(ctx: Ctx, routes: Route[], extra: Leg[], to: ChainInfo, usd: number, purpose: 'gas' | 'refuel'): Promise<Leg | undefined> {
  const candidates = Object.keys(ctx.natives).flatMap((id) => {
    const c = chainById(id)
    return id !== to.id && ctx.natives[id]! > 0n && c?.kind === 'evm' && !STABLE_GAS.has(c.id) && hasWallet(ctx, c, 'evm') ? [c] : []
  })
  await Promise.all(candidates.map((c) => load(ctx, c)))
  const legs = draft(ctx, routes, extra)
  const richest = candidates
    .map((c) => ({ c, usd: usdOf(ctx, c, ctx.natives[c.id]) ?? 0 }))
    .filter((x) => x.usd >= 3 && !ctx.gasFrom.has(x.c.id))
    .sort((a, b) => dearer(a.c) - dearer(b.c) || b.usd - a.usd)
  const gas = to.kind === 'solana' ? SOL : gasToken(to)
  const toToken = gas && (await tokenOn(to, gas))
  if (!toToken) return
  for (const { c } of richest.slice(0, 2)) {
    const price = ctx.prices.get(c.id)!
    const want = c.cosmosSide ? Math.max(usd, DEBRIDGE_GAS_USD) : usd
    const amount = BigInt(Math.ceil((want / price) * 1e9)) * 10n ** 9n
    const fromToken = await tokenOn(c, gasToken(c)!)
    const need = (gasNeed(ctx, c, legs) ?? 0n) + (costOfTx(ctx, c, 'bridge', false) ?? 0n)
    if (!fromToken || nativeLeft(ctx, c, extra) < amount + reserveOf(c, 18, price, need)) continue
    const a = { from: c, to, fromToken: fromToken.address, toToken: toToken.address, amount, providers: gasProviders(c, to), gas: true }
    const q = best((await ask(ctx, a)).found)
    if (q && affords(ctx, c, extra, legs, amount, q)) return gasLeg(ctx, `${purpose}:${to.id}`, purpose, c, to, fromToken, toToken, amount, q)
  }
}

// Gas sources that cost more: Injective's deBridge fee, Ethereum's own gas.
const dearer = (c: ChainInfo) => (c.id === 'ethereum' ? 2 : c.cosmosSide ? 1 : 0)

function gasLeg(ctx: Ctx, id: string, purpose: 'gas' | 'refuel', from: ChainInfo, to: ChainInfo, fromToken: Token, toToken: Token, amount: bigint, q: Found): Leg {
  const native = isGas(from, fromToken.address)
  const usdIn = native ? (usdOf(ctx, from, amount) ?? 0) : Number(amount) / 10 ** fromToken.decimals
  return {
    id,
    kind: 'bridge',
    purpose,
    from: from.id,
    to: to.id,
    fromToken,
    toToken,
    amount: amount.toString(),
    base: amount.toString(),
    provider: q.provider,
    name: q.name,
    via: q.via,
    wallet: 'evm',
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    seconds: Math.max(q.seconds, 10),
    feeUsd: q.feeUsd === undefined ? undefined : round(q.feeUsd),
    costUsd: round(costOf(ctx, from, q, 'bridge', !native)),
    usdIn: round(usdIn),
    usdOut: round(usdOf(ctx, to, BigInt(q.amountOut)) ?? 0),
    ...(BigInt(q.costNative ?? 0) > 0n && { feeNative: q.costNative }),
  }
}

// Gas for the transactions on each source chain. A chain short of it gets Relay's top-up on a route landing there (the
// hub, or the destination when that's the user's own account), else a refuel from the user's best-funded chain, sized to
// what it lacks; Injective gets INJ with Get INJ, from USDC there. Otherwise its holdings stay ('needs-gas'). Its legs wait
// for the gas to arrive. One chain at a time, so two refuels don't count on the same balance.
async function sourceGas(ctx: Ctx, routes: Route[], extra: Leg[]) {
  const legs = draft(ctx, routes, extra)
  const short = [...new Set(legs.map((l) => l.from))].flatMap((id) => {
    const chain = chainById(id)!
    // A chain whose balance the client couldn't read is taken as able to pay: its wallet says so if it can't.
    if (STABLE_GAS.has(id) || chain.kind === 'hypercore' || ctx.gasFrom.has(id) || ctx.natives[id] === undefined) return []
    const need = gasNeed(ctx, chain, legs)
    const left = nativeLeft(ctx, chain, extra)
    return (need === undefined ? left === 0n : left < need) ? [{ chain, missing: need === undefined ? 0n : need - left }] : []
  })
  for (const { chain, missing } of short) {
    const symbol = chain.native?.symbol ?? 'gas'
    if (chain.kind === 'cosmos') {
      strand(ctx, routes, extra, chain, `No ${symbol} on ${chain.name} for gas.`)
      continue
    }
    if (chain.cosmosSide) {
      const leg = await injGas(ctx, routes, 'refuel')
      if (leg) extra.push(leg), ctx.gasFrom.set(chain.id, leg.id)
      else strand(ctx, routes, extra, chain, `No INJ on ${chain.name} for gas: get some with Get INJ (Swap tab) first.`)
      continue
    }
    // Relay's top-up on a route into the hub or the user's own account on the destination (one to another recipient brings
    // the gas to them), which this chain's legs then wait for. What it lacks, with a fifth more for gas prices moving.
    const own = chain.id === ctx.to.id && ctx.own
    const lacks = (usdOf(ctx, chain, missing) ?? 0) * 1.2
    const landing = chain.id === ctx.hub?.chain.id || own ? relayInto(routes, chain) : undefined
    const topup = Math.max(HUB_TOPUP_USD, own ? ctx.dest.gas.starterUsd : 0, lacks)
    if (landing && topup <= TOPUP_MAX_USD && (await topUp(ctx, landing, topup))) {
      ctx.gasFrom.set(chain.id, landing.id)
      continue
    }
    const carry = own && topup <= TOPUP_MAX_USD ? await carryTopUp(ctx, chain, topup) : undefined
    if (carry) {
      ctx.gasFrom.set(chain.id, `carry:${carry.chain.id}`)
      continue
    }
    const usd = Math.max(chain.id === 'ethereum' ? REFUEL_USD_L1 : REFUEL_USD, own && ctx.gasWanted ? ctx.dest.gas.starterUsd : 0, lacks)
    if (usd > REFUEL_MAX_USD) {
      strand(ctx, routes, extra, chain, `Its legs need ~${dollars(lacks)} of ${symbol} for gas on ${chain.name}, more than a refuel brings.`)
      continue
    }
    const leg = await gasFromNative(ctx, routes, extra, chain, usd, 'refuel')
    if (leg) extra.push(leg), ctx.gasFrom.set(chain.id, leg.id)
    else strand(ctx, routes, extra, chain, `No ${symbol} on ${chain.name} for gas, and no route to bring some.`)
  }
}
// The legs as they'd be now, for the gas estimates: the burns and carries are built for real at the end, which may refuse
// some.
function draft(ctx: Ctx, routes: Route[], extra: Leg[]) {
  const { legs, refused } = outlets(ctx, routes)
  const out = new Set(refused.flatMap((g) => g.group))
  return [...itemLegs(routes.filter((r) => !out.has(r))), ...legs, ...extra]
}

// A chain's holdings that can't move for lack of gas, with the hub routes waiting on its burn (unless they have a good
// enough route of their own) and any gas leg from it.
function strand(ctx: Ctx, routes: Route[], extra: Leg[], chain: ChainInfo, detail: string) {
  for (const r of [...routes]) {
    const here = r.item.chain.id === chain.id
    if (!here && !(r.kind === 'hub' && ctx.hub?.chain.id === chain.id)) continue
    if (!here && r.direct) {
      shrink(r.direct, r.item.amount)
      Object.assign(r, { kind: 'direct', leg: r.direct, direct: undefined })
      continue
    }
    drop(ctx, r.item, 'needs-gas', here ? detail : `Its route goes through ${chain.name}: ${detail}`)
    routes.splice(routes.indexOf(r), 1)
  }
  for (const leg of [...extra]) if (leg.from === chain.id) extra.splice(extra.indexOf(leg), 1)
}

// Get INJ: some of the USDC on Injective swapped to INJ, gas free (the wallet signs a message, see ./swap.ts). As the
// destination's gas, once the transfers there have arrived; as gas for Injective's own transactions (a refuel), from USDC
// already there (kept, or about to be burned). Only for the EVM wallet that signs it, and only with USDC to spare.
async function injGas(ctx: Ctx, routes: Route[], purpose: 'gas' | 'refuel', arriving = 0n): Promise<Leg | undefined> {
  const injective = chainById('injective')
  const [usdc, inj] = injective?.usdc ? await Promise.all([tokenOn(injective, injective.usdc), tokenOn(injective, gasToken(injective)!)]) : []
  if (!swapsEnabled || !ctx.accounts.evm || !injective || !usdc || !inj) return
  const amount = purpose === 'gas' ? BigInt(Math.max(Number(MIN_USDC), Math.round(ctx.dest.gas.starterUsd * 1e6))) : MIN_USDC
  const here = ctx.kept.filter((k) => k.chain === injective.id && sameAddress(k.token.address, injective.usdc!)).reduce((sum, k) => sum + BigInt(k.amount), 0n)
  if (purpose === 'refuel') {
    const own = routes.find((r) => r.kind === 'base' && r.item.chain.id === injective.id && sameAddress(r.item.token.address, usdc.address))
    if (here < amount && !(own && own.item.amount >= 3n * amount)) return
    if (here < amount) take(own!, own!.item.amount - amount, true)
  } else if (here + arriving < 3_000_000n) return
  const leg: Leg = {
    id: purpose === 'refuel' ? 'refuel:injective' : 'get-inj',
    kind: 'get-inj',
    purpose,
    from: injective.id,
    to: injective.id,
    fromToken: usdc,
    toToken: inj,
    amount: amount.toString(),
    base: amount.toString(),
    provider: 'get-inj',
    name: 'Get INJ',
    wallet: 'evm',
    amountOut: '0',
    minAmountOut: '0',
    seconds: 15,
    feeUsd: 0,
    costUsd: 0,
    usdIn: round(Number(amount) / 1e6),
  }
  // What the orderbook gives for it now.
  const q = await within(swapQuote(formatUnits(amount, 6)), 5000).catch(() => undefined)
  if (q) Object.assign(leg, { amountOut: parseEther(q.inj).toString(), minAmountOut: parseEther(q.minInj).toString(), usdOut: leg.usdIn })
  return leg
}
const injDetail = (leg: Leg) => {
  const inj = BigInt(leg.amountOut) ? `~${formatUnits(BigInt(leg.amountOut), 18)} INJ` : 'INJ'
  return `${inj} for gas from ${formatUnits(BigInt(leg.amount), 6)} USDC, gas free.`
}

// The destination's Get INJ, now that what arrives on Injective is known: after every leg landing there. A refuel of
// Injective already got INJ from USDC there, which covers it.
async function getInj(ctx: Ctx, routes: Route[], legs: Leg[]): Promise<GasPlan> {
  const refuel = legs.find((l) => l.id === 'refuel:injective')
  if (refuel) return { kind: 'get-inj', usd: Number(refuel.amount) / 1e6, detail: injDetail(refuel) }
  if (!ctx.usdc) return unavailable('Get INJ swaps USDC: pick USDC to get gas too.')
  if (!swapsEnabled) return unavailable('Get INJ is off on this server.')
  if (!ctx.accounts.evm) return unavailable('Get INJ buys gas for the EVM wallet that signs it: connect one.')
  const landing = legs.filter((l) => l.to === ctx.to.id && l.purpose === 'consolidate' && sameAddress(l.toToken.address, ctx.toToken.address))
  const leg = await injGas(ctx, routes, 'gas', landing.reduce((sum, l) => sum + BigInt(l.amountOut), 0n))
  if (!leg) return unavailable('Too little USDC arrives on Injective to swap some for gas.')
  const after = legs.filter((l) => l.to === ctx.to.id).map((l) => l.id)
  if (after.length) leg.after = after
  legs.push(leg)
  return { kind: 'get-inj', usd: Number(leg.amount) / 1e6, detail: injDetail(leg) }
}

// Gas tokens that move keep a reserve on their chain: the floor (see ./onboard-gas.ts) or twice the plan's gas there,
// besides what refuels and gas legs take from it; on the destination, when it's the user's own account, at least what
// counts as having gas. An item left with nothing is dropped.
function capNatives(ctx: Ctx, routes: Route[], extra: Leg[]) {
  const legs = draft(ctx, routes, extra)
  for (const r of [...routes]) {
    const { chain, native, token } = r.item
    // Without the chain's balance, the client's amount is taken as already leaving its reserve.
    if (!native || chain.kind === 'hypercore' || ctx.natives[chain.id] === undefined) continue
    const others = routes.filter((o) => o !== r && o.item.chain.id === chain.id && o.item.native).reduce((sum, o) => sum + o.item.amount, 0n)
    const price = ctx.prices.get(chain.id)
    let reserve = reserveOf(chain, token.decimals, price, gasNeed(ctx, chain, legs))
    if (chain.id === ctx.to.id && ctx.own && ctx.gasWanted && price && !ctx.dest.gas.stable) {
      const enough = BigInt(Math.ceil((ctx.dest.gas.hasGasUsd / price) * 10 ** Math.min(token.decimals, 15))) * 10n ** BigInt(Math.max(token.decimals - 15, 0))
      if (enough > reserve) reserve = enough
    }
    const cap = nativeLeft(ctx, chain, extra) - reserve - others
    if (cap >= r.item.amount) continue
    if (cap <= 0n) {
      drop(ctx, r.item, 'needs-gas', `It's kept for gas on ${chain.name}.`)
      routes.splice(routes.indexOf(r), 1)
    } else take(r, cap)
  }
}

// ---- Order and summary ------------------------------------------------------------------------------

// Each leg after the gas its chain waits for, then in an order a person can follow: refuels first, then chain by chain its
// swaps, bridge routes and burn, then the destination's gas. Every leg comes after the ones it waits for.
function order(ctx: Ctx, legs: Leg[]): Leg[] {
  for (const leg of legs) {
    const gas = ctx.gasFrom.get(leg.from)
    const own = legs.filter((l) => l.from === leg.from && l.kind === 'bridge' && l.purpose === 'gas' && leg.kind === 'cctp' && sameAddress(l.fromToken.address, leg.fromToken.address))
    const waits = [...(leg.after ?? []), ...(gas && gas !== leg.id && leg.kind !== 'get-inj' ? [gas] : []), ...own.map((l) => l.id)]
    if (waits.length) leg.after = [...new Set(waits)].filter((id) => legs.some((l) => l.id === id))
    if (!leg.after?.length) delete leg.after
  }
  const chains = [...new Set(legs.map((l) => l.from))]
  const rank = (l: Leg) =>
    l.purpose === 'refuel' ? 0 : l.kind === 'get-inj' ? 9 : l.purpose === 'gas' ? 8 : 1 + chains.indexOf(l.from) / chains.length + (l.kind === 'swap' ? 0 : l.kind === 'bridge' ? 0.001 : 0.002)
  const pending = [...legs].sort((a, b) => rank(a) - rank(b))
  const out: Leg[] = []
  while (pending.length) {
    const i = pending.findIndex((l) => (l.after ?? []).every((id) => out.some((o) => o.id === id)))
    if (i < 0) throw new Error('The plan has a dependency cycle.')
    out.push(...pending.splice(i, 1))
  }
  return out
}

// Totals in the target's base units: what the legs landing on the destination deliver, less what Get INJ swaps for gas.
// seconds: the longest chain of legs, each waiting for the ones before it.
function summary(ctx: Ctx, routes: Route[], legs: Leg[]): Plan['summary'] {
  const landing = legs.filter((l) => l.to === ctx.to.id && l.purpose === 'consolidate' && sameAddress(l.toToken.address, ctx.toToken.address))
  const inj = legs.filter((l) => l.kind === 'get-inj' && ctx.to.domain === INJECTIVE_DOMAIN && ctx.usdc).reduce((sum, l) => sum + BigInt(l.amount), 0n)
  const total = (key: 'amountOut' | 'minAmountOut') => {
    const sum = landing.reduce((s, l) => s + BigInt(l[key]), 0n) - inj
    return (sum > 0n ? sum : 0n).toString()
  }
  const done = new Map<string, number>()
  const finish = (l: Leg): number => {
    if (!done.has(l.id)) done.set(l.id, l.seconds + Math.max(0, ...(l.after ?? []).map((id) => finish(legs.find((o) => o.id === id)!))))
    return done.get(l.id)!
  }
  return {
    usdIn: round(routes.reduce((sum, r) => sum + r.item.usd + (r.item.gasUsd ?? 0), 0)),
    amountOut: total('amountOut'),
    minAmountOut: total('minAmountOut'),
    feesUsd: round(Math.max(0, legs.reduce((sum, l) => sum + (l.feeUsd ?? 0), 0))),
    costUsd: round(legs.reduce((sum, l) => sum + (l.costUsd ?? 0), 0)),
    seconds: Math.max(0, ...legs.map(finish)),
  }
}
