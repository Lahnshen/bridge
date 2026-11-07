import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem'
import { HttpError, within } from './cctp'
import { addressOnSide, allChains, chainById, evmClient, NATIVE, ready, sameAddress, SOL, USDT0_MESH, validAddress, type ChainInfo } from './chains'
import { rpcEnv } from './config'
import { injectivePrices, llamaKey, llamaPrices, nativePrice, pickPrice, type InjectivePrice } from './prices'
import { solanaRpc, TOKEN_PROGRAMS } from './solana'
import { stableOf, type StableKind } from './stables'
import { catalog, gasToken, publicToken, tokenBalance, tokenPairs, type Entry, type Token } from './tokens'

// A wallet's holdings with their USD values, chain by chain (POST /holdings), for consolidating them somewhere. Only listed
// tokens are read, never ones found in the wallet's history: that's how airdropped scam tokens stay out. EVM chains are
// read with Multicall3 (one eth_call per few hundred tokens), Injective from its bank (every token on both its sides),
// Solana from its token accounts, Cosmos chains from their banks, and Hyperliquid's sendable USDC. Each chain's answer
// for an address is kept 45 seconds, unless the body asks for a fresh read (fresh: after a run, or the Rescan button).

export type Holding = {
  token: Token
  raw: string // base units held
  usd?: number // estimated value, when priced
  price?: number
  source?: 'stable' | 'list' | 'market' | 'symbol' // the price's, when priced: a canonical stable at $1, the token list, DefiLlama or Injective's price service, or the symbol
  native?: boolean // the chain's gas token: always listed when there's any, for gas checks
  stable?: StableKind // one of the chain's canonical stables (./stables.ts)
  illiquid?: boolean // worth over 2% of the token's market cap, or more than a day of its trading: unlikely to sell for that
  unsupported?: boolean // not in the bridges' lists (Injective's FET and SAGA): shown for its value, but it can't be moved
}
export type ChainHoldings = { chain: string; holdings: Holding[]; error?: string }
export type HoldingsBody = { evm?: string; solana?: string; cosmos?: Record<string, string>; chains?: string[]; fresh?: boolean }

// The Cosmos chains scanned for a Keplr wallet: the ones most people hold funds on.
export const SCAN_COSMOS = ['osmosis', 'cosmoshub', 'noble', 'celestia', 'dydx', 'neutron', 'stride', 'akash']

// Multicall3 is at its usual address on nearly every chain. These have their own (LI.FI's /chains lists them); Forma has
// none, Gravity's public RPC didn't answer and Ethereal's says "RPC disabled" (Nov 2026).
const MULTICALL3: Hex = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL: Record<number, Hex | null> = {
  50: '0x0b1795cca8e4ec4df02346a082df54d437f8d9af', // XDC
  5031: '0x5e44F178E8cF9B2F5409B6f18ce936aB817C5a11', // Somnia
  1480: '0xD8d2dFca27E8797fd779F8547166A2d3B29d360E', // Vana
  984122: null, // Forma
  1625: null, // Gravity
  5064014: null, // Ethereal
}
const multicallOn = (chain: ChainInfo) => (chain.chainId ? (MULTICALL[chain.chainId] === undefined ? MULTICALL3 : MULTICALL[chain.chainId])?.toLowerCase() as Hex | undefined : undefined)

// What an EVM wallet, a Solana wallet and a Keplr wallet are scanned on. EVM: every EVM chain the app sends from that
// Multicall3 can read, and Injective (read from its bank). Hyperliquid is scanned for the EVM wallet too.
export function scanChains() {
  return {
    evm: allChains().filter((c) => c.kind === 'evm' && (!!c.cosmosSide || !!multicallOn(c))).map((c) => c.id),
    cosmos: SCAN_COSMOS.filter((id) => chainById(id)?.kind === 'cosmos'),
    solana: !!chainById('solana'),
    hyperliquid: chainById('hyperliquid')?.kind === 'hypercore',
  }
}

export async function holdings(body: HoldingsBody): Promise<{ chains: ChainHoldings[] }> {
  // The bridges' chain lists, after a restart (each list waits 30 s at most): without them most chains would be missed.
  await ready
  const scan = scanChains()
  const evm = body.evm
  if (evm !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new HttpError(400, 'Invalid address.')
  const sol = chainById('solana')
  if (body.solana !== undefined && (!sol || !validAddress(sol, body.solana))) throw new HttpError(400, 'Invalid address.')

  const cosmos = Object.entries(body.cosmos ?? {}).map(([id, address]) => {
    const chain = chainById(id)?.cosmosSide ? chainById(chainById(id)!.cosmosSide!) : chainById(id)
    if (!chain || chain.kind !== 'cosmos' || !validAddress(chain, address)) throw new HttpError(400, 'Invalid address.')
    return { chain, address }
  })

  const jobs: { chain: ChainInfo; address: string; read: () => Promise<Scan> }[] = []
  const add = (chain: ChainInfo | undefined, address: string, read: (chain: ChainInfo) => Promise<Scan>) => chain && jobs.push({ chain, address, read: () => read(chain) })
  for (const id of evm ? scan.evm : []) {
    const chain = chainById(id)
    // Injective is read once, from its bank (every token of both its sides): as the EVM wallet's inj1… account, else as
    // the Keplr wallet's. With both, the EVM wallet's: the planner moves Injective's holdings for that account only.
    const side = chain?.cosmosSide ? chainById(chain.cosmosSide) : undefined
    if (side) add(chain, evm!, (c) => scanInjective(c, side, evm!))
    else add(chain, evm!, (c) => scanEvm(c, evm as Hex))
  }
  if (evm && scan.hyperliquid) add(chainById('hyperliquid'), evm, (c) => scanHyperliquid(c, evm))
  if (body.solana) add(sol, body.solana, (c) => scanSolana(c, body.solana!))
  for (const { chain, address } of cosmos) {
    const injective = chain.sideOf ? chainById(chain.sideOf) : undefined
    if (injective && !evm) add(injective, address, (c) => scanInjective(c, chain, address))
    else if (scan.cosmos.includes(chain.id)) add(chain, address, (c) => scanCosmos(c, address))
  }

  const wanted = body.chains && new Set(body.chains)
  const chains = await each(wanted ? jobs.filter((j) => wanted.has(j.chain.id)) : jobs, 8, async ({ chain, address, read }): Promise<ChainHoldings> => {
    try {
      const { holdings, error } = await within(cached(chain, address, read, body.fresh), 15_000, new HttpError(504, `${chain.name} took too long to answer.`))
      return { chain: chain.id, holdings, ...(error ? { error } : {}) }
    } catch (err) {
      return { chain: chain.id, holdings: [], error: err instanceof HttpError ? err.message : `Could not read ${chain.name}.` }
    }
  })
  return { chains }
}

type Scan = { holdings: Holding[]; error?: string }

// Each chain's answer for an address, kept 45 seconds; a failed one isn't kept. A fresh read is asked for after balances
// changed, so it only takes an answer started in the last few seconds.
const scans = new Map<string, { at: number; scan: Promise<Scan> }>()
setInterval(() => {
  for (const [key, hit] of scans) if (Date.now() - hit.at > 45_000) scans.delete(key)
}, 60_000).unref()
function cached(chain: ChainInfo, address: string, read: () => Promise<Scan>, fresh = false) {
  const key = `${chain.id}:${address.startsWith('0x') ? address.toLowerCase() : address}`
  const hit = scans.get(key)
  if (hit && Date.now() - hit.at < (fresh ? 5000 : 45_000)) return hit.scan
  const entry = { at: Date.now(), scan: read() }
  scans.set(key, entry)
  entry.scan.catch(() => scans.get(key) === entry && scans.delete(key))
  return entry.scan
}

// At most n jobs at a time, answers in the jobs' order.
async function each<T, R>(items: T[], n: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await job(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

// ---- Values --------------------------------------------------------------------------------------------

type Found = { token: Entry; raw: bigint; native?: boolean; market?: number; mcap?: number; unsupported?: boolean }

// Stablecoin symbols. A token named like one but priced far from $1 is a look-alike or broken (LI.FI has priced fakes at
// 2.7e20), so it's left unpriced. The chain's canonical stables are $1 whatever the lists say.
const DOLLAR = /^(usdc|usdt|usdt0|usd₮|usd₮0|usdc\.e|usdce|usdt\.e|usdbc|dai|usds|usde|pyusd|fdusd|usdg|usd1|tusd|busd|lusd|gho|crvusd|frxusd|ausd|rlusd|usdh)$/i
const ETHER = /^w?eth$/i
// A dollar stablecoin's symbol, bridged copies' too (USDC.eth.axl).
const isDollar = (symbol: string) => DOLLAR.test(symbol.split('.')[0]!)
const DAY = 24 * 3600_000
// A market price: a fresh one, else for a dollar stablecoin one up to a day old at about $1. Their prices barely move, so
// the sources update little-traded copies rarely.
const marketPrice = (symbol: string, fresh?: number, old?: number) => fresh ?? (old && isDollar(symbol) && old >= 0.98 && old <= 1.02 ? old : undefined)

// Prices: a canonical stable at $1; else the market's (DefiLlama, or what the scan brought, like Injective's price service)
// unless it's far from the list's (see pickPrice); else, on EVM chains whose list has no prices, by symbol (ETH, stables).
async function value(chain: ChainInfo, found: Found[]): Promise<Holding[]> {
  const keys = found.map(({ token: t, market }) => {
    if (market || stableOf(chain.id, t.address)) return []
    const key = llamaKey(chain, t.address)
    return [...(t.coingeckoId ? [`coingecko:${t.coingeckoId}`] : []), ...(key ? [key] : [])]
  })
  const dollars = found.flatMap((f, i) => (isDollar(f.token.symbol) ? keys[i]! : []))
  const none = () => new Map<string, number>()
  const [market, old] = await Promise.all([llamaPrices(keys.flat()).catch(none), llamaPrices(dollars, DAY).catch(none)])
  const bySymbol = chain.tokens !== 'lifi' && chain.kind === 'evm'
  const ether = bySymbol && found.some((f) => ETHER.test(f.token.symbol)) ? await nativePrice('ethereum').catch(() => undefined) : undefined
  const list = found.map((f, i): Holding => {
    const t = f.token
    const stable = stableOf(chain.id, t.address)
    const first = (prices: Map<string, number>) => keys[i]!.map((k) => prices.get(k)).find(Boolean)
    let priced: { price: number; source: NonNullable<Holding['source']> } | undefined = stable
      ? { price: 1, source: 'stable' }
      : pickPrice(f.market ?? marketPrice(t.symbol, first(market), first(old)), t.priceUsd)
    if (!priced && bySymbol && t.verified) priced = DOLLAR.test(t.symbol) ? { price: 1, source: 'symbol' } : ETHER.test(t.symbol) && ether ? { price: ether, source: 'symbol' } : undefined
    // Osmosis's alloyed stables pool several bridged copies of USDC or USDT; no market prices them.
    if (!priced && /\/alloyed\/all(usdc|usdt)$/i.test(t.address)) priced = { price: 1, source: 'symbol' }
    if (priced && !stable && isDollar(t.symbol) && (priced.price < 0.8 || priced.price > 1.2)) priced = undefined
    let usd = priced && (Number(f.raw) / 10 ** t.decimals) * priced.price
    if (usd !== undefined && !(usd < 1e10)) [usd, priced] = [undefined, undefined]
    const mcap = f.mcap ?? t.mcap
    const illiquid = !stable && usd !== undefined && usd >= 1 && ((!!mcap && usd > 0.02 * mcap) || (t.vol !== undefined && usd > t.vol))
    return {
      token: publicToken(t),
      raw: f.raw.toString(),
      ...(usd !== undefined ? { usd: Math.round(usd * 1e6) / 1e6, price: priced!.price, source: priced!.source } : {}),
      ...(f.native ? { native: true } : {}),
      ...(stable ? { stable } : {}),
      ...(illiquid ? { illiquid: true } : {}),
      ...(f.unsupported ? { unsupported: true } : {}),
    }
  })
  // The most valuable first, at most 200 a chain, and the gas token whatever its value.
  list.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
  return list.filter((h, i) => i < 200 || h.native)
}

// ---- EVM chains ----------------------------------------------------------------------------------------

const ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
])
// Calls per eth_call. Gas caps and per-call costs differ: HyperEVM caps eth_call at 30M gas, Sei at 12.5M, a balanceOf
// costs ~46k gas on Monad (~11k elsewhere), and Avalanche's public RPC answers 429 to big bursts.
const CHUNK: Record<number, number> = { 143: 250, 999: 600, 1329: 120, 43114: 300 }
// Tokens whose balanceOf reverts or burns all the gas it's given, which sinks every batch they're in: Sei's SEIYAN, and
// any the scan finds (until restart).
const denied = new Map<number, Set<string>>([[1329, new Set(['0x5f0e07dfee5832faa00c63f2d33a0d79150e8598'])]])
// Metis's gas token also answers as an ERC20 here, with the same balance: it's read once, as the gas token.
const METIS_ALIAS = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000'

// What's read on an EVM chain: the basics (its gas token, CCTP USDC, USDT0 and canonical stables), and the listed tokens
// that trade: priced, with $1k of daily volume or a $1M market cap (with LI.FI's lists that's ~5.5k of ~25k tokens, and
// ~98% of what people hold). Lists other than LI.FI's have no market data, so there it's their verified tokens.
const sets = new WeakMap<Entry[], Entry[]>()
function scanSet(chain: ChainInfo, list: Entry[]) {
  let set = sets.get(list)
  if (!set) {
    const gas = gasToken(chain)
    const usdt0 = chain.chainId ? USDT0_MESH[chain.chainId]?.token : undefined
    const basic = (t: Entry) => [gas, chain.usdc, usdt0].some((a) => a && sameAddress(a, t.address)) || !!stableOf(chain.id, t.address)
    const trades = (t: Entry) => (t.priceUsd ?? 0) > 0 && ((t.vol ?? 0) >= 1000 || (t.mcap ?? 0) >= 1e6)
    set = list.filter(
      (t) =>
        /^0x[0-9a-fA-F]{40}$/.test(t.address) &&
        t.address.toLowerCase() !== METIS_ALIAS &&
        (!sameAddress(t.address, NATIVE) || gas === NATIVE) &&
        (basic(t) || (chain.tokens === 'lifi' ? trades(t) : t.verified)),
    )
    sets.set(list, set)
  }
  const deny = denied.get(chain.chainId!)
  return deny ? set.filter((t) => !deny.has(t.address.toLowerCase())) : set
}

type Call = { target: Hex; callData: Hex }
type Reading = { chain: ChainInfo; client: PublicClient; multicall: Hex; budget: number; failed: number; error?: string }

async function scanEvm(chain: ChainInfo, owner: Hex): Promise<Scan> {
  const client = evmClient(chain)
  const multicall = multicallOn(chain)
  if (!client || !multicall) throw new HttpError(400, `Balances aren't available on ${chain.name}.`)
  const tokens = scanSet(chain, await catalog(chain))
  const gas = gasToken(chain)
  const ethBalance = encodeFunctionData({ abi: ABI, functionName: 'getEthBalance', args: [owner] })
  const balanceOf: Hex = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, '0')}`
  const calls = tokens.map((t): Call => (sameAddress(t.address, NATIVE) ? { target: multicall, callData: ethBalance } : { target: t.address.toLowerCase() as Hex, callData: balanceOf }))
  const size = CHUNK[chain.chainId!] ?? 400
  const starts = Array.from({ length: Math.ceil(calls.length / size) }, (_, i) => i * size)
  const reading: Reading = { chain, client, multicall, budget: 24 + 2 * starts.length, failed: 0 }
  const amounts: (bigint | undefined)[] = []
  await each(starts, 3, async (start) => {
    const got = await read(reading, calls.slice(start, start + size))
    got.forEach((amount, i) => (amounts[start + i] = amount))
  })
  if (reading.failed) console.warn(`[holdings] ${chain.id}: ${reading.failed} of ${calls.length} balances unread (${reading.error})`)
  if (calls.length && reading.failed === calls.length) throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  const found = tokens.flatMap((t, i) => (amounts[i] ? [{ token: t, raw: amounts[i]!, native: !!gas && sameAddress(t.address, gas) }] : []))
  return { holdings: await value(chain, found), ...(reading.failed ? { error: `Some balances on ${chain.name} couldn't be read.` } : {}) }
}

// One aggregate3. A batch that fails is split in two, and each half asked again: a token whose balanceOf reverts or eats
// the gas cap ends up alone, and is left out from then on. A busy or failing RPC (429s, timeouts, HTML) gets a second's
// rest and one more try, in halves. Balances that can't be read are undefined. retried: this is that try.
async function read(r: Reading, calls: Call[], retried = false): Promise<(bigint | undefined)[]> {
  const none = () => calls.map(() => undefined)
  if (r.budget-- <= 0) return (r.failed += calls.length), none()
  try {
    const data = encodeFunctionData({ abi: ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ ...c, allowFailure: true }))] })
    const result = await r.client.call({ to: r.multicall, data })
    const out = decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: result.data ?? '0x' })
    return out.map((o) => (o.success && o.returnData.length >= 66 ? BigInt(o.returnData.slice(0, 66)) : undefined))
  } catch (err) {
    const reverted = /revert|out of gas|gas required exceeds|gas limit/i.test((err as Error).message)
    if (calls.length === 1 && reverted && calls[0]!.target !== r.multicall) {
      const deny = denied.get(r.chain.chainId!) ?? new Set()
      denied.set(r.chain.chainId!, deny.add(calls[0]!.target))
      console.warn(`[holdings] ${r.chain.id}: leaving out ${calls[0]!.target}, its balanceOf fails`)
      return none()
    }
    if (calls.length === 1 || (!reverted && retried)) {
      r.error ??= ((err as { shortMessage?: string }).shortMessage ?? (err as Error).message).slice(0, 120)
      r.failed += calls.length
      return none()
    }
    const half = Math.ceil(calls.length / 2)
    if (reverted) return (await Promise.all([read(r, calls.slice(0, half), retried), read(r, calls.slice(half), retried)])).flat()
    // One after the other, so a rate-limited RPC isn't hit by both at once.
    await Bun.sleep(1500)
    return [...(await read(r, calls.slice(0, half), true)), ...(await read(r, calls.slice(half), true))]
  }
}

// ---- Cosmos banks (Injective and the Cosmos chains) ---------------------------------------------------------

// REST_<ID> first, then Injective's own LCD, which answers far more than cosmos.directory's proxy (429 after a dozen quick
// requests there), then the chain's usual endpoint.
const OWN_REST: Record<string, string> = { 'injective-cosmos': 'https://sentry.lcd.injective.network' }
const restUrls = (chain: ChainInfo) => [
  ...(process.env[rpcEnv(chain.id).replace(/^RPC_/, 'REST_')]?.split(',').map((u) => u.trim()).filter(Boolean) ?? []),
  ...(OWN_REST[chain.id] ? [OWN_REST[chain.id]!] : []),
  ...(chain.rest ? [chain.rest] : []),
]
async function bank(chain: ChainInfo, address: string): Promise<{ denom: string; amount: string }[]> {
  for (const url of restUrls(chain)) {
    const res = await fetch(`${url}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=1000`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
    const body = res?.ok ? ((await res.json().catch(() => undefined)) as { balances?: { denom: string; amount: string }[] } | undefined) : undefined
    if (body?.balances) return body.balances
  }
  throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
}
const amountOf = (value: string) => (/^\d{1,78}$/.test(value) ? BigInt(value) : 0n)

// Injective's bank has every token of both sides: inj, peggy0x…, ibc/…, factory/… and the erc20:0x… ones (CCTP USDC among
// them), with the same balances the EVM side reports. Each goes by its ERC20 twin's address where it has one, as
// Injective's list does, so the EVM side isn't read as well (that would count them twice). Priced by Injective's price
// service first.
async function scanInjective(chain: ChainInfo, side: ChainInfo, owner: string): Promise<Scan> {
  const none = () => new Map<string, InjectivePrice>()
  const [balances, list, pairs, fresh, old] = await Promise.all([
    bank(side, addressOnSide(owner, side)),
    catalog(chain),
    tokenPairs(side).catch(() => ({ erc20: new Map<string, string>(), denom: new Map<string, string>() })),
    injectivePrices().catch(none),
    injectivePrices(DAY).catch(none),
  ])
  const found = balances.flatMap(({ denom, amount }): Found[] => {
    const raw = amountOf(amount)
    const address = denom === side.native?.address ? NATIVE : (pairs.erc20.get(denom) ?? denom)
    const listed = list.find((t) => sameAddress(t.address, address))
    const p = old.get(denom)
    const market = p && marketPrice(p.symbol, fresh.get(denom)?.price, p.price)
    // A token Injective verified and prices but the bridges don't list (FET, SAGA): shown for its value, though it can't move.
    const token = listed ?? (p?.verified && market ? { chain: chain.id, address, symbol: p.symbol, name: p.name, decimals: p.decimals, logo: p.logo, verified: true } : undefined)
    if (!token || !raw) return []
    return [{ token, raw, native: address === NATIVE, market, mcap: p?.mcap, ...(listed ? {} : { unsupported: true }) }]
  })
  return { holdings: await value(chain, found) }
}

// A Cosmos chain's bank, less what its list (Skip's) doesn't have: LSM shares, unknown IBC denoms, random factory tokens.
async function scanCosmos(chain: ChainInfo, owner: string): Promise<Scan> {
  const [balances, list] = await Promise.all([bank(chain, owner), catalog(chain)])
  const gas = chain.gas?.denom ?? chain.native?.address // Noble's is USDC
  const found = balances.flatMap(({ denom, amount }): Found[] => {
    const token = list.find((t) => t.address === denom)
    const raw = amountOf(amount)
    return token && raw ? [{ token, raw, native: denom === gas }] : []
  })
  return { holdings: await value(chain, found) }
}

// ---- Solana and Hyperliquid -----------------------------------------------------------------------------

// The wallet's SOL and token accounts (Token and Token-2022), less the mints Solana's list (LI.FI's, without the ones it
// flags) and the canonical stables don't have: ~95% of the token accounts in real wallets are airdropped spam.
async function scanSolana(chain: ChainInfo, owner: string): Promise<Scan> {
  type Accounts = { value: { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] }
  const unreachable = () => {
    throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  }
  const [lamports, list, ...accounts] = await Promise.all([
    solanaRpc<{ value: number }>('getBalance', [owner]).catch(unreachable),
    catalog(chain),
    ...TOKEN_PROGRAMS.map((programId) => solanaRpc<Accounts>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]).catch(unreachable)),
  ])
  const byMint = new Map<string, bigint>()
  for (const { account } of accounts.flatMap((a) => a.value)) {
    const info = account.data.parsed?.info
    if (info?.mint) byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + amountOf(info.tokenAmount?.amount ?? '0'))
  }
  const listed = new Map(list.map((t) => [t.address, t]))
  const found: Found[] = [...byMint].flatMap(([mint, raw]) => (raw && listed.has(mint) ? [{ token: listed.get(mint)!, raw }] : []))
  const sol = listed.get(SOL)
  if (lamports.value > 0 && sol) found.push({ token: sol, raw: BigInt(lamports.value), native: true })
  return { holdings: await value(chain, found) }
}

// The USDC an account can send from Hyperliquid (see tokenBalance). No gas is paid there.
async function scanHyperliquid(chain: ChainInfo, owner: string): Promise<Scan> {
  const usdc = chain.native!
  const [{ raw }, list] = await Promise.all([tokenBalance(chain.id, owner, usdc.address), catalog(chain)])
  const token = list.find((t) => sameAddress(t.address, usdc.address)) ?? { chain: chain.id, ...usdc, verified: true }
  return { holdings: BigInt(raw) ? await value(chain, [{ token, raw: BigInt(raw) }]) : [] }
}
