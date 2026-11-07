import { resolveChain, sameAddress, SOL, type ChainInfo } from './chains'
import { stableOf } from './stables'
import { catalog, gasToken } from './tokens'

// Market prices, for what the token lists don't price or price stale (they're kept 6 hours): DefiLlama's, keyless, for any
// chain it knows, and Injective's own price service for its bank denoms. Each is kept 5 minutes. A price the source last
// updated over an hour ago is left out unless asked for (maxAge): long-tail ones often are, and an old price is how a dead
// token keeps looking valuable.

const KEEP = 5 * 60_000
const FRESH = 3600_000

// DefiLlama's name for a chain where it isn't the registry's id; null where it has none.
const LLAMA: Record<string, string | null> = {
  avalanche: 'avax', worldchain: 'wc', bnb: 'bsc', gnosis: 'xdai', hyperevm: 'hyperliquid', 'flow-evm': 'flow', 'manta-pacific': 'manta', rootstock: 'rsk',
  'arbitrum-nova': 'arbitrum_nova', 'boba-network': 'boba', 'conflux-espace': 'conflux', 'immutable-zkevm': 'imx', kaia: 'klaytn', story: 'sty', viction: 'tomochain',
  zksync: 'era', 'polygon-zkevm': 'polygon_zkevm', cosmoshub: 'cosmos', 'injective-cosmos': 'injective',
  codex: null, edge: null, 'robinhood-chain': null, doma: null, ethereal: null, forma: null, gensyn: null, mythos: null,
}

// A token's DefiLlama key: <chain>:<address> on EVM chains (the gas token is 0x000…000 there too), solana:<mint>, and for
// Cosmos denoms ibc:<hash> or <chain>:<denom> (factory/… and other path-like denoms aren't found).
export function llamaKey(chain: ChainInfo, address: string): string | undefined {
  const name = chain.id in LLAMA ? LLAMA[chain.id] : chain.id
  if (chain.kind === 'solana') return address === SOL ? 'coingecko:solana' : `solana:${address}`
  if (!name) return
  if (address.startsWith('ibc/')) return `ibc:${address.slice(4)}`
  if ((chain.kind === 'evm' || chain.kind === 'cosmos') && !address.includes('/')) return `${name}:${address}` // Injective's peggy0x… and inj too
}

// URLs stay under ~7 kB: DefiLlama answers 414 past ~8 kB (about 150 keys).
function chunks(keys: string[]) {
  const out: string[][] = []
  let size = 0
  for (const key of keys) {
    if (!out.length || size + key.length + 1 > 7000) {
      out.push([])
      size = 0
    }
    out.at(-1)!.push(key)
    size += key.length + 1
  }
  return out
}

const llama = new Map<string, { at: number; price: Promise<{ price: number; at: number } | undefined> }>()
// Prices in USD by key, for the keys DefiLlama priced in the last maxAge.
export async function llamaPrices(keys: string[], maxAge = FRESH): Promise<Map<string, number>> {
  const now = Date.now()
  if (llama.size > 20_000) for (const [k, v] of llama) if (now - v.at > KEEP) llama.delete(k)
  const asked = [...new Set(keys)].filter((k) => /^[\w\-.:]{3,200}$/.test(k))
  const missing = asked.filter((k) => !llama.has(k) || now - llama.get(k)!.at > KEEP)
  for (const chunk of chunks(missing)) {
    type Coins = { coins: Record<string, { price?: number; timestamp?: number }> }
    const answer = fetch(`https://coins.llama.fi/prices/current/${chunk.join(',')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? (r.json() as Promise<Coins>) : Promise.reject(new Error(`DefiLlama: ${r.status}`))))
      .then(({ coins }) => new Map(Object.entries(coins).flatMap(([k, c]) => (c.price && c.price > 0 ? [[k.toLowerCase(), { price: c.price, at: (c.timestamp ?? 0) * 1000 }]] : []))))
    for (const key of chunk) {
      const entry = { at: now, price: answer.then((m) => m.get(key.toLowerCase())) }
      llama.set(key, entry)
      // A failed answer is asked again next time.
      entry.price.catch(() => llama.get(key) === entry && llama.delete(key))
    }
  }
  const out = new Map<string, number>()
  await Promise.all(asked.map(async (k) => {
    const p = await llama.get(k)?.price.catch(() => undefined)
    if (p && Date.now() - p.at < maxAge) out.set(k, p.price)
  }))
  return out
}

// Injective's price service: every bank denom it lists (343 in Nov 2026), from CoinGecko, with its market cap, the token's
// symbol, name and decimals, and whether Injective verified it. Those priced in the last maxAge.
export type InjectivePrice = { price: number; at: number; mcap?: number; symbol: string; name: string; decimals: number; logo?: string; verified: boolean }
let injective: { at: number; prices: Promise<Map<string, InjectivePrice>> } | undefined
export async function injectivePrices(maxAge = FRESH): Promise<Map<string, InjectivePrice>> {
  if (!injective || Date.now() - injective.at > KEEP) {
    type Denom = { denom: string; symbol?: string; name?: string; decimals?: number; logo?: string; token_verification?: string; price?: { price?: number; timestamp?: number; market_cap?: number } | null }
    const prices = fetch('https://k8s.mainnet.asset.injective.network/asset-price/v1/denoms?withPrice=true', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, Denom>>) : Promise.reject(new Error(`Injective prices: ${r.status}`))))
      .then((all) => new Map(Object.values(all).flatMap((d) => {
        const p = d.price
        if (!p?.price || !(p.price > 0)) return []
        const verified = d.token_verification === 'verified' && !!d.symbol && Number.isInteger(d.decimals)
        return [[d.denom, { price: p.price, at: p.timestamp ?? 0, mcap: p.market_cap || undefined, symbol: d.symbol ?? '', name: d.name || d.symbol || '', decimals: d.decimals ?? 0, logo: d.logo || undefined, verified }] as const]
      })))
    const entry = { at: Date.now(), prices }
    injective = entry
    prices.catch((err) => {
      console.warn(`[prices] ${(err as Error).message}`)
      if (injective === entry) injective = undefined
    })
  }
  const prices = await injective.prices
  return new Map([...prices].filter(([, p]) => Date.now() - p.at < maxAge))
}

// The market's price where it has a fresh one, else the list's. When the two are more than 3× apart, the lower: one of
// them is wrong, and overvaluing is the worse mistake.
export function pickPrice(market?: number, list?: number): { price: number; source: 'market' | 'list' } | undefined {
  if (market && list) return market / list > 3 || list / market > 3 ? (market < list ? { price: market, source: 'market' } : { price: list, source: 'list' }) : { price: market, source: 'market' }
  if (market) return { price: market, source: 'market' }
  if (list) return { price: list, source: 'list' }
}

// The price of a chain's gas token in USD: the market's, else its list's, else by symbol (ETH from Ethereum's). 1 where
// gas is a canonical stablecoin (Arc's USDC, Stable's USDT0, Noble's USDC); none on Tempo, which has no gas token. pick
// weighs market against list (../safety.ts weighs them its own way for its fee cap).
export async function nativePrice(id: string, pick = pickPrice): Promise<number | undefined> {
  const chain = resolveChain(id)
  const gas = chain && (chain.kind === 'cosmos' ? (chain.gas?.denom ?? chain.native?.address) : gasToken(chain))
  if (!chain || !gas) return
  if (stableOf(chain.id, gas)) return 1
  const entry = (await catalog(chain)).find((t) => sameAddress(t.address, gas))
  // The chain's own key first: the CoinGecko id comes from a token list (Skip's), which a provider could get wrong.
  const keys = [llamaKey(chain, gas), entry?.coingeckoId ? `coingecko:${entry.coingeckoId}` : undefined].filter((k): k is string => !!k)
  const market = await llamaPrices(keys).catch(() => new Map<string, number>())
  const price = pick(keys.map((k) => market.get(k)).find(Boolean), entry?.priceUsd)?.price
  if (price) return price
  if (chain.id !== 'ethereum' && ['ETH', 'WETH'].includes(entry?.symbol ?? chain.native?.symbol ?? '')) return nativePrice('ethereum', pick)
}
