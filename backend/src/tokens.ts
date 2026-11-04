import { erc20Abi, getAddress, isAddress, type Hex } from 'viem'
import { HttpError } from './cctp'
import { addressOnSide, chainById, evmClient, ready, HYPERLIQUID_API, NATIVE, resolveChain, sameAddress, SOL, USDT0_MESH, validAddress, type ChainInfo, type Source } from './chains'
import { cosmosBalance } from './cosmos'
import { publicKey, solanaRpc } from './solana'

// Tokens the bridge can send and receive, per chain. Each chain's list comes from one bridge's catalog: LI.FI's where it
// has the chain, else Skip's (Cosmos chains), Relay's, LayerZero's or deBridge's (see `tokens` in ../chains.ts). A list is
// loaded when first asked for and kept 6 hours, without the tokens LI.FI flags as scams. An EVM or Solana token outside
// the list can be found by its address, read from the chain. Injective's list has both its sides' tokens, each once (see
// sideTokens).

export type Token = {
  chain: string // chain id
  address: string // 0x…, a Solana mint, a Cosmos denom…; NATIVE / SOL / the denom for the gas token
  symbol: string
  name: string
  decimals: number
  logo?: string
  priceUsd?: number
  verified: boolean // listed as verified, or the chain's gas token, CCTP USDC or USDT0
}
type Listed = Omit<Token, 'chain'>

// Shown first, in this order. The chain's own gas token comes right after the stablecoins.
const POPULAR = ['USDC', 'USDT', 'USDT0', '$native', 'ETH', 'WETH', 'WBTC', 'cbBTC', 'BTC', 'DAI', 'INJ', 'SOL', 'ATOM']

const LIFI = 'https://li.quest/v1'
const env = process.env
const auth = (name: string, value?: string): Record<string, string> => (value ? { [name]: value } : {})
async function getList<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`)
  return res.json() as Promise<T>
}

type LifiToken = { address: string; symbol: string; name: string; decimals: number; logoURI?: string; priceUSD?: string; verificationStatus?: string }
type SkipAsset = {
  denom: string
  token_contract?: string
  symbol?: string
  recommended_symbol?: string
  name?: string
  decimals?: number
  logo_uri?: string
  origin_denom?: string
  origin_chain_id?: string
}
type RelayToken = { address: string; symbol: string; name: string; decimals: number; metadata?: { logoURI?: string; verified?: boolean } }
type LzToken = { chainKey: string; address: string; symbol: string; name: string; decimals: number; icon?: string; price?: { usd?: number } }
type DebridgeToken = { address: string; symbol: string; name: string; decimals: number; logoURI?: string }

const fromLifi = (t: LifiToken): Listed => ({
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
  logo: t.logoURI?.trim() || undefined, // some end in a newline
  priceUsd: t.priceUSD ? Number(t.priceUSD) : undefined,
  verified: t.verificationStatus === 'verified',
})

// LayerZero lists every chain's tokens in one answer.
let lzTokens: { at: number; list: Promise<LzToken[]> } | undefined
const layerzeroTokens = () => {
  if (!lzTokens || Date.now() - lzTokens.at > 6 * 3600_000) {
    const list = getList<{ tokens: LzToken[] }>('https://transfer.layerzero-api.com/v1/tokens').then((r) => r.tokens)
    lzTokens = { at: Date.now(), list }
    list.catch(() => (lzTokens = undefined))
  }
  return lzTokens.list
}

// Skip names bridged copies after their way in ("USDC.axl", "USDC.n"). USDC is the USDC Circle issues on the chain: Noble's
// own, Injective's (its CCTP USDC, as a bank denom), else Noble's, Circle's USDC for the Cosmos chains. Osmosis's
// alloyed tokens, which pool several copies, are "allUSDC" and "allUSDT".
const OWN_USDC: Record<string, string> = { 'noble-1': 'uusdc', 'injective-1': 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a' }
function skipSymbol(a: SkipAsset, chainId: string) {
  const symbol = a.recommended_symbol || a.symbol || ''
  if (a.origin_denom?.includes('/alloyed/')) return a.origin_denom.split('/').at(-1)!
  if (OWN_USDC[chainId]) return a.denom === OWN_USDC[chainId] ? 'USDC' : symbol
  return a.origin_chain_id === 'noble-1' && a.origin_denom === 'uusdc' ? 'USDC' : symbol
}

const LOADERS: Record<Exclude<Source, 'across' | 'usdt0'>, (chain: ChainInfo) => Promise<Listed[]>> = {
  lifi: async (chain) => {
    const id = String(chain.ids.lifi)
    const { tokens } = await getList<{ tokens: Record<string, LifiToken[]> }>(`${LIFI}/tokens?chains=${id}&chainTypes=EVM,SVM,UTXO,MVM,TVM`, {
      headers: auth('x-lifi-api-key', env.LIFI_API_KEY),
    })
    return (tokens[id] ?? []).filter((t) => t.verificationStatus !== 'flagged').map(fromLifi)
  },
  // Skip's assets come from the Cosmos chain registry: listed, so taken as verified. On EVM chains the gas token is "<chain>-native".
  skip: async (chain) => {
    const id = String(chain.ids.skip)
    const params = new URLSearchParams({ chain_ids: id, include_evm_assets: 'true', include_svm_assets: 'true', include_cw20_assets: 'false', include_no_metadata_assets: 'false' })
    const res = await getList<{ chain_to_assets_map: Record<string, { assets: SkipAsset[] }> }>(`https://api.skip.build/v2/fungible/assets?${params}`, {
      headers: auth('authorization', env.SKIP_API_KEY),
    })
    return (res.chain_to_assets_map[id]?.assets ?? []).flatMap((a) => {
      const symbol = skipSymbol(a, id)
      if (!symbol || a.decimals === undefined) return []
      const address = chain.kind !== 'evm' ? a.denom : a.denom.endsWith('-native') ? NATIVE : (a.token_contract ?? a.denom)
      return [{ address, symbol, name: a.name || symbol, decimals: a.decimals, logo: a.logo_uri, verified: true }]
    })
  },
  relay: async (chain) => {
    const list = await getList<RelayToken[]>('https://api.relay.link/currencies/v2', {
      method: 'POST',
      headers: auth('x-api-key', env.RELAY_API_KEY),
      body: JSON.stringify({ chainIds: [chain.ids.relay], verified: true, limit: 100 }),
    })
    return list.map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.metadata?.logoURI, verified: !!t.metadata?.verified }))
  },
  layerzero: async (chain) =>
    (await layerzeroTokens())
      .filter((t) => t.chainKey === chain.ids.layerzero)
      .map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.icon, priceUsd: t.price?.usd, verified: true })),
  debridge: async (chain) => {
    const { tokens } = await getList<{ tokens: Record<string, DebridgeToken> }>(`https://dln.debridge.finance/v1.0/token-list?chainId=${chain.ids.debridge}`)
    return Object.values(tokens).map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.logoURI, verified: true }))
  },
}

// Arc pays gas in USDC: its gas token and its USDC contract are the same money, so only the contract is listed.
const gasIsUsdc = (chain: ChainInfo) => !!chain.usdc && chain.native?.symbol === 'USDC'

// Every chain's gas token, CCTP USDC and USDT0, whatever the catalog says.
function basics(chain: ChainInfo): Listed[] {
  const usdt0 = chain.chainId ? USDT0_MESH[chain.chainId] : undefined
  return [
    ...(chain.usdc ? [{ address: chain.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true }] : []),
    ...(usdt0 ? [{ address: usdt0.token, symbol: chain.chainId === 1 ? 'USDT' : 'USDT0', name: 'Tether USD', decimals: 6, verified: true }] : []),
    ...(chain.native && !gasIsUsdc(chain) ? [{ ...chain.native, verified: true }] : []),
  ]
}

// Each chain's list, loaded on first use. One that fails is asked again after a minute.
const catalogs = new Map<string, { at: number; ttl: number; list: Promise<Token[]> }>()
function catalog(asked: ChainInfo): Promise<Token[]> {
  const hit = catalogs.get(asked.id)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.list
  const entry = { at: Date.now(), ttl: 6 * 3600_000, list: Promise.resolve([] as Token[]) }
  entry.list = (async () => {
    // Until the bridges' chain lists load (a few seconds after start), a chain has none of their ids, so no token list.
    await ready
    const chain = chainById(asked.id) ?? asked
    const loader = chain.tokens && chain.tokens in LOADERS ? LOADERS[chain.tokens as keyof typeof LOADERS] : undefined
    const listed = loader
      ? await loader(chain).catch((err) => {
          console.warn(`[tokens] ${chain.id}: ${(err as Error).message}`)
          entry.ttl = 60_000
          return [] as Listed[]
        })
      : []
    const own = listed.filter((t) => !(gasIsUsdc(chain) && chain.native && sameAddress(t.address, chain.native.address)))
    // The basics keep their exact address and symbol, with the catalog's logo and price.
    const base = basics(chain).map((b) => {
      const t = own.find((t) => sameAddress(t.address, b.address))
      return { ...b, logo: t?.logo ?? b.logo, priceUsd: t?.priceUsd }
    })
    const list = [...base, ...own.filter((t) => !base.some((b) => sameAddress(b.address, t.address)))].map((t) => ({ chain: chain.id, ...t }))
    return chain.cosmosSide ? sideTokens(chain, list).catch(() => ((entry.ttl = 60_000), list)) : list
  })()
  catalogs.set(asked.id, entry)
  return entry.list
}

// ---- A chain's Cosmos side (Injective) -----------------------------------------------------------------

// Injective's MultiVM tokens: each bank denom (inj, peggy0x…, ibc/…, factory/…, erc20:0x…) and its ERC20 twin, from the
// chain's erc20 module. Kept 6 hours.
type Pairs = { erc20: Map<string, string>; denom: Map<string, string> } // denom → ERC20, lowercased ERC20 → denom
const pairCache = new Map<string, { at: number; pairs: Promise<Pairs> }>()
function tokenPairs(side: ChainInfo): Promise<Pairs> {
  const hit = pairCache.get(side.id)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.pairs
  const pairs = getList<{ token_pairs: { bank_denom: string; erc20_address: string }[] }>(
    `${side.rest}/injective/erc20/v1beta1/all_token_pairs?pagination.limit=10000`,
  ).then(({ token_pairs }) => {
    // Some ERC20s also have an erc20:0x… pair beside their own denom (ibc/…, factory/…), which is the one bridges take.
    const own = [...token_pairs].sort((a, b) => Number(b.bank_denom.startsWith('erc20:')) - Number(a.bank_denom.startsWith('erc20:')))
    return {
      erc20: new Map(token_pairs.map((p) => [p.bank_denom, getAddress(p.erc20_address)])),
      denom: new Map(own.map((p) => [p.erc20_address.toLowerCase(), p.bank_denom])),
    }
  })
  pairCache.set(side.id, { at: Date.now(), pairs })
  pairs.catch(() => pairCache.delete(side.id))
  return pairs
}

// The EVM side's list, plus the Cosmos side's tokens it lacks: by their ERC20 twin's address where they have one (the
// same token, which both sides' bridges take), else by denom.
async function sideTokens(chain: ChainInfo, list: Token[]) {
  const side = chainById(chain.cosmosSide!)
  if (!side) return list
  const [theirs, pairs] = await Promise.all([catalog(side), tokenPairs(side)])
  if (!theirs.length) throw new Error('no Cosmos side tokens') // asked again in a minute, like a failed list
  const merged = [...list]
  for (const t of theirs) {
    if (side.native && t.address === side.native.address) continue // INJ: the EVM side's gas token
    const erc20 = pairs.erc20.get(t.address)
    const same = erc20 ? merged.findIndex((m) => sameAddress(m.address, erc20)) : -1
    if (same >= 0) merged[same] = { ...merged[same]!, logo: merged[same]!.logo ?? t.logo }
    else merged.push({ ...t, chain: chain.id, address: erc20 ?? t.address })
  }
  return merged
}

// A token of a chain with a Cosmos side, as that side writes it: the gas token's denom, an ERC20's bank denom (none when
// it has no twin), or the denom itself.
export async function denomOnSide(chain: ChainInfo, token: string) {
  const side = chainById(chain.cosmosSide!)
  if (!side?.native) return
  if (sameAddress(token, NATIVE)) return side.native.address
  if (!isAddress(token)) return token
  return (await tokenPairs(side).catch(() => undefined))?.denom.get(token.toLowerCase())
}

// The lists people open first, loaded ahead: one chain at a time, to go easy on the APIs.
export async function warmTokens(chains: ChainInfo[]) {
  for (const chain of chains) await catalog(chain)
}

const isNativeToken = (chain: ChainInfo, address: string) => !!chain.native && sameAddress(address, chain.native.address)

function popular(chain: ChainInfo, list: Token[]) {
  const nativeSymbol = list.find((t) => isNativeToken(chain, t.address))?.symbol
  const picked: Token[] = []
  for (const symbol of POPULAR.map((s) => (s === '$native' ? nativeSymbol : s))) {
    const t = list.find((t) => t.symbol === symbol && (t.verified || isNativeToken(chain, t.address)) && !picked.includes(t))
    if (t) picked.push(t)
  }
  return picked.slice(0, 8)
}

const knownChain = (id: string | number) => {
  const chain = resolveChain(id)
  if (!chain) throw new HttpError(404, 'Unknown chain.')
  return chain
}
// What can be looked up by address on the chain, outside the list.
const isTokenAddress = (chain: ChainInfo, value: string) => (chain.kind === 'solana' ? !!publicKey(value) : chain.kind === 'evm' && isAddress(value))

// Popular tokens and the start of the list, or the matches for a symbol, name, contract address or denom.
export async function tokens(id: string | number, query = '') {
  const chain = knownChain(id)
  const list = await catalog(chain)
  const q = query.trim()
  if (!q) {
    // The popular ones first, then tokens with a logo: the catalogs' own order puts obscure tokens early.
    const top = popular(chain, list)
    const rest = list.filter((t) => t.verified && !top.includes(t))
    return { popular: top, tokens: [...top, ...rest.filter((t) => t.logo), ...rest.filter((t) => !t.logo)].slice(0, 100) }
  }
  // Injective lists a token with an ERC20 twin by the twin's address; its denom finds it too.
  const side = chain.cosmosSide ? chainById(chain.cosmosSide) : undefined
  const twin = side && !isAddress(q) ? (await tokenPairs(side).catch(() => undefined))?.erc20.get(q) : undefined
  const exact = list.find((t) => sameAddress(t.address, twin ?? q) || ((chain.kind === 'cosmos' || !!side) && t.address.toLowerCase() === q.toLowerCase()))
  if (exact) return { popular: [], tokens: [exact] }
  if (isTokenAddress(chain, q)) return { popular: [], tokens: [await lookup(chain, q)] }
  const needle = q.toLowerCase()
  const rank = (t: Token) => {
    const symbol = t.symbol.toLowerCase()
    const match = symbol === needle ? 0 : symbol.startsWith(needle) ? 1 : symbol.includes(needle) ? 2 : t.name.toLowerCase().includes(needle) ? 3 : -1
    return match < 0 ? -1 : match * 4 + (t.verified ? 0 : 2) + (t.logo ? 0 : 1)
  }
  const found = list.map((t) => [rank(t), t] as const).filter(([r]) => r >= 0)
  found.sort((a, b) => a[0] - b[0]) // stable: keeps the catalog's order within a rank
  return { popular: [], tokens: found.slice(0, 50).map(([, t]) => t) }
}

// A token outside the list, read from its contract (or mint).
const looked = new Map<string, Promise<Token>>()
function lookup(chain: ChainInfo, address: string) {
  const key = `${chain.id}:${address.toLowerCase()}`
  let hit = looked.get(key)
  if (!hit) {
    hit = chain.kind === 'solana' ? lookupMint(chain, address) : lookupErc20(chain, address as Hex)
    looked.set(key, hit)
    hit.catch(() => looked.delete(key))
  }
  return hit
}

async function lookupErc20(chain: ChainInfo, address: Hex): Promise<Token> {
  const client = evmClient(chain)
  if (!client) throw new HttpError(404, `No token at this address on ${chain.name}.`)
  const read = <T>(functionName: 'symbol' | 'name' | 'decimals') => client.readContract({ address, abi: erc20Abi, functionName }) as Promise<T>
  const [decimals, symbol, tokenName] = await Promise.all([read<number>('decimals'), read<string>('symbol').catch(() => '?'), read<string>('name').catch(() => '')]).catch(
    () => {
      throw new HttpError(404, `No token at this address on ${chain.name}.`)
    },
  )
  return { chain: chain.id, address: getAddress(address), symbol, name: tokenName || symbol, decimals, verified: false }
}

async function lookupMint(chain: ChainInfo, mint: string): Promise<Token> {
  type Parsed = { value: { data: { parsed?: { type: string; info: { decimals: number; extensions?: { extension: string; state: { name?: string; symbol?: string } }[] } } } } | null }
  const { value } = await solanaRpc<Parsed>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => {
    throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  })
  const parsed = value?.data.parsed
  if (parsed?.type !== 'mint') throw new HttpError(404, `No token at this address on ${chain.name}.`)
  // Token-2022 mints carry their name; others are named by LI.FI when it knows them.
  const meta = parsed.info.extensions?.find((e) => e.extension === 'tokenMetadata')?.state
  const known = meta?.symbol
    ? undefined
    : await fetch(`${LIFI}/token?chain=${chain.ids.lifi}&token=${mint}`, { headers: auth('x-lifi-api-key', env.LIFI_API_KEY), signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? (r.json() as Promise<LifiToken>) : undefined))
        .catch(() => undefined)
  const symbol = meta?.symbol || known?.symbol || `${mint.slice(0, 4)}…`
  return { chain: chain.id, address: mint, symbol, name: meta?.name || known?.name || symbol, decimals: parsed.info.decimals, logo: known?.logoURI, verified: false }
}

// Base units of a token held by an address, on the chains the app sends from.
export async function tokenBalance(id: string | number, owner: string, token: string): Promise<{ raw: string }> {
  const chain = knownChain(id)
  // Injective: a denom without an ERC20 twin is read on the Cosmos side; the rest on the EVM side, by the 0x address.
  const side = chain.cosmosSide ? chainById(chain.cosmosSide) : undefined
  if (side && validAddress(chain, owner)) {
    if (!isAddress(token)) return tokenBalance(side.id, addressOnSide(owner, side), token)
    owner = addressOnSide(owner, chain)
  }
  const validToken = chain.kind === 'evm' ? isAddress(token) : chain.kind === 'solana' ? token === SOL || !!publicKey(token) : /^[\w\-./:]{1,200}$/.test(token)
  if (!validAddress(chain, owner) || !validToken) throw new HttpError(400, 'Invalid address.')
  const unreachable = () => {
    throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  }
  if (chain.kind === 'cosmos') return { raw: await cosmosBalance(chain, owner, token) }
  if (chain.kind === 'hypercore') {
    // What a transfer can take: perps USDC that isn't margin, or with a unified account (one balance for spot and perps,
    // which transfers draw from spot), free spot USDC. In 6 decimals.
    if (!chain.native || !sameAddress(token, chain.native.address)) throw new HttpError(400, `Balances aren't available for this token on ${chain.name}.`)
    const info = <T>(type: string) =>
      fetch(`${HYPERLIQUID_API}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, user: owner }), signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
        .catch(unreachable)
    const units = (value: string) => {
      const [whole, fraction = ''] = value.split('.')
      return BigInt(whole! + fraction.padEnd(6, '0').slice(0, 6))
    }
    const mode = await info<string>('userAbstraction')
    if (mode === 'unifiedAccount' || mode === 'portfolioMargin') {
      const { balances } = await info<{ balances: { coin: string; total: string; hold: string }[] }>('spotClearinghouseState')
      const usdc = balances.find((b) => b.coin === 'USDC')
      const free = usdc ? units(usdc.total) - units(usdc.hold) : 0n
      return { raw: String(free > 0n ? free : 0n) }
    }
    return { raw: String(units((await info<{ withdrawable: string }>('clearinghouseState')).withdrawable)) }
  }
  if (chain.kind === 'solana') {
    if (token === SOL) return { raw: String((await solanaRpc<{ value: number }>('getBalance', [owner]).catch(unreachable)).value) }
    type Accounts = { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }
    const { value } = await solanaRpc<Accounts>('getTokenAccountsByOwner', [owner, { mint: token }, { encoding: 'jsonParsed' }]).catch(unreachable)
    return { raw: String(value.reduce((total, a) => total + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)) }
  }
  const client = evmClient(chain)
  if (!client) throw new HttpError(400, `Balances aren't available on ${chain.name}.`)
  const balance =
    token === NATIVE
      ? await client.getBalance({ address: owner as Hex }).catch(unreachable)
      : await client.readContract({ address: token as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Hex] }).catch(unreachable)
  return { raw: String(balance) }
}
