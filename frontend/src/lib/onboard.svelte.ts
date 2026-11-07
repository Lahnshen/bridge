import { injectiveAddress, parseAddress, walletKind } from './address'
import {
  ApiError,
  cosmosTxStatus,
  getFees,
  getHoldings,
  getOnboard,
  getQuotes,
  getRouteStatus,
  getTxTransfers,
  INJECTIVE,
  isNative,
  planOnboard,
  rpc,
  sameAddress as same,
  solanaRpc,
  tokenBalance,
  type Accounts,
  type CctpChain,
  type Chain,
  type ChainHoldings,
  type CosmosChain,
  type EvmChain,
  type Hex,
  type Holding,
  type Leg,
  type OnboardConfig,
  type Plan,
  type PlanBody,
  type PlanPart,
  type Quote,
  type QuoteBody,
  type Step,
  type Token,
} from './api'
import { app, chainById, injective } from './app.svelte'
import { atomicSupport, BatchUnavailable, batchResult, batchStatus, sendCalls, Unsure, type Atomic, type Call } from './batch'
import { burnCall, burnOnEvm, cctpFees, tokenMessengerOf } from './cctp'
import { addressFromWallet, connectCosmosWallet, cosmosWallet, derivedAddress } from './cosmos-wallet.svelte'
import { amountString, encode, formatToken, formatUsdc, forwardHook, parseUsdc, short, type Burn } from './evm'
import { getInj } from './get-inj'
import { addressesFor, addressOn, addRouteRecent, cosmosSigner, RESET_FIRST, runSteps, sideOf } from './routes'
import { accountExists, burnOnSolana, publicKey, solanaKeyHex, solanaMintRecipient, usdcAccount } from './solana'
import { chooseSolanaAccount, connectSolanaWallet, signSolanaTransaction, solanaIsOn, solanaWallet, solanaWalletOf } from './solana-wallet.svelte'
import { acceptTerms } from './terms.svelte'
import { addRecent, failRecent, recent, refresh, sentRecent, type Recent } from './transfers.svelte'
import { call, chooseAccount, connectWallet, isOn, sleep, switchChain, wallet, walletError, walletOf, type WalletInfo } from './wallet.svelte'

export { addressOn } from './routes'

// Onboarding: what the user's wallets hold on every network, valued in USD, moved into one stable on one chain. The server
// plans the legs (POST /onboard/plan); this runs them one wallet prompt at a time, and keeps the run in localStorage so a
// reload (or another tab) shows it and can carry on.

const min = (a: bigint, b: bigint) => (a < b ? a : b)

// ---- State -----------------------------------------------------------------------------------------

export type LegStatus = 'waiting' | 'running' | 'sent' | 'done' | 'failed' | 'skipped'
// A leg's progress. amount: what it sends (base units), out: what it delivers (estimated until known). before: the balance
// its inputs add to, read before the first of them ran. quoted: the last price the user was shown, after it moved ([out,
// amount]). held: the balance it sent from, as read for its last try, and at: when the wallet was asked, for telling later
// whether that try went out. batch: the wallet's id for the batch it went in, until the batch's transaction is known.
// track: how its bridge follows it. unsure: it may have gone out unseen, so a retry checks first. declined: the user
// turned it down in the wallet (Continue asks again).
export type LegRun = {
  status: LegStatus
  txHash?: string
  recentKey?: string
  amount?: string
  out?: string
  error?: string
  before?: string
  quoted?: [string, string]
  held?: string
  at?: number
  batch?: string
  track?: Record<string, string>
  unsure?: boolean
  declined?: boolean
}
export type Session = {
  id: string
  createdAt: number
  to: string // destination chain id
  toToken: Token
  recipient: string
  senders: Accounts[] // the groups of accounts the plan was made for: each leg sends only from its group's
  slippageBps: number
  plan: Plan
  legs: Record<string, LegRun>
  paused?: string // why the run stopped before the end, for the user
}
// What a plan was made for.
export type Target = { to: string; toToken: Token; recipient: string; senders: Accounts[] }

const SESSION_KEY = 'onboard-session'
const DESTINATION_KEY = 'onboard-to'
const LOCK = 'onboard-run'
const BLOCKED = 'Some steps failed: retry or skip them to go on.'

const savedTo = (() => {
  try {
    return JSON.parse(localStorage.getItem(DESTINATION_KEY) ?? 'null') as { chain: string; token: string } | null
  } catch {
    return null
  }
})()

const stored = (): Session | undefined => {
  try {
    // Runs from before several accounts had one group, as sender.
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as (Session & { sender?: Accounts }) | null
    return s?.plan?.legs && s.legs ? { ...s, senders: s.senders ?? [s.sender ?? {}] } : undefined
  } catch {
    return
  }
}

export const onboard = $state({
  config: undefined as OnboardConfig | undefined,
  error: '', // the config didn't load
  to: savedTo?.chain ?? 'injective',
  token: savedTo?.token ?? '',
  holdings: [] as Record<string, ChainHoldings>[], // the scan: per group of accounts (see groups), by chain id
  groups: [] as Accounts[], // the accounts the holdings are for
  scanning: 0, // scan requests in flight
  scanned: '', // those, as a key
  plan: undefined as Plan | undefined,
  target: undefined as Target | undefined, // what the plan is for
  planning: false,
  planError: '',
  support: {} as Record<number, Atomic>, // EIP-5792 batches, by EVM chain id
  session: stored(),
  running: false,
  elsewhere: false, // another tab is running the session: this one shows it, read-only
  stopping: false,
  action: '', // what the wallet is asked for right now
  current: '', // the leg it's for
  switching: undefined as Switching | undefined, // the run waits for the wallet to switch to this account
})
// The account the next leg sends from, and its wallet app, when the wallet is on another.
export type Switching = { kind: 'evm' | 'solana'; address: string; wallet?: WalletInfo }

// ---- One run, several tabs ---------------------------------------------------------------------------
//
// Every tab shows the run, but only one runs it at a time: the one holding the Web Lock, taken for a run or for a change
// the user asks for (Retry, Skip…), after reading the run afresh. The others show it read-only, kept current by storage
// events. Following sent legs needs no lock: saves merge leg by leg, a tab writing only the legs it changed.

// Each part of the run (each leg, why it paused) as this tab last read or wrote it, to tell its changes from other tabs'.
let synced: Record<string, string> = {}
const canon = (value: unknown) => JSON.stringify(value ?? null, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))
const parts = (s: Session): Record<string, string> => ({ paused: canon(s.paused), ...Object.fromEntries(Object.entries(s.legs).map(([id, r]) => [`leg ${id}`, canon(r)])) })
// In place, so that a leg a run holds on to stays the one in the session.
function replace(r: LegRun, by: LegRun) {
  for (const key of Object.keys(r)) if (!(key in by)) delete r[key as keyof LegRun]
  Object.assign(r, by)
}

// Takes in what other tabs saved: the parts this tab hasn't changed since it last synced. A run another tab ended (or a
// new one it started) shows here too, unless this tab is running its own.
function pull() {
  const s = onboard.session
  const theirs = stored()
  if (!s || !theirs || theirs.id !== s.id) {
    if (onboard.running || (!s && !theirs)) return
    onboard.session = theirs
    synced = theirs ? parts(theirs) : {}
    if (theirs && !holding) void claim()
    return
  }
  const [mine, now] = [parts(s), parts(theirs)]
  for (const [key, value] of Object.entries(now)) {
    if (mine[key] !== synced[key] || mine[key] === value) continue
    if (key === 'paused') s.paused = theirs.paused
    else if (s.legs[key.slice(4)]) replace(s.legs[key.slice(4)]!, theirs.legs[key.slice(4)]!)
  }
  synced = now
}

function write() {
  if (!onboard.session) return
  const s = $state.snapshot(onboard.session)
  localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  synced = parts(s)
}
const save = () => (pull(), write())

addEventListener('storage', (event) => {
  if (event.key === SESSION_KEY || event.key === null) pull()
})

// Does `work` with the run read afresh, once this tab holds it; while another tab does, this one waits to take over.
// Without the Web Locks API (old browsers) tabs don't know of each other, and the merge in save is all there is.
let holding = false
async function exclusive(work: () => unknown) {
  if (!navigator.locks) return void (adopt(), await work())
  await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return elsewhere()
    holding = true
    try {
      adopt()
      await work()
    } finally {
      holding = false
    }
  })
}
const claim = () => exclusive(() => {})

let waiting = false
function elsewhere() {
  onboard.elsewhere = true
  if (waiting) return
  waiting = true
  void navigator.locks.request(LOCK, () => {
    holding = true
    adopt()
    waiting = holding = false
  })
}

// The run as storage has it, for the tab that now holds it. A leg still sending was left mid-way by a tab that went away
// (reloaded, closed): with a transaction, or a batch the wallet can report on, it's followed; one the wallet was asked
// for may or may not have gone out, so a retry checks first; one it never reached is just ready again.
function adopt() {
  onboard.elsewhere = false
  pull()
  const s = onboard.session
  if (!s) return
  let changed = false
  for (const r of Object.values(s.legs)) {
    if (r.status !== 'running') continue
    changed = true
    if (r.txHash || r.batch) r.status = 'sent'
    else if (r.at) Object.assign(r, { status: 'failed', unsure: true, error: 'Interrupted while your wallet had it, so it may have gone out. Retry checks that first.' })
    else r.status = 'waiting'
  }
  if (!s.paused && Object.values(s.legs).some((r) => r.status === 'waiting')) {
    s.paused = 'Paused. Continue when you’re ready.'
    changed = true
  }
  if (changed) save()
  void watch()
}

// ---- Config and destination ------------------------------------------------------------------------

let loading: Promise<void> | undefined
export function loadOnboard() {
  loading ??= getOnboard().then(
    (config) => {
      onboard.config = config
      onboard.error = ''
      if (!destinationToken()) setDestination(config.destinations[0]?.chain ?? 'injective')
      void watch()
    },
    (err) => {
      onboard.error = (err as Error).message
      loading = undefined
    },
  )
  return loading
}

export const destination = () => onboard.config?.destinations.find((d) => d.chain === onboard.to)
export function destinationToken() {
  const d = destination()
  return d?.tokens.find((t) => same(t.address, onboard.token)) ?? d?.tokens[0]
}

// The pick is kept for next time.
export function setDestination(chain: string, token?: string) {
  const d = onboard.config?.destinations.find((x) => x.chain === chain)
  onboard.to = chain
  onboard.token = token ?? d?.tokens[0]?.address ?? ''
  onboard.plan = undefined
  localStorage.setItem(DESTINATION_KEY, JSON.stringify({ chain, token: onboard.token }))
}

// ---- Accounts --------------------------------------------------------------------------------------

// The accounts to scan, in groups the planner takes each on its own (a group's legs send from its accounts): the first EVM
// account with the first Solana one and Keplr's, the second ones together, and so on. An EVM account covers every EVM
// chain, Injective and Hyperliquid; Keplr's the scanned Cosmos chains (one key gives them all, see derivedAddress) and
// Injective's Cosmos side.
export function groups(): Accounts[] {
  const cosmos: Record<string, string> = {}
  for (const id of onboard.config?.scan.cosmos ?? []) {
    const chain = chainById(id)
    const address = chain?.kind === 'cosmos' ? derivedAddress(chain) : undefined
    if (address) cosmos[id] = address
  }
  if (cosmosWallet.addresses['injective-cosmos']) cosmos['injective-cosmos'] = cosmosWallet.addresses['injective-cosmos']
  const [evm, solana] = [wallet.accounts.map((a) => a.address.toLowerCase()), solanaWallet.accounts.map((a) => a.address)]
  const keplr = Object.keys(cosmos).length ? cosmos : undefined
  return [...Array(Math.max(evm.length, solana.length, 1)).keys()].map((i) => ({ evm: evm[i], solana: solana[i], cosmos: i ? undefined : keplr })).filter((a) => a.evm || a.solana || a.cosmos)
}

// A group's account on a chain, as the planner has it: the EVM one on EVM chains and Hyperliquid (on Injective, else
// Keplr's in its 0x form), the Solana one, or Keplr's.
export function ownOn(chain: Chain, a: Accounts) {
  const kind = walletKind(chain)
  if (kind === 'solana') return a.solana
  if (kind === 'evm') {
    const side = chain.kind === 'evm' && chain.cosmos ? a.cosmos?.[chain.cosmos.id] : undefined
    return a.evm ?? (side ? parseAddress(chain, side) : undefined)
  }
  if (chain.kind === 'cosmos') return a.cosmos?.[chain.id] ?? (a.cosmos ? derivedAddress(chain) : undefined)
}
// The user's account on a chain to send to by default: the first one connected there.
export const mineOn = (chain: Chain) => ownOn(chain, groups()[0] ?? {}) ?? (chain.kind === 'cosmos' ? addressOn(chain, true) : undefined)
// Whether an address is one of the user's connected accounts on a chain.
export const isMine = (chain: Chain, address: string) => [...groups().map((a) => ownOn(chain, a)), mineOn(chain)].some((own) => !!own && same(own, address))

// The chains to scan for those accounts, the main networks first.
function scanTargets(config: OnboardConfig, a: Accounts) {
  const ids = [
    ...(a.evm ? ['injective', ...config.scan.evm] : []),
    ...(a.evm && config.scan.hyperliquid ? ['hyperliquid'] : []),
    ...(a.solana && config.scan.solana ? ['solana'] : []),
    ...Object.keys(a.cosmos ?? {}).filter((id) => id !== 'injective-cosmos'),
    ...(a.cosmos?.['injective-cosmos'] ? ['injective'] : []),
  ]
  const rank = (id: string) => {
    const i = app.chains.findIndex((c) => c.id === id)
    return i < 0 ? app.chains.length : i
  }
  return [...new Set(ids)].filter((id) => chainById(id)).sort((x, y) => rank(x) - rank(y))
}

// ---- Scan ------------------------------------------------------------------------------------------

let scanning: AbortController | undefined
let scannedAt = 0

// Four requests at once, so the list fills in as they answer. The chains are dealt round them: each answers once all of
// its chains have, so each gets some of the main networks (which hold the most and take the longest). The same accounts
// aren't scanned again within a minute unless asked, and then the server reads them afresh too.
export async function scan(force = false) {
  const config = onboard.config
  if (!config) return
  const list = groups()
  const key = JSON.stringify(list)
  if (!force && key === onboard.scanned && Date.now() - scannedAt < 60_000) return
  scanning?.abort()
  const controller = (scanning = new AbortController())
  // Other accounts start from an empty list (and lose a plan made for them); the same ones keep theirs on screen until the
  // new answers replace it.
  if (key !== onboard.scanned) {
    onboard.holdings = list.map(() => ({}))
    onboard.groups = list
    cancelPlan()
  }
  onboard.scanned = key
  scannedAt = Date.now()
  // Fewer requests at once for each of several groups: the server allows so many a minute.
  const most = list.length > 1 ? 2 : 4
  const batches = list.flatMap((a, g) => {
    const targets = scanTargets(config, a)
    const n = Math.min(most, targets.length)
    return [...Array(n).keys()].map((k) => ({ g, a, chains: targets.filter((_, i) => i % n === k) }))
  })
  onboard.scanning = batches.length
  await Promise.all(
    batches.map(async ({ g, a, chains }) => {
      try {
        const result = await getHoldings({ ...a, chains, ...(force && { fresh: true }) }, controller.signal)
        if (controller.signal.aborted) return
        for (const c of result.chains) onboard.holdings[g]![c.chain] = c
      } catch (err) {
        if (controller.signal.aborted) return
        for (const id of chains) onboard.holdings[g]![id] = { chain: id, holdings: [], error: (err as Error).message }
      } finally {
        if (!controller.signal.aborted) onboard.scanning--
      }
    }),
  )
}

// ---- Holdings and selection ------------------------------------------------------------------------

// A holding as the list shows it. usable: what may move (the gas token keeps a reserve), usd: what that's worth.
// note: why it doesn't move. small: under a dollar, left out unless picked by hand.
// noGas: the chain's gas token is (about) gone, so moving it needs gas brought there first. group: the group of accounts
// it's in (see groups), owner: its account.
export type Row = {
  key: string
  group: number
  owner: string
  chain: Chain
  holding: Holding
  usable: bigint
  usd: number
  note?: 'there' | 'send' | 'unsupported' | 'unpriced' | 'illiquid' | 'wallet' | 'reserve'
  small: boolean
  noGas: boolean
}
export const NOTES: Record<NonNullable<Row['note']>, string> = {
  there: 'Already there',
  send: 'Send it yourself',
  unsupported: 'Not supported',
  unpriced: 'No price',
  illiquid: 'Illiquid',
  wallet: 'Needs its wallet',
  reserve: 'Kept for gas',
}

// What stays of a chain's gas token for the transactions that move the rest, as the planner keeps it (it also keeps twice
// the gas it expects). Monad reverts a transaction that leaves less than 10 MON.
const FLOOR_USD: Record<string, number> = { ethereum: 4, linea: 1, hyperevm: 0.15 }
export function reserveOf(chain: Chain, token: Pick<Token, 'decimals'>, price?: number) {
  const unit = 10n ** BigInt(token.decimals)
  if (chain.kind === 'hypercore') return 0n // no gas there
  if (chain.kind === 'solana') return unit / 100n
  if (chain.id === 'injective') return unit / 1000n
  if (chain.id === 'monad') return unit * 10n
  if (!price) return 0n
  const usd = FLOOR_USD[chain.id] ?? 0.05
  return BigInt(Math.ceil((usd / price) * 10 ** Math.min(token.decimals, 15))) * 10n ** BigInt(Math.max(token.decimals - 15, 0))
}

// Whether holdings can move: on Cosmos chains Keplr has to be connected there.
const signs = (chain: Chain, owner: string) => !!owner && (chain.kind !== 'cosmos' || !!addressOn(chain))

// The wallet to connect for holdings left out for want of it: Keplr on Cosmos chains (asked for that chain), the Solana
// wallet on Solana, else the EVM wallet (on Injective it signs on both sides). Once connected, the holdings are read
// again and a plan on screen is dropped, to be made again with it.
export function walletFor(chain: Chain) {
  if (chain.kind === 'cosmos') return { label: 'Connect Keplr', connect: () => void (cosmosWallet.connected ? addressFromWallet(chain).catch(() => {}) : connectCosmosWallet(chain)) }
  if (walletKind(chain) === 'solana') return { label: 'Connect Solana wallet', connect: () => void connectSolanaWallet() }
  return { label: 'Connect wallet', connect: () => void connectWallet() }
}

// The holdings as the list shows them, for a recipient (the user's own account on the destination when not given). What's
// already in the destination's stable stays where it is for the user's own account; for someone else, the user sends it
// from the wallet (the plan has no plain transfer for it).
export function rows(recipient?: string): Row[] {
  const target = destinationToken()
  const list: Row[] = []
  onboard.holdings.forEach((byChain, group) => {
    const accounts = onboard.groups[group]
    for (const { chain: id, holdings } of Object.values(byChain)) {
      const chain = chainById(id)
      const owner = chain && accounts ? (ownOn(chain, accounts) ?? '') : ''
      if (!chain) continue
      // Hyperliquid needs no gas; on Arc, Tempo or Noble the stables pay it.
      const gas = holdings.find((h) => h.native)
      const noGas = chain.kind !== 'hypercore' && !onboard.config?.destinations.find((d) => d.chain === id)?.gas.stable && !((gas?.usd ?? 0) >= 0.01)
      for (const holding of holdings) {
        const raw = BigInt(holding.raw)
        const reserve = holding.native ? reserveOf(chain, holding.token, holding.price) : 0n
        const usable = raw > reserve ? raw - reserve : 0n
        const usd = holding.usd !== undefined && raw > 0n ? (holding.usd * Number(usable)) / Number(raw) : 0
        const there = !!target && id === onboard.to && same(holding.token.address, target.address)
        const stays = !recipient || same(owner, recipient)
        const note = there ? (stays ? 'there' : 'send') : holding.unsupported ? 'unsupported' : holding.usd === undefined ? 'unpriced' : holding.illiquid ? 'illiquid' : !signs(chain, owner) ? 'wallet' : usable <= 0n ? 'reserve' : undefined
        list.push({ key: `${group}:${id}:${holding.token.address}`, group, owner, chain, holding, usable, usd, note, small: usd < 1, noGas: noGas && !holding.native })
      }
    }
  })
  return list
}
// The groups' accounts of a kind, when there are several: their holdings, steps and leftovers then say whose they are.
export const several = (kind: 'evm' | 'solana') => (kind === 'evm' ? wallet.accounts : solanaWallet.accounts).length > 1

// The most holdings one plan takes: a selection keeps the largest.
export const MAX_ITEMS = 300

export type Selected = { amount: bigint; usd: number; partial: boolean }
// Cheapest to consolidate first: USDC on CCTP chains (one burn), other stables, other tokens by value, gas tokens last.
// Ethereum's stables come after the other chains' ones: its gas makes a small part of them cost the most to move.
function rank(r: Row) {
  if (r.holding.stable === 'usdc' && r.chain.domain !== undefined) return r.chain.id === 'ethereum' ? 1.5 : 0
  if (r.holding.stable || r.holding.source === 'stable') return r.chain.id === 'ethereum' ? 1.75 : 1
  return r.holding.native ? 3 : 2
}

// What moves for `target` dollars ('all': everything that can). Holdings picked by hand go first, those unticked stay;
// then whole holdings in the order above until the next is worth more than what's left, and part of that one. At most
// MAX_ITEMS of them, the largest.
export function choose(list: Row[], target: number | 'all', overrides: Record<string, boolean>) {
  const picked = new Map<string, Selected>()
  const movable = list.filter((r) => !r.note && r.usable > 0n && overrides[r.key] !== false && (!r.small || overrides[r.key]))
  let left = target === 'all' ? Infinity : target
  for (const r of movable.filter((r) => overrides[r.key])) {
    picked.set(r.key, { amount: r.usable, usd: r.usd, partial: false })
    left -= r.usd
  }
  const rest = movable.filter((r) => !overrides[r.key] && !r.small).sort((a, b) => rank(a) - rank(b) || b.usd - a.usd)
  for (const r of rest) {
    if (left < 0.005) break
    if (r.usd <= left) {
      picked.set(r.key, { amount: r.usable, usd: r.usd, partial: false })
      left -= r.usd
      continue
    }
    // Enough of it for what's left, rounded up to the token's smallest unit.
    const share = BigInt(Math.ceil((left / r.usd) * 1e9))
    picked.set(r.key, { amount: min((r.usable * share + 999_999_999n) / 1_000_000_000n, r.usable), usd: left, partial: true })
    break
  }
  if (picked.size > MAX_ITEMS) for (const [key] of [...picked].sort((a, b) => b[1].usd - a[1].usd).slice(MAX_ITEMS)) picked.delete(key)
  return picked
}

// ---- Plan ------------------------------------------------------------------------------------------

// A group's gas token balance on every chain the scan read (the destination's too), for the planner's gas checks; one it
// couldn't read is left out. Gas for another recipient is the planner's to decide (it adds none).
function natives(group: number) {
  const out: Record<string, string> = {}
  for (const c of Object.values(onboard.holdings[group] ?? {})) if (!c.error) out[c.chain] = c.holdings.find((h) => h.native)?.raw ?? '0'
  return out
}

let planning: AbortController | undefined
// A part of the plan for each group with holdings picked. The recipient's goes first, picked or not, when gas is wanted:
// the planner plans the destination's gas for the first group, from its holdings.
export async function makePlan(list: Row[], picked: Map<string, Selected>, recipient: string, gas: boolean) {
  const toToken = destinationToken()
  const toChain = chainById(onboard.to)
  if (!toToken || !toChain) return
  const items = new Map<number, PlanPart['items']>()
  for (const [key, p] of picked) {
    const row = list.find((r) => r.key === key)!
    items.set(row.group, [...(items.get(row.group) ?? []), { chain: row.chain.id, token: row.holding.token.address, amount: String(p.amount), usd: Math.round(p.usd * 100) / 100 }])
  }
  const theirs = onboard.groups.findIndex((a) => same(ownOn(toChain, a) ?? '', recipient))
  const order = [...new Set([...(theirs >= 0 && (gas || items.has(theirs)) ? [theirs] : []), ...[...items.keys()].sort((a, b) => a - b)])]
  const [first, ...others] = order.map((g): PlanPart => ({ sender: onboard.groups[g]!, items: items.get(g) ?? [], natives: natives(g) }))
  if (!first) return
  const senders = order.map((g) => $state.snapshot(onboard.groups[g]!))
  const body: PlanBody = { to: onboard.to, toToken: toToken.address, recipient, ...first, ...(others.length ? { others } : {}), gas, slippageBps: 50 }
  planning?.abort()
  const controller = (planning = new AbortController())
  onboard.planning = true
  onboard.planError = ''
  try {
    const plan = await planOnboard(body, controller.signal)
    if (controller.signal.aborted) return
    onboard.plan = plan
    onboard.target = { to: onboard.to, toToken: $state.snapshot(toToken), recipient, senders }
    void loadSupport(plan)
  } catch (err) {
    if (!controller.signal.aborted) onboard.planError = (err as Error).message
  } finally {
    if (!controller.signal.aborted) onboard.planning = false
  }
}

export function cancelPlan() {
  planning?.abort()
  onboard.planning = false
  onboard.plan = undefined
}

// A leg whose transactions the EVM wallet sends on an EVM chain (not a signature for Injective's Cosmos side).
const onEvm = (leg: Leg) => leg.wallet === 'evm' && !sideOf(chainById(leg.from)!, leg.side)

// Which of the plan's chains the wallet batches on, for the count of confirmations.
async function loadSupport(plan: Plan) {
  const chains = [...new Set(plan.legs.filter(onEvm).map((l) => chainById(l.from)))].filter((c) => c?.kind === 'evm') as EvmChain[]
  await Promise.all(chains.map(async (c) => (onboard.support[c.chainId] = await atomicSupport(c.chainId))))
}

// How many times the wallet asks, at most: an approval and a transaction per leg from an ERC20 on an EVM chain (one prompt
// with batches, and one for all of a chain's swaps), two signatures from Hyperliquid, one transaction elsewhere.
export function confirmations(legs: Leg[], support = onboard.support) {
  let count = 0
  const swaps = new Map<string, number>()
  for (const leg of legs) {
    const chain = chainById(leg.from)
    if (leg.kind === 'get-inj' || !chain || chain.kind !== 'evm' || !onEvm(leg)) count += chain?.kind === 'hypercore' ? 2 : 1
    else if (support[chain.chainId] && support[chain.chainId] !== 'none') {
      if (leg.kind === 'swap') swaps.set(chain.id, (swaps.get(chain.id) ?? 0) + 1)
      else count += 1
    } else count += isNative(chain, leg.fromToken.address) ? 1 : 2
  }
  for (const n of swaps.values()) count += Math.ceil(n / 8)
  return count
}

// ---- Run -------------------------------------------------------------------------------------------

const final = (status?: LegStatus) => status === 'done' || status === 'skipped'
// Over: every leg done, skipped or failed (one the user declined is still to be asked for).
export const finished = (s: Session) => Object.values(s.legs).every((r) => final(r.status) || (r.status === 'failed' && !r.declined))

// Runs the legs whose dependencies are done, one at a time, until none is left, the user stops, or the wallet is refused.
// first: what the click that started it changes, once this tab holds the run (false: nothing more to do).
async function work(first?: () => boolean | Promise<boolean>) {
  if (onboard.running || onboard.elsewhere) return
  onboard.running = true
  onboard.stopping = false
  try {
    if (!(await acceptTerms())) return
    await exclusive(async () => {
      if (first && !(await first())) return
      if (onboard.session) await loop(onboard.session)
    })
  } finally {
    onboard.running = onboard.stopping = false
    onboard.action = onboard.current = ''
    void watch()
  }
}

export function begin() {
  if (!onboard.plan || !onboard.target || onboard.session) return
  return work(() => {
    const [plan, target] = [onboard.plan, onboard.target]
    if (!plan || !target || onboard.session) return false // another tab started one meanwhile
    onboard.session = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...target,
      slippageBps: 50,
      plan: $state.snapshot(plan),
      legs: Object.fromEntries(plan.legs.map((l) => [l.id, { status: 'waiting' as const }])),
    }
    onboard.plan = undefined
    write()
    return true
  })
}

export const run = () => work()

async function loop(s: Session) {
  if (onboard.stopping) return
  // The legs declined last time are asked for again (the user skips the ones to leave out).
  for (const r of Object.values(s.legs)) if (r.declined) Object.assign(r, { status: 'waiting', error: undefined, declined: undefined })
  s.paused = undefined
  save()
  let last = '' // the chain of the last leg, to keep network switches down
  try {
    while (!onboard.stopping && onboard.session === s) {
      await track(s)
      const next = pickNext(s, last)
      if (!next) {
        const waiting = s.plan.legs.filter((l) => s.legs[l.id]?.status === 'sent')
        if (!waiting.length) break
        onboard.action = `Waiting for ${waiting.length === 1 ? `the transfer from ${chainName(waiting[0]!.from)}` : `${waiting.length} transfers`} to arrive…`
        await sleep(2500)
        continue
      }
      last = next[0]!.from
      onboard.action = ''
      if (next.length > 1) await runSwaps(s, next)
      else await runLeg(s, next[0]!)
    }
  } finally {
    // Legs still waiting behind failed ones: the run pauses there, for those to be retried or skipped.
    if (!s.paused && Object.values(s.legs).some((r) => r.status === 'waiting')) s.paused = BLOCKED
    save()
  }
}

// Finishes what the wallet is asked for now, then pauses.
export function stop() {
  const s = onboard.session
  if (!s || !onboard.running) return
  onboard.stopping = true
  s.paused = 'Paused. Continue when you’re ready.'
  save()
}

// A failed leg goes again, as new. One that may have gone out unseen is checked on its chain first: if it did, it counts
// as sent, and the run goes on with the legs after it.
export const retry = (id: string) =>
  work(async () => {
    const s = onboard.session
    const [leg, r] = [s?.plan.legs.find((l) => l.id === id), s?.legs[id]]
    if (!s || !leg || r?.status !== 'failed') return false
    if (r.unsure) {
      const verdict = await lastTry(s, leg, r).catch((err: Error) => err.message)
      if (verdict === 'sent') Object.assign(r, { status: 'done', unsure: undefined, error: 'It went out (your balance shows it), though the app lost its transaction.' })
      else if (verdict !== undefined) r.error = verdict
      save()
      if (verdict) return verdict === 'sent'
    }
    replace(r, { status: 'waiting', ...(r.before !== undefined && { before: r.before }), ...(r.quoted && { quoted: r.quoted }) })
    save()
    return true
  })

// The legs after a skipped one go ahead without it (a bridge then moves what did arrive), unless the user paused the run.
export const skip = (id: string) =>
  work(() => {
    const s = onboard.session
    const r = s?.legs[id]
    if (!s || r?.status !== 'failed') return false
    Object.assign(r, { status: 'skipped', error: undefined, unsure: undefined, declined: undefined })
    save()
    return !s.paused || s.paused === BLOCKED
  })

export async function dismiss() {
  if (onboard.running) return
  await exclusive(() => {
    onboard.session = undefined
    localStorage.removeItem(SESSION_KEY)
    synced = {}
  })
  if (!onboard.session) void scan(true)
}

const ORDER: Record<Leg['kind'], number> = { swap: 0, cctp: 1, bridge: 2, 'get-inj': 3 }
const chainName = (id: string) => chainById(id)?.name ?? id

// The next legs to run: those of the account the wallet is on (so the user switches accounts as little as can be), else of
// the first one ready. Of those, refuels first (the legs they pay gas for wait on them), then one chain at a time, the last
// one's first, its swaps before the bridges they feed, and the gas token's own last (the others' fees come out of it while
// it's all there). A chain's swaps go together, for one batch where the wallet can.
function pickNext(s: Session, last: string): Leg[] | undefined {
  const waiting = s.plan.legs.filter((l) => s.legs[l.id]?.status === 'waiting' && [...(l.after ?? []), ...(l.inputs ?? [])].every((id) => final(s.legs[id]?.status ?? 'done')))
  if (!waiting.length) return
  const now = waiting.filter((l) => signsNow(s, l))
  const ready = now.length ? now : waiting.filter((l) => signerOf(s, l) === signerOf(s, waiting[0]!))
  const refuel = ready.find((l) => l.purpose === 'refuel')
  if (refuel) return [refuel]
  const chain = ready.some((l) => l.from === last) ? last : ready[0]!.from
  const gas = (l: Leg) => Number(isNative(chainById(l.from)!, l.fromToken.address))
  const here = ready.filter((l) => l.from === chain).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || gas(a) - gas(b))
  const first = here[0]!
  if (first.kind !== 'swap' || !onEvm(first) || chainById(chain)?.kind !== 'evm') return [first]
  return here.filter((l) => l.kind === 'swap' && onEvm(l)).slice(0, 8)
}

const progress = (label: string) => (onboard.action = label)

function starting(r: LegRun, leg: Leg) {
  Object.assign(r, { status: 'running', error: undefined })
  onboard.current = leg.id
  save()
}

// The run waits for the user, the leg ready to go again: its bridge is busy (the server sits a provider out for a minute
// after it rate-limits), or the run was stopped while waiting for the wallet to switch accounts.
class Hold extends Error {}

// A refusal in the wallet pauses the run, the leg failed for the user to skip (Continue asks for it again); a busy bridge
// pauses it with the leg ready to go again. Anything else fails just this leg, and one that may have gone out unseen is
// marked unsure, for a retry to check its chain first.
function failed(s: Session, r: LegRun, err: unknown) {
  const message = walletError(err)
  if (err instanceof Hold || message === undefined) {
    Object.assign(r, err instanceof Hold ? { status: 'waiting', error: undefined } : { status: 'failed', error: 'You declined it in your wallet.', declined: true })
    s.paused = err instanceof Hold ? err.message : 'You declined in your wallet. Continue when you’re ready.'
    onboard.stopping = true
    return
  }
  // The server didn't answer after the wallet sent: it may have gone through.
  const unsure = err instanceof Unsure || (err instanceof ApiError && !err.status && r.at !== undefined)
  Object.assign(r, { status: 'failed', error: unsure ? `${message.replace(/\.?$/, '.')} It may have gone out: Retry checks that first.` : message, unsure: unsure || undefined })
}

async function runLeg(s: Session, leg: Leg) {
  const r = s.legs[leg.id]!
  starting(r, leg)
  try {
    await baseline(s, leg)
    if (leg.kind === 'cctp') await runCctp(s, leg, r)
    else if (leg.kind === 'get-inj') await runGetInj(s, leg, r)
    else {
      const quoted = await quote(s, leg, r)
      if (quoted) await send(s, leg, r, quoted)
    }
  } catch (err) {
    failed(s, r, err)
  } finally {
    onboard.current = ''
    save()
  }
}

// A chain's swaps: one quote each, then a single prompt for all of them where the wallet batches; else one by one.
async function runSwaps(s: Session, legs: Leg[]) {
  const chain = chainById(legs[0]!.from) as EvmChain
  if ((await atomicSupport(chain.chainId)) === 'none') {
    for (const leg of legs) if (!onboard.stopping) await runLeg(s, leg)
    return
  }
  const quoted: { leg: Leg; r: LegRun; q: Quoted }[] = []
  for (const leg of legs) {
    const r = s.legs[leg.id]!
    starting(r, leg)
    try {
      await baseline(s, leg)
      const q = await quote(s, leg, r)
      if (q) quoted.push({ leg, r, q })
    } catch (err) {
      failed(s, r, err)
    }
  }
  onboard.current = quoted.length === 1 ? quoted[0]!.leg.id : ''
  if (!quoted.length || onboard.stopping) {
    for (const { r } of quoted) Object.assign(r, { status: 'waiting' })
    return save()
  }
  try {
    progress(`Switching to ${chain.name}…`)
    await switchChain(chain)
    const calls = (await Promise.all(quoted.map(({ q }) => callsFor(chain, q.quote.steps)))).flat()
    for (const { r, q } of quoted) sending(r, q.amount, q.quote.amountOut, q.quote.track)
    const hash = await sendCalls(chain, calls, progress, (id) => {
      for (const { r } of quoted) r.batch = id
      save()
    })
    for (const { leg, r, q } of quoted) sent(s, leg, r, hash, true, q.quote.via)
  } catch (err) {
    if (!(err instanceof BatchUnavailable)) for (const { r } of quoted) failed(s, r, err)
    // The wallet won't batch after all: the same quotes go one by one.
    else
      for (const { leg, r, q } of quoted) {
        if (onboard.stopping) {
          Object.assign(r, { status: 'waiting' })
          continue
        }
        onboard.current = leg.id
        await send(s, leg, r, q).catch((e) => failed(s, r, e))
      }
  } finally {
    onboard.current = ''
    save()
  }
}

// ---- Amounts ---------------------------------------------------------------------------------------

// ---- Accounts of a run ------------------------------------------------------------------------------

// The accounts a leg sends from: its group's, as the plan was made.
const accountsOf = (s: Session, leg: Leg) => s.senders[leg.group ?? 0] ?? {}

// The account a leg reads balances of on a chain: its group's there (a run from before groups: the connected one).
function ownerOf(s: Session, chain: Chain, leg: Leg) {
  const owner = ownOn(chain, accountsOf(s, leg)) ?? (leg.group ? undefined : addressOn(chain, true))
  if (!owner) throw new Error(`Connect your wallet for ${chain.name} first.`)
  return owner
}

// Who signs a leg: its group's EVM or Solana account, or Keplr.
function signerOf(s: Session, leg: Leg) {
  const a = accountsOf(s, leg)
  return leg.wallet === 'solana' ? a.solana : leg.wallet === 'evm' ? a.evm : 'keplr'
}
const signsNow = (s: Session, leg: Leg) => {
  const who = signerOf(s, leg)
  const now = leg.wallet === 'solana' ? solanaWallet.address : wallet.address
  return who === 'keplr' || (!!who && !!now && same(who, now))
}

// The wallet signs a leg from the account it sends from: on another one, the user is asked to switch to it there (or
// to choose it, see chooseAccountNow), and the run waits (five minutes at most, or until stopped).
async function onAccount(kind: 'evm' | 'solana', address: string) {
  const until = Date.now() + 300_000
  try {
    while (!(await (kind === 'evm' ? isOn(address) : solanaIsOn(address)))) {
      if (onboard.stopping) throw new Hold('Paused. Continue when you’re ready.')
      const name = (kind === 'evm' ? walletOf(address) : solanaWalletOf(address))?.name ?? 'your wallet'
      if (Date.now() > until) throw new Error(`${name} stayed on another account. Switch it to ${short(address)}, then retry.`)
      if (onboard.switching?.address !== address) onboard.switching = { kind, address, wallet: kind === 'evm' ? walletOf(address) : solanaWalletOf(address) }
      progress(`Waiting for ${name} to switch to ${short(address)}…`)
      await sleep(1000)
    }
  } finally {
    onboard.switching = undefined
  }
}

// The wallet asked for the account the run waits for (the run notices it's on it).
export async function chooseAccountNow() {
  const want = onboard.switching
  if (!want) return
  const [name, there] = [want.wallet?.name ?? 'Your wallet', `switch it to ${short(want.address)} there`]
  try {
    if (await (want.kind === 'evm' ? chooseAccount(want.address) : chooseSolanaAccount(want.address))) return
    return `${name} is still on another account: ${there}.`
  } catch (err) {
    // Without the method (EIP-1193's 4200, JSON-RPC's -32601), only the wallet itself switches.
    const code = (err as { code?: number })?.code
    return code === 4200 || code === -32601 ? `${name} can’t be asked from here: ${there}.` : walletError(err)
  }
}

// A balance, asked again a couple of times. The server allows so many requests a minute: after a 429 the next try waits
// as long as it says.
async function readBalance(chain: Chain, owner: string, token: string) {
  for (let tries = 3; ; tries--) {
    try {
      return await tokenBalance(chain, owner, token, AbortSignal.timeout(15_000))
    } catch (err) {
      if (tries <= 1) throw err
      await sleep(retryAfter(err) ?? 2000)
    }
  }
}
// How long the server asks to wait (ms) when it answered 429, also as one of the errors of a race of requests.
function retryAfter(err: unknown) {
  const limited = [err, ...((err as AggregateError)?.errors ?? [])].find((e): e is ApiError => e instanceof ApiError && e.status === 429)
  return limited && Math.min(Number(/(\d+)\s*s\b/.exec(limited.message)?.[1] ?? 10), 60) * 1000
}
async function patiently<T>(ask: () => Promise<T>) {
  try {
    return await ask()
  } catch (err) {
    const wait = retryAfter(err)
    if (wait === undefined) throw err
    progress(`The server is busy: trying again in ${wait / 1000} s…`)
    await sleep(wait)
    return ask()
  }
}

// Before a leg whose output another leg sends on (a swap into the USDC a burn moves), that leg's balance is read: it then
// sends what arrived since, not what was quoted.
async function baseline(s: Session, leg: Leg) {
  for (const next of s.plan.legs) {
    const r = s.legs[next.id]
    if (!r || r.before !== undefined || r.status !== 'waiting' || !next.inputs?.includes(leg.id)) continue
    const chain = chainById(next.from)
    if (!chain) throw new Error(`Connect your wallet for ${chainName(next.from)} first.`)
    const owner = ownerOf(s, chain, next)
    progress(`Checking your ${next.fromToken.symbol} on ${chain.name}…`)
    const balance = await readBalance(chain, owner, next.fromToken.address).catch(() => {
      throw new Error(`Couldn't read your ${next.fromToken.symbol} on ${chain.name}. Try again in a moment.`)
    })
    r.before = String(balance)
    save()
  }
}

// What a leg spent comes off the balances other legs measure from, when they send the same token from the same chain.
function spent(s: Session, leg: Leg, amount: bigint) {
  for (const other of s.plan.legs) {
    const r = s.legs[other.id]
    if (other.id === leg.id || r?.before === undefined || r.status !== 'waiting' || other.from !== leg.from || !same(other.fromToken.address, leg.fromToken.address)) continue
    const before = BigInt(r.before)
    r.before = String(before > amount ? before - amount : 0n)
  }
}

// What a leg sends now: with inputs, its own part plus what they added to the balance (at most what they were planned to
// bring, and a little, so USDC arriving from elsewhere meanwhile stays put); a gas token keeps its reserve; and never more
// than the balance. The balance it read is kept (held), to tell later whether this try went out.
async function amountFor(s: Session, leg: Leg, r: LegRun) {
  const chain = chainById(leg.from)!
  const planned = BigInt(leg.amount)
  const owner = ownerOf(s, chain, leg)
  progress(`Checking your ${leg.fromToken.symbol} on ${chain.name}…`)
  const balance = await readBalance(chain, owner, leg.fromToken.address).catch(() => undefined)
  r.held = balance === undefined ? undefined : String(balance)
  if (leg.inputs?.length) {
    let now = balance
    if (now === undefined) throw new Error(`Couldn't read your ${leg.fromToken.symbol} on ${chain.name}. Try again in a moment.`)
    const base = BigInt(leg.base)
    const before = r.before === undefined ? now : BigInt(r.before)
    // A node can lag a few seconds behind the one that confirmed the inputs: until most of what they bring shows, look again.
    const expected = (leg.inputs ?? []).reduce((sum, id) => sum + (s.legs[id]?.status === 'done' ? BigInt(s.legs[id]!.out ?? 0) : 0n), 0n)
    for (let tries = 0; tries < 4 && (now - before) * 10n < expected * 9n; tries++) {
      await sleep(3000)
      now = await readBalance(chain, owner, leg.fromToken.address).catch(() => now!)
    }
    r.held = String(now)
    const added = now > before ? now - before : 0n
    return min(base + min(added, ((planned - base) * 105n) / 100n), now)
  }
  if (balance === undefined) return planned
  const native = isNative(chain, leg.fromToken.address) && chain.kind !== 'hypercore'
  // A gas token keeps its reserve, and what the bridge charges in it on top (deBridge's fixed fee).
  const reserve = native ? reserveOf(chain, leg.fromToken, leg.fromToken.priceUsd ?? holdingPrice(chain.id, leg.fromToken.address)) + BigInt(leg.feeNative ?? 0) : 0n
  return min(planned, balance > reserve ? balance - reserve : 0n)
}
const holdingPrice = (chain: string, token: string) => onboard.holdings.map((g) => g[chain]?.holdings.find((h) => same(h.token.address, token))?.price).find((p) => p !== undefined)

// Half a percent worse than planned (for the amount sent now: planned, when known for it) is fine; beyond that the leg
// stops with the new price, which a retry accepts.
function priceHeld(leg: Leg, r: LegRun, amount: bigint, out: bigint, planned?: bigint) {
  const [was, sent] = r.quoted ?? [leg.amountOut, leg.amount]
  const expected = !r.quoted && planned !== undefined ? planned : BigInt(sent) ? (BigInt(was) * amount) / BigInt(sent) : BigInt(was)
  if (out * 1000n >= expected * 995n) return
  r.quoted = [String(out), String(amount)]
  const show = (value: bigint) => `${formatToken(value, leg.toToken.decimals)} ${leg.toToken.symbol}`
  throw new Error(`The price moved: ${show(out)} now instead of ${show(expected)}. Retry to accept it, or skip.`)
}

// Whether a leg's last try went out, before it's sent again: 'sent' when the balance it sent from dropped by about the
// amount since; a reason to wait when it's too soon to tell (a transaction can take a minute to land), or one from the
// account is still pending; undefined when nothing went out.
async function lastTry(s: Session, leg: Leg, r: LegRun): Promise<string | undefined> {
  if (r.at && Date.now() - r.at < 90_000) return 'It may still go through: retry in a minute or so.'
  const chain = chainById(leg.from)!
  const owner = ownerOf(s, chain, leg)
  progress('Checking whether it went out…')
  if (chain.kind === 'evm' && chain.rpc && onEvm(leg)) {
    const [pending, latest] = await Promise.all(['pending', 'latest'].map((tag) => rpc<string>(chain.rpc!, 'eth_getTransactionCount', [owner, tag])))
    if (BigInt(pending!) > BigInt(latest!)) return 'A transaction from your account is still pending: retry once it went through.'
  }
  // Without the balance from before, the user looks: a second retry then sends.
  if (r.held === undefined || r.amount === undefined) {
    r.unsure = undefined
    return 'Couldn’t tell whether it went out. Check your wallet’s activity: skip this step if it did, retry if it didn’t.'
  }
  const now = await readBalance(chain, owner, leg.fromToken.address)
  return BigInt(r.held) - now >= BigInt(r.amount) / 2n ? 'sent' : undefined
}

// Just before the wallet is asked to send a leg: what it sends and when (to tell later whether it went out), and how its
// bridge follows it.
function sending(r: LegRun, amount: bigint, out?: string, track?: Record<string, string>) {
  Object.assign(r, { amount: String(amount), out, at: Date.now(), track })
  save()
}

// ---- Legs through the bridges' quotes ----------------------------------------------------------------

type Quoted = { quote: Quote; amount: bigint }

// Injective's Cosmos side, when the leg starts or ends there.
const sidesOf = (leg: Leg) => [sideOf(chainById(leg.from)!, leg.side), sideOf(chainById(leg.to)!, leg.side)] as const

// Who receives a leg: the recipient for what lands on the destination, the leg's own account for the steps on the way
// (and refuels, which pay its gas).
function recipientOf(s: Session, leg: Leg) {
  if (leg.to === s.to && leg.purpose !== 'refuel') return s.recipient
  const chain = chainById(leg.to)
  const address = chain && (ownOn(chain, accountsOf(s, leg)) ?? (leg.group ? undefined : addressOn(chain, true)))
  if (!address) throw new Error(`Connect a wallet that receives on ${chainName(leg.to)}.`)
  return address
}

// The account a leg sends from: its group's, the wallet that signs it switched to it first. On Injective's Cosmos side
// Keplr signs where the planner had it (on the account the run measures the balances of), else the EVM wallet, as EIP-712
// typed data.
async function senderOf(s: Session, chain: Chain, leg: Leg, fromSide?: CosmosChain) {
  const owner = ownerOf(s, chain, leg)
  if (leg.wallet === 'cosmos' && chain.kind === 'cosmos') {
    if (!cosmosWallet.connected) {
      void connectCosmosWallet(chain)
      throw new Error(`Connect Keplr to send from ${chain.name}, then retry.`)
    }
    progress(`Getting your ${chain.name} address…`)
    const address = cosmosWallet.addresses[chain.id] ?? (await addressFromWallet(chain))
    if (!same(address, owner)) throw new Error(`Keplr is on another account than ${short(owner)}, whose holdings these are: switch Keplr to it, or skip this step.`)
    return address
  }
  const account = leg.wallet === 'cosmos' ? undefined : accountsOf(s, leg)[leg.wallet]
  if (account) await onAccount(leg.wallet as 'evm' | 'solana', account)
  else if (leg.wallet !== 'cosmos' && !(leg.wallet === 'solana' ? solanaWallet.address : wallet.address)) throw new Error(`Connect your ${leg.wallet === 'solana' ? 'Solana' : 'EVM'} wallet to send from ${chain.name}, then retry.`)
  if (fromSide) {
    const signer = parseAddress(chain, await sideSigner(leg, owner, fromSide))
    if (!signer || !same(signer, owner)) throw new Error(`Keplr is on another Injective account than ${short(owner)}, whose holdings these are: switch Keplr to it, or skip this step.`)
  }
  return owner
}
// Who signs on Injective's Cosmos side: the EVM wallet where the planner had it, else Keplr (see cosmosSigner).
const sideSigner = (leg: Leg, owner: string, side: CosmosChain) => (leg.wallet === 'evm' ? Promise.resolve(injectiveAddress(owner)) : cosmosSigner(side, progress))

// A fresh quote with the real addresses, from the leg's bridge only, on the leg's side of Injective (the other side's
// transactions would be followed on the wrong chain).
async function quote(s: Session, leg: Leg, r: LegRun): Promise<Quoted | undefined> {
  const from = chainById(leg.from)!
  const [fromSide] = sidesOf(leg)
  const sender = await senderOf(s, from, leg, fromSide)
  const amount = await amountFor(s, leg, r)
  if (amount <= 0n) {
    Object.assign(r, { status: 'skipped', error: 'Nothing left to send.' })
    return
  }
  // Keplr's addresses, for routes through Cosmos chains; on Injective's Cosmos side, another group's is its EVM account's.
  const [a, side] = [accountsOf(s, leg), injective().cosmos]
  const addresses = { ...cosmosWallet.addresses, ...(leg.group && a.evm && side ? { [side.id]: injectiveAddress(a.evm) } : {}) }
  const known = Object.keys(addresses).length ? addresses : undefined
  const body: QuoteBody = {
    from: leg.from,
    to: leg.to,
    fromToken: leg.fromToken.address,
    toToken: leg.toToken.address,
    amount: String(amount),
    sender,
    recipient: recipientOf(s, leg),
    addresses: fromSide ? { ...known, [fromSide.id]: await sideSigner(leg, sender, fromSide) } : known,
    slippageBps: s.slippageBps,
    providers: [leg.provider],
    ...(leg.topupGasUsd && { topupGasUsd: leg.topupGasUsd }),
  }
  const pick = ({ quotes }: { quotes: Quote[] }) => quotes.find((q) => q.provider === leg.provider && q.side === leg.side)
  const busy = ({ errors }: { errors: { message: string }[] }) => errors.some((e) => /busy|too many|rate.?limit|429/i.test(e.message))
  progress('Getting a fresh quote…')
  let result = await patiently(() => getQuotes(body))
  let fresh = pick(result)
  // An answer with nothing in it may be a bridge sitting out a rate limit: asked once more, a little later.
  if (!fresh && (busy(result) || !result.errors.length)) {
    progress(`No answer from ${leg.name}: asking again in 15 s…`)
    await sleep(15_000)
    result = await patiently(() => getQuotes(body))
    fresh = pick(result)
  }
  if (fresh?.needs?.length) {
    body.addresses = { ...body.addresses, ...(await addressesFor(fresh.needs, progress)) }
    progress('Getting a fresh quote…')
    result = await patiently(() => getQuotes(body))
    fresh = pick(result)
  }
  if (!fresh?.steps.length) {
    if (busy(result)) throw new Hold(`${leg.name} is busy right now. Continue in a minute.`)
    throw new Error(`${leg.name} has no route for this right now${result.errors[0] ? ` (${result.errors[0].message.replace(/\.$/, '')})` : ''}. Retry later, or skip it.`)
  }
  priceHeld(leg, r, amount, BigInt(fresh.amountOut))
  return { quote: fresh, amount }
}

// The quote's transactions as calls for a batch: approvals only where the allowance is short (and USDT on Ethereum is reset
// to zero first, as it refuses to change one that isn't).
async function callsFor(chain: EvmChain, steps: Step[]): Promise<Call[]> {
  const calls: Call[] = []
  for (const step of steps) {
    if ((step.kind !== 'approve' && step.kind !== 'evm') || step.chainId !== chain.chainId) throw new BatchUnavailable('Not a batch')
    if (step.kind === 'evm') {
      calls.push({ to: step.to, data: step.data, value: BigInt(step.value) })
      continue
    }
    const [allowance, amount] = [BigInt(await call(step.token, encode.allowance(wallet.address!, step.spender))), BigInt(step.amount)]
    if (allowance >= amount) continue
    if (allowance > 0n && RESET_FIRST.has(step.token.toLowerCase())) calls.push({ to: step.token, data: encode.approve(step.spender, 0n) })
    calls.push({ to: step.token, data: encode.approve(step.spender, amount) })
  }
  return calls
}

// Sends a quoted leg: approval and transaction as one batch where the wallet can, else one by one.
async function send(s: Session, leg: Leg, r: LegRun, { quote, amount }: Quoted) {
  const from = chainById(leg.from)!
  if (from.kind === 'evm' && onEvm(leg) && quote.steps.every((st) => st.kind === 'approve' || st.kind === 'evm') && (await atomicSupport(from.chainId)) !== 'none') {
    progress(`Switching to ${from.name}…`)
    await switchChain(from)
    const calls = await callsFor(from, quote.steps).catch(() => [])
    if (calls.length > 1) {
      sending(r, amount, quote.amountOut, quote.track)
      try {
        const hash = await sendCalls(from, calls, progress, (id) => {
          r.batch = id
          save()
        })
        return sent(s, leg, r, hash, true, quote.via)
      } catch (err) {
        if (!(err instanceof BatchUnavailable)) throw err
      }
    }
  }
  sending(r, amount, quote.amountOut, quote.track)
  sent(s, leg, r, await runSteps(from, quote.steps, progress, app.config!.network === 'testnet'), false, quote.via)
}

// A leg went out: what it spent comes off the balances other legs measure from. Without its transaction yet (a batch the
// wallet hasn't reported on), track asks the wallet later.
function sent(s: Session, leg: Leg, r: LegRun, hash: string | undefined, batched: boolean, via?: string) {
  spent(s, leg, BigInt(r.amount ?? 0))
  r.status = 'sent'
  if (hash) record(leg, r, hash, batched, via)
  save()
}

// A sent leg's transaction. A swap is followed here (see track); a transfer to another chain goes into Recent as the Bridge
// tab adds it, which follows it to the end, once track saw its transaction confirm.
function record(leg: Leg, r: LegRun, hash: string, batched: boolean, via = leg.via) {
  Object.assign(r, { txHash: hash, batch: undefined })
  if (leg.kind === 'swap') return
  const [from, to] = [chainById(leg.from)!, chainById(leg.to)!]
  const [fromSide, toSide] = sidesOf(leg)
  const amount = BigInt(r.amount ?? leg.amount)
  const item =
    leg.kind === 'cctp'
      ? addRecent({ txHash: hash, from: from.id, to: to.id, sourceDomain: from.domain, destinationDomain: to.domain, amount: amountString(amount, 6), createdAt: r.at ?? Date.now(), status: from.kind === 'solana' ? 'pending' : 'confirming' })
      : addRouteRecent({ hash, from, to, fromSide, toSide, amount, fromToken: leg.fromToken, toToken: leg.toToken, quote: { provider: leg.provider, name: leg.name, via, track: r.track ?? {}, amountOut: r.out ?? leg.amountOut }, createdAt: r.at })
  r.recentKey = item.txHash
  if (item.status === 'pending') void refresh(item)
  // Relay finds a deposit made from inside a batch (a smart account's call) by tracing the transaction, once told of it.
  if (batched && leg.provider === 'relay' && r.track?.requestId && from.kind === 'evm') {
    const body = JSON.stringify({ chainId: from.chainId, txHash: hash, requestId: r.track.requestId })
    void fetch('https://api.relay.link/transactions/index', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {})
  }
}

// ---- CCTP and Get INJ ------------------------------------------------------------------------------

async function runCctp(s: Session, leg: Leg, r: LegRun) {
  const [from, to] = [chainById(leg.from) as CctpChain, chainById(leg.to) as CctpChain]
  await senderOf(s, from, leg)
  const amount = await amountFor(s, leg, r)
  if (amount <= 0n) return void Object.assign(r, { status: 'skipped', error: 'Nothing arrived to send on.' })
  const recipient = recipientOf(s, leg)
  const toInjective = to.domain === INJECTIVE
  const least = parseUsdc(onboard.config?.minRedeemUsdc ?? '0') ?? 0n
  if (toInjective && !app.config!.autoRedeem) throw new Error('The server doesn’t mint transfers to Injective right now. Retry later, or skip it.')
  if (toInjective && amount < least) throw new Error(`Below ${formatUsdc(least)} USDC, transfers to Injective aren't minted for you. Skip this one, or add more.`)
  // CCTP mints into a Solana wallet's USDC account; when it has none yet, Circle's forwarder creates it, for a higher fee.
  const setup = to.kind === 'solana' && !(await accountExists(await usdcAccount(publicKey(recipient)!, to)))
  progress('Checking Circle’s fees…')
  const planned = { fastBps: leg.cctp?.fastBps ?? null, forwardFee: leg.cctp?.forwardFee ?? null, standardTime: null }
  const fees = await getFees(from.domain, to.domain, setup).catch(() => planned)
  const fast = !!leg.cctp?.fast && fees.fastBps != null
  // To Injective our server mints it; to Solana Circle always delivers it; elsewhere as planned.
  const forward = !toInjective && (to.kind === 'solana' || !!leg.cctp?.forward)
  if (forward && fees.forwardFee == null) throw new Error(`Circle can't deliver from ${from.name} to ${to.name} right now. Retry later, or skip it.`)
  const { maxFee, fee } = cctpFees(amount, fees, fast, forward)
  if (maxFee >= amount) throw new Error('The amount is below Circle’s fee. Skip this one.')
  // Against Circle's fees as planned, for this amount (its forwarding fee is fixed, so a smaller burn isn't a worse price).
  priceHeld(leg, r, amount, amount - fee, amount - cctpFees(amount, planned, fast && planned.fastBps != null, forward && planned.forwardFee != null).fee)
  const mintRecipient = to.kind === 'solana' ? await solanaMintRecipient(recipient, to) : (recipient as Hex)
  const burn: Burn = { amount, destinationDomain: to.domain, mintRecipient, burnToken: from.usdc as Hex, maxFee, minFinalityThreshold: fast ? 1000 : 2000 }
  const hookData = forward ? forwardHook(setup ? solanaKeyHex(recipient) : undefined) : undefined
  if (from.kind === 'solana') {
    if (!solanaWallet.address) throw new Error('Connect your Solana wallet, then retry.')
    const sign = (tx: Uint8Array) => signSolanaTransaction(tx, app.config!.network === 'testnet')
    sending(r, amount, String(amount - fee))
    return sent(s, leg, r, await burnOnSolana(from, solanaWallet.address, { ...burn, hookData }, sign, progress), false)
  }
  sending(r, amount, String(amount - fee))
  const hash = await burnFromEvm(from, burn, hookData, (id) => {
    r.batch = id
    save()
  })
  sent(s, leg, r, hash, false)
}

// Approval and burn in one batch where the wallet can (batch: the wallet's id for it), else one after the other.
async function burnFromEvm(from: EvmChain & { usdc: Hex }, burn: Burn, hookData: Hex | undefined, batch: (id: string) => void) {
  if (!wallet.address) throw new Error('Connect your EVM wallet, then retry.')
  if ((await atomicSupport(from.chainId)) !== 'none') {
    progress(`Switching to ${from.name}…`)
    await switchChain(from)
    const spender = tokenMessengerOf(from)
    if (BigInt(await call(from.usdc, encode.allowance(wallet.address, spender))) < burn.amount) {
      try {
        return await sendCalls(from, [{ to: from.usdc, data: encode.approve(spender, burn.amount) }, burnCall(from, burn, hookData)], progress, batch)
      } catch (err) {
        if (!(err instanceof BatchUnavailable)) throw err
      }
    }
  }
  return burnOnEvm(from, burn, hookData, progress)
}

// The INJ is bought for the wallet that signs, from USDC it holds on Injective: the transfers there have landed by now,
// though the balance can take a few seconds to show it.
async function runGetInj(s: Session, leg: Leg, r: LegRun) {
  const owner = await senderOf(s, injective(), leg)
  // Gas for the destination is the recipient's; a refuel is for the user's own account, which sends from Injective next.
  if (leg.purpose !== 'refuel' && owner !== s.recipient.toLowerCase()) throw new Error('Get INJ swaps for the wallet that signs it, and the USDC went to another address. Skip this one.')
  const amount = BigInt(leg.amount)
  for (let tries = 0; ; tries++) {
    progress('Checking your USDC on Injective…')
    const balance = await readBalance(injective(), owner, injective().usdc).catch(() => undefined)
    r.held = balance === undefined ? undefined : String(balance)
    if (balance !== undefined && balance >= amount) break
    if (tries >= 4) throw new Error(`There isn't ${formatUsdc(amount)} USDC on Injective yet. Retry once it has arrived.`)
    await sleep(3000)
  }
  sending(r, amount)
  const result = await getInj(amount, progress)
  // An order that didn't fill buys nothing, and the server sends the USDC back.
  if (!(Number(result.inj) > 0)) throw new Error('Get INJ didn’t fill, so your USDC was sent back. Retry, or skip it.')
  Object.assign(r, { status: 'done', out: result.inj, txHash: result.txHash ?? undefined })
}

// ---- Following sent legs -----------------------------------------------------------------------------

// Whether a transaction went through, asked of the chain itself (the wallet may be on another chain by now): undefined
// while that's not known yet, 'gone' once it can't land anymore. A Solana transaction can't once its blockhash expired
// (about a minute); elsewhere, one the chain still doesn't know a quarter of an hour on was dropped, or replaced in the
// wallet (sped up or cancelled).
async function outcome(chain: Chain, hash: string, since = Date.now()): Promise<boolean | 'gone' | undefined> {
  const late = Date.now() - since > 15 * 60_000
  if (chain.kind === 'cosmos') {
    const { status } = await cosmosTxStatus(chain.id, hash)
    return status !== 'pending' ? status === 'success' : late ? 'gone' : undefined
  }
  if (chain.kind === 'solana') {
    // Nodes keep only the last few minutes of statuses at hand, unless asked to search their history.
    const { value } = await solanaRpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[hash], { searchTransactionHistory: true }])
    const status = value[0]
    if (status) return status.err ? false : status.confirmationStatus !== 'processed' || undefined
    return Date.now() - since > 3 * 60_000 ? 'gone' : undefined
  }
  if (chain.kind !== 'evm' || !chain.rpc) return true
  const receipt = await rpc<{ status: string } | null>(chain.rpc, 'eth_getTransactionReceipt', [hash])
  if (receipt) return receipt.status === '0x1'
  return late && !(await rpc(chain.rpc, 'eth_getTransactionByHash', [hash])) ? 'gone' : undefined
}

// A transfer Recent no longer has (it keeps the last 30), asked of its bridge (of the server, for CCTP): true once it
// arrived, false if it failed, undefined while it's on its way.
async function arrival(leg: Leg, r: LegRun) {
  const [from, to] = [chainById(leg.from)!, chainById(leg.to)!]
  if (leg.kind === 'cctp') {
    const [transfer] = (await getTxTransfers(r.txHash!, from.domain)).transfers
    return transfer?.status === 'redeemed' || undefined
  }
  const [fromSide, toSide] = sidesOf(leg)
  const p = await getRouteStatus({ provider: leg.provider, txHash: r.txHash!, from: (fromSide ?? from).id, to: (toSide ?? to).id, track: r.track ?? {} })
  if (p.status === 'done') r.out = p.amountOut ?? r.out
  return p.status === 'done' ? true : p.status === 'pending' ? undefined : false
}

// What became of a sent leg: the batch it went in, once the wallet reports it; its transaction, a swap's or a transfer's
// until it confirms (then Recent follows the transfer); a transfer Recent has lost; or a transaction that never landed.
async function check(s: Session, leg: Leg, r: LegRun, item?: Recent) {
  const chain = chainById(leg.from)!
  const age = Date.now() - (r.at ?? 0)
  if (!r.txHash) {
    let hash: string | undefined
    try {
      const result = batchResult(await batchStatus(r.batch ?? ''))
      if (result === 'pending') return void (age > 30 * 60_000 && failed(s, r, new Unsure('Your wallet hasn’t said what became of the batch.')))
      hash = result
    } catch (err) {
      return failed(s, r, err)
    }
    if (hash) return record(leg, r, hash, true)
    if (leg.kind === 'swap') return void (r.status = 'done')
    // Through, but the wallet hasn't said in which transaction, which a transfer is followed by: it may say a bit later.
    if (age > 5 * 60_000) failed(s, r, new Unsure('Your wallet says the batch went through, but not in which transaction.'))
    return
  }
  if (r.recentKey && !item) {
    const arrived = await arrival(leg, r)
    if (arrived !== undefined) Object.assign(r, arrived ? { status: 'done' } : { status: 'failed', error: 'The transfer failed.' })
    return
  }
  // A transfer whose transaction confirmed is Recent's to follow (a Solana one is watched a while: it can still be dropped).
  if (item && item.status !== 'confirming' && (chain.kind !== 'solana' || age > 10 * 60_000)) return
  const [fromSide] = sidesOf(leg)
  const ok = await outcome(fromSide ?? chain, r.txHash, r.at)
  if (ok === undefined) return
  if (ok === true) {
    if (!item) r.status = 'done'
    else if (item.status === 'confirming') {
      sentRecent(item)
      void refresh(item)
    }
    return
  }
  const note = ok === 'gone' ? `It didn’t go through on ${chain.name}: dropped, or replaced in your wallet.` : `The transaction failed on ${chain.name}.`
  if (item) failRecent(item, note)
  if (ok === 'gone') failed(s, r, new Unsure(note))
  else Object.assign(r, { status: 'failed', error: note })
}

// Sent legs are done once they arrive: transfers as Recent reports them, swaps when their transaction confirms. What isn't
// known yet is asked again: every few seconds while a transaction confirms, now and then while a transfer is on its way.
const checked = new Map<string, number>()
async function track(s: Session) {
  for (const leg of s.plan.legs) {
    const r = s.legs[leg.id]
    if (r?.status !== 'sent') continue
    const item = r.recentKey ? recent.find((x) => x.txHash === r.recentKey) : undefined
    if (item?.status === 'redeemed') {
      Object.assign(r, { status: 'done', out: item.route?.received ?? r.out })
      continue
    }
    if (item?.status === 'failed' || item?.status === 'restricted') {
      Object.assign(r, { status: 'failed', error: item.note ?? 'The transfer failed.' })
      continue
    }
    const quick = !r.txHash || !r.recentKey || item?.status === 'confirming'
    if (Date.now() - (checked.get(leg.id) ?? 0) < (quick ? 4000 : 30_000)) continue
    checked.set(leg.id, Date.now())
    await check(s, leg, r, item).catch(() => {}) // no answer: asked again later
  }
  save()
}

// While no run is going, sent legs are still followed (by the tab that would run it).
let watching = false
async function watch() {
  if (watching) return
  watching = true
  try {
    while (onboard.session && Object.values(onboard.session.legs).some((r) => r.status === 'sent')) {
      if (!onboard.running && !onboard.elsewhere && app.config) await track(onboard.session)
      await sleep(3000)
    }
  } finally {
    watching = false
  }
}

// A run left from before (a reload, another tab) is taken up once this tab can hold it.
if (onboard.session) {
  synced = parts(onboard.session)
  void claim()
}
