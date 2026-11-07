import { createPublicClient, type Chain as ViemChain, type Hex, type PublicClient } from 'viem'
import * as viemChains from 'viem/chains'
import { bech32Decode, bech32Encode } from './bech32'
import { chains as cctpChains, checksum, network, rpcEnv, SLUGS, solana, SOLANA_DOMAIN, transport } from './config'

// Every chain the bridges reach, merged from their chain lists (refreshed every 6 hours): the CCTP chains, then the others
// by EVM chain id, Cosmos chain id, or VM. Each has a short id, used in links and by the API: "ethereum", "osmosis", "bitcoin".

export type Kind =
  | 'evm'
  | 'solana'
  | 'cosmos'
  | 'bitcoin'
  | 'tron'
  | 'sui'
  | 'zcash'
  | 'ton'
  | 'xrp'
  | 'eclipse'
  | 'hypercore'
  | 'lighter'
  | 'aptos'
  | 'stellar'
  | 'starknet'
  | 'iota'
export type Source = 'lifi' | 'skip' | 'debridge' | 'relay' | 'across' | 'layerzero' | 'usdt0' | 'orderbook'
export type Asset = { address: string; symbol: string; name: string; decimals: number; logo?: string }

export type ChainInfo = {
  id: string
  name: string
  kind: Kind
  logo?: string
  domain?: number // CCTP domain, for the chains CCTP reaches
  chainId?: number // EVM
  cosmosId?: string
  bech32?: string // Cosmos address prefix
  slip44?: number // Cosmos key type: 60 is Ethereum's (same key, same 20 bytes as the EVM address)
  rpc?: string // public RPC (on Cosmos chains, for wallets that have to add the chain)
  rest?: string // Cosmos REST (LCD) endpoint
  explorer?: string // a transaction's page, {tx} standing for its hash
  native?: Asset // the gas token, in the chain's token list's terms (NATIVE / SOL on EVM chains and Solana)
  gas?: { denom: string; price: string } // Cosmos fees
  usdc?: string // CCTP USDC
  ids: Partial<Record<Source, string | number>> // each bridge's own id for the chain
  natives: Partial<Record<Source, Asset>> // each bridge's own address for the gas token
  tokens?: Source // whose token list the chain uses
  cosmosSide?: string // the id of the chain's Cosmos side, when the two are one chain to the user (see ONE_CHAIN)
  sideOf?: string // on that Cosmos side: the chain it belongs to, listed in its place
}

export const NATIVE = '0x0000000000000000000000000000000000000000'
export const SOL = '11111111111111111111111111111111'
export const sameAddress = (a: string, b: string) => (a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b)

// Wallets here sign EVM, Solana and Cosmos transactions, and Hyperliquid's transfers (EIP-712, with the EVM wallet). The
// other chains are destinations only: an address is pasted.
export const canSend = (chain: ChainInfo) => chain.kind === 'evm' || chain.kind === 'solana' || chain.kind === 'cosmos' || chain.kind === 'hypercore'

// Hyperliquid's API: balances (/info), and the transfers the user signs (/exchange).
export const HYPERLIQUID_API = 'https://api.hyperliquid.xyz'

// Chains outside EVM, Solana and Cosmos, by each bridge's id for them. Some lists give these EVM-style ids.
const OTHERS: { key: string; kind: Kind; name: string; explorer?: string; ids: Partial<Record<Source, string | number>> }[] = [
  { key: 'bitcoin', kind: 'bitcoin', name: 'Bitcoin', explorer: 'https://mempool.space/tx/{tx}', ids: { lifi: 20000000000001, relay: 8253038 } },
  { key: 'tron', kind: 'tron', name: 'Tron', explorer: 'https://tronscan.org/#/transaction/{tx}', ids: { lifi: 728126428, relay: 728126428, debridge: 100000026, across: 728126428, layerzero: 'tron' } },
  { key: 'sui', kind: 'sui', name: 'Sui', explorer: 'https://suiscan.xyz/mainnet/tx/{tx}', ids: { lifi: 9270000000000000, layerzero: 'sui' } },
  { key: 'zcash', kind: 'zcash', name: 'Zcash', explorer: 'https://3xpl.com/zcash/transaction/{tx}', ids: { lifi: 20000000000005 } },
  { key: 'ton', kind: 'ton', name: 'TON', explorer: 'https://tonviewer.com/transaction/{tx}', ids: { relay: 224235520, layerzero: 'ton' } },
  { key: 'xrp', kind: 'xrp', name: 'XRP Ledger', explorer: 'https://xrpscan.com/tx/{tx}', ids: { relay: 537724 } },
  { key: 'eclipse', kind: 'eclipse', name: 'Eclipse', explorer: 'https://eclipsescan.xyz/tx/{tx}', ids: { relay: 9286185 } },
  { key: 'hyperliquid', kind: 'hypercore', name: 'Hyperliquid', explorer: 'https://app.hyperliquid.xyz/explorer/tx/{tx}', ids: { lifi: 1337, relay: 1337, across: 1337, layerzero: 'hypercore' } },
  { key: 'lighter', kind: 'lighter', name: 'Lighter', ids: { lifi: 3586256, relay: 3586256, across: 2337 } },
  { key: 'robinhood-lighter', kind: 'lighter', name: 'Robinhood Lighter', ids: { relay: 548123634 } },
  { key: 'aptos', kind: 'aptos', name: 'Aptos', explorer: 'https://explorer.aptoslabs.com/txn/{tx}?network=mainnet', ids: { layerzero: 'aptos' } },
  { key: 'stellar', kind: 'stellar', name: 'Stellar', explorer: 'https://stellar.expert/explorer/public/tx/{tx}', ids: { layerzero: 'stellar' } },
  { key: 'starknet', kind: 'starknet', name: 'Starknet', explorer: 'https://voyager.online/tx/{tx}', ids: { layerzero: 'starknet' } },
  { key: 'iota', kind: 'iota', name: 'IOTA', explorer: 'https://iotascan.com/mainnet/tx/{tx}', ids: { layerzero: 'iotal1' } },
]
const SOLANA_IDS: Partial<Record<Source, string | number>> = { lifi: 1151111081099710, skip: 'solana', debridge: 7565164, relay: 792703809, across: 34268394551451, layerzero: 'solana' }
const NOT_EVM = new Set<number>([...OTHERS.flatMap((o) => Object.values(o.ids).filter((v): v is number => typeof v === 'number')), ...Object.values(SOLANA_IDS).filter((v): v is number => typeof v === 'number')])

// Shorter or clearer names than the bridges use, and ids for links where the name makes a poor one.
const NAMES: Record<number, string> = { 56: 'BNB Chain', 122: 'Fuse', 324: 'zkSync Era', 747: 'Flow EVM', 1868: 'Soneium', 8217: 'Kaia', 16661: '0G' }
const IDS: Record<number, string> = { 56: 'bnb', 324: 'zksync', 1101: 'polygon-zkevm' }

// USDT0's native mesh, where USDT0 is minted and burned, by EVM chain id: LayerZero endpoint id, OFT, token, and the
// usual time to arrive, set by the confirmations USDT0 waits for on the source chain (medians on LayerZero Scan, Nov 2026;
// newer deployments without one yet). Every OFT peers with every other. https://docs.usdt0.to/api/deployments?product=usdt0
// Hedera and Tempo wrap USDT0 differently and are left out, as is the legacy mesh's pools (Tron, TON).
// Addresses are checksummed on load: some were copied with a wrong checksum (Rootstock's token).
type Mesh = { eid: number; oft: Hex; token: Hex; seconds?: number }
const mesh: Record<number, Mesh> = {
  1: { eid: 30101, oft: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', seconds: 1080 }, // Ethereum: locks USDT
  10: { eid: 30111, oft: '0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD', token: '0x01bFF41798a0BcF287b996046Ca68b395DbC1071', seconds: 2040 }, // OP
  42161: { eid: 30110, oft: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', seconds: 1140 }, // Arbitrum
  137: { eid: 30109, oft: '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13', token: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', seconds: 90 }, // Polygon
  130: { eid: 30320, oft: '0xc07bE8994D035631c36fb4a89C918CeFB2f03EC3', token: '0x9151434b16b9763660705744891fA906F660EcC5', seconds: 1620 }, // Unichain
  143: { eid: 30390, oft: '0x9151434b16b9763660705744891fA906F660EcC5', token: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', seconds: 1140 }, // Monad
  1329: { eid: 30280, oft: '0x56Fe74A2e3b484b921c447357203431a3485CC60', token: '0x9151434b16b9763660705744891fA906F660EcC5', seconds: 960 }, // Sei
  999: { eid: 30367, oft: '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98', token: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', seconds: 42_540 }, // HyperEVM
  57073: { eid: 30339, oft: '0x1cB6De532588fCA4a21B7209DE7C456AF8434A65', token: '0x0200C29006150606B650577BBE7B6248F58470c1', seconds: 3030 }, // Ink
  2818: { eid: 30322, oft: '0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC', token: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', seconds: 3660 }, // Morph
  9745: { eid: 30383, oft: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', token: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', seconds: 1830 }, // Plasma
  196: { eid: 30274, oft: '0x94BCCa6bdfd6A61817Ab0E960bFedE4984505554', token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', seconds: 9060 }, // X Layer
  80094: { eid: 30362, oft: '0x3Dc96399109df5ceb2C226664A086140bD0379cB', token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736' }, // Berachain
  1030: { eid: 30212, oft: '0xC57efa1c7113D98BdA6F9f249471704Ece5dd84A', token: '0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff' }, // Conflux eSpace
  14: { eid: 30295, oft: '0x567287d2A9829215a37e3B88843d32f9221E7588', token: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D' }, // Flare
  5000: { eid: 30181, oft: '0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC', token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736' }, // Mantle
  4326: { eid: 30398, oft: '0x9151434b16b9763660705744891fa906f660ecc5', token: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb' }, // MegaETH
  30: { eid: 30333, oft: '0x1a594d5d5d1c426281C1064B07f23F57B2716B61', token: '0x779dED0C9e1022225F8e0630b35A9B54Be713736' }, // Rootstock
  988: { eid: 30396, oft: '0xedaba024be4d87974d5aB11C6Dd586963CcCB027', token: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736' }, // Stable
}
export const USDT0_MESH: Record<number, Mesh> = Object.fromEntries(
  Object.entries(mesh).map(([id, m]) => [id, { ...m, oft: checksum(m.oft), token: checksum(m.token) }]),
)

// ---- The bridges' chain lists ------------------------------------------------------------------------

type LifiChain = { id: number; name: string; chainType: string; mainnet: boolean; logoURI?: string; nativeToken?: Asset; metamask?: { rpcUrls?: string[]; blockExplorerUrls?: string[] } }
type SkipChain = {
  chain_id: string
  chain_name: string
  pretty_name: string
  chain_type: string
  is_testnet: boolean
  logo_uri?: string
  bech32_prefix?: string
  fee_assets?: { denom: string; gas_price?: { low?: string; average?: string } | null }[]
}
type DebridgeChain = { chainId: number; originalChainId: number; chainName: string }
type RelayChain = { id: number; displayName: string; vmType: string; disabled?: boolean; httpRpcUrl?: string; explorerUrl?: string; iconUrl?: string; currency?: Asset }
type AcrossChain = { chainId: number; name: string; publicRpcUrl?: string; explorerUrl?: string; logoUrl?: string }
type LzChain = { chainKey: string; name: string; chainType: string; chainId: number | string; nativeCurrency: Asset }
type DirectoryChain = {
  path: string
  chain_id: string
  network_type?: string
  slip44?: number
  symbol?: string
  denom?: string
  decimals?: number
  image?: string
  proxy_status?: { rest?: boolean; rpc?: boolean }
  best_apis?: { rest?: { address: string }[]; rpc?: { address: string }[] }
  explorers?: { tx_page?: string }[]
}

const env = process.env
const header = (name: string, value?: string): Record<string, string> => (value ? { [name]: value } : {})
async function getList<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`)
  return res.json() as Promise<T>
}

// LayerZero quotes need a key; without one its chains stay out (see providers/layerzero.ts).
const SOURCES = {
  lifi: () => getList<{ chains: LifiChain[] }>('https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM,TVM', header('x-lifi-api-key', env.LIFI_API_KEY)).then((r) => r.chains),
  skip: () => getList<{ chains: SkipChain[] }>('https://api.skip.build/v2/info/chains?include_evm=true&include_svm=true', header('authorization', env.SKIP_API_KEY)).then((r) => r.chains),
  // Skip's denom for each EVM chain's gas token ("base-native"): the assets each chain originates, one of them that.
  skipNatives: () =>
    getList<{ chain_to_assets_map: Record<string, { assets: { denom: string }[] }> }>(
      'https://api.skip.build/v2/fungible/assets?native_only=true&include_evm_assets=true&include_svm_assets=true&include_cw20_assets=false',
      header('authorization', env.SKIP_API_KEY),
    ).then((r) => Object.fromEntries(Object.entries(r.chain_to_assets_map).flatMap(([id, { assets }]) => assets.filter((a) => a.denom.endsWith('-native')).map((a) => [id, a.denom])))),
  debridge: () => getList<{ chains: DebridgeChain[] }>('https://dln.debridge.finance/v1.0/supported-chains-info').then((r) => r.chains),
  relay: () => getList<{ chains: RelayChain[] }>('https://api.relay.link/chains', header('x-api-key', env.RELAY_API_KEY)).then((r) => r.chains),
  across: () => getList<AcrossChain[]>('https://app.across.to/api/swap/chains', env.ACROSS_API_KEY ? { authorization: `Bearer ${env.ACROSS_API_KEY}` } : {}),
  layerzero: () => (env.LAYERZERO_API_KEY ? getList<{ chains: LzChain[] }>('https://transfer.layerzero-api.com/v1/chains').then((r) => r.chains) : Promise.resolve([])),
  // Cosmos chains' key type, REST endpoints, explorers and gas token, from the Cosmos chain registry.
  directory: () => getList<{ chains: DirectoryChain[] }>('https://chains.cosmos.directory/').then((r) => r.chains),
}
type Raw = { [K in keyof typeof SOURCES]?: Awaited<ReturnType<(typeof SOURCES)[K]>> }

// ---- Merging them ------------------------------------------------------------------------------------

const explorerTx = (base?: string) => base && `${base.replace(/\/+$/, '')}/tx/{tx}`
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
const viemById = new Map<number, ViemChain>(
  (Object.values(viemChains) as unknown[])
    .filter((c): c is ViemChain => typeof c === 'object' && c !== null && 'id' in c && !(c as ViemChain).testnet)
    .map((c) => [c.id, c]),
)

function build(raw: Raw): ChainInfo[] {
  const chains = new Map<string, ChainInfo>() // by evm:<chain id>, cosmos:<chain id>, solana, or an OTHERS key
  const blank = (kind: Kind, fields: Partial<ChainInfo> = {}): ChainInfo => ({ id: '', name: '', kind, ids: {}, natives: {}, ...fields })

  // The CCTP chains come first and keep their names, ids and RPCs.
  for (const c of cctpChains) {
    chains.set(`evm:${c.chain.id}`, blank('evm', {
      id: SLUGS[c.domain]!,
      name: c.name,
      domain: c.domain,
      chainId: c.chain.id,
      rpc: c.chain.rpcUrls.default.http[0],
      explorer: explorerTx(c.chain.blockExplorers?.default.url),
      native: { address: NATIVE, ...c.chain.nativeCurrency },
      usdc: c.usdc,
    }))
  }
  const sol = blank('solana', {
    id: 'solana',
    name: solana.name,
    domain: SOLANA_DOMAIN,
    rpc: solana.publicRpc,
    explorer: `${solana.explorer}/tx/{tx}${network === 'testnet' ? '?cluster=devnet' : ''}`,
    native: { address: SOL, symbol: 'SOL', name: 'Solana', decimals: 9 },
    usdc: solana.usdc,
  })
  chains.set('solana', sol)
  // The bridges serve mainnet only.
  if (network !== 'mainnet') return finish(chains)

  const evm = (id: number) => {
    if (NOT_EVM.has(id) || !Number.isSafeInteger(id) || id <= 0) return
    let chain = chains.get(`evm:${id}`)
    if (!chain) chains.set(`evm:${id}`, (chain = blank('evm', { chainId: id })))
    return chain
  }
  const other = (source: Source, id: string | number) => {
    const o = OTHERS.find((o) => o.ids[source] === id)
    if (!o) return
    let chain = chains.get(o.key)
    if (!chain) chains.set(o.key, (chain = blank(o.kind, { id: o.key, name: o.name, explorer: o.explorer })))
    return chain
  }
  const solanaIf = (source: Source, id: string | number) => (SOLANA_IDS[source] === id ? sol : undefined)
  // Fields not set yet, from the first bridge that has them (in the order below).
  type Meta = { name?: string; logo?: string; rpc?: string; explorer?: string; native?: Asset }
  const fill = (chain: ChainInfo, source: Source, id: string | number, meta: Meta) => {
    chain.ids[source] = id
    // Just the asset's fields: the bridges' token objects carry prices, tags and more.
    const n = meta.native as (Asset & { logoURI?: string }) | undefined
    const native = n && { address: n.address, symbol: n.symbol, name: n.name, decimals: n.decimals, logo: n.logoURI ?? n.logo }
    if (native) chain.natives[source] = native
    chain.name ||= meta.name ?? ''
    chain.logo ??= meta.logo
    if (chain.kind === 'evm') {
      chain.rpc ??= meta.rpc
      chain.explorer ??= meta.explorer
      if (native) chain.native ??= { ...native, address: NATIVE }
    }
  }

  for (const c of raw.lifi ?? []) {
    if (!c.mainnet) continue
    const chain = other('lifi', c.id) ?? solanaIf('lifi', c.id) ?? (c.chainType === 'EVM' ? evm(c.id) : undefined)
    if (chain) fill(chain, 'lifi', c.id, { name: c.name, logo: c.logoURI, rpc: c.metamask?.rpcUrls?.[0], explorer: explorerTx(c.metamask?.blockExplorerUrls?.[0]), native: c.nativeToken })
  }
  for (const c of raw.relay ?? []) {
    if (c.disabled) continue
    const chain = other('relay', c.id) ?? solanaIf('relay', c.id) ?? (c.vmType === 'evm' ? evm(c.id) : undefined)
    if (chain) fill(chain, 'relay', c.id, { name: c.displayName, logo: c.iconUrl?.replace(/light\.png$/, 'dark.png'), rpc: c.httpRpcUrl, explorer: explorerTx(c.explorerUrl), native: c.currency })
  }
  for (const c of raw.across ?? []) {
    const chain = other('across', c.chainId) ?? solanaIf('across', c.chainId) ?? evm(c.chainId)
    if (chain) fill(chain, 'across', c.chainId, { name: c.name, logo: c.logoUrl, rpc: c.publicRpcUrl, explorer: explorerTx(c.explorerUrl) })
  }
  for (const c of raw.layerzero ?? []) {
    const chain = other('layerzero', c.chainKey) ?? solanaIf('layerzero', c.chainKey) ?? (c.chainType === 'EVM' ? evm(Number(c.chainId)) : undefined)
    if (chain) fill(chain, 'layerzero', c.chainKey, { name: c.name, native: c.nativeCurrency })
  }
  for (const c of raw.debridge ?? []) {
    const chain = other('debridge', c.chainId) ?? solanaIf('debridge', c.chainId) ?? evm(c.originalChainId)
    if (chain) fill(chain, 'debridge', c.chainId, { name: c.chainName })
  }

  // Skip: some EVM chains, Solana, and the Cosmos chains, which only it reaches.
  const skipNatives = new Map<ChainInfo, string>()
  const directory = new Map((raw.directory ?? []).filter((d) => d.network_type !== 'testnet').map((d) => [d.chain_id, d]))
  for (const c of raw.skip ?? []) {
    if (c.is_testnet) continue
    const nativeDenom = raw.skipNatives?.[c.chain_id]
    if (c.chain_type === 'svm') {
      if (c.chain_id === 'solana') fill(sol, 'skip', 'solana', { native: { ...sol.native!, address: 'solana-native' } })
      continue
    }
    if (c.chain_type === 'evm') {
      const chain = evm(Number(c.chain_id))
      if (chain) fill(chain, 'skip', c.chain_id, { name: c.pretty_name.replace(/\s*-\s*EVM$/i, ''), logo: c.logo_uri })
      if (chain && nativeDenom) skipNatives.set(chain, nativeDenom)
      continue
    }
    if (c.chain_type !== 'cosmos' || !c.bech32_prefix) continue
    const d = directory.get(c.chain_id)
    const native = d?.denom ? { address: d.denom, symbol: d.symbol ?? d.denom, name: d.symbol ?? d.denom, decimals: d.decimals ?? 6, logo: d.image } : undefined
    const fee = c.fee_assets?.find((f) => f.denom === native?.address) ?? c.fee_assets?.[0]
    const chain = blank('cosmos', {
      id: slug(c.chain_name),
      name: c.pretty_name.replace(/\s*-\s*Cosmos$/i, ''),
      cosmosId: c.chain_id,
      bech32: c.bech32_prefix,
      slip44: d?.slip44 ?? 118,
      logo: c.logo_uri ?? d?.image,
      // cosmos.directory's proxy spreads requests over the registry's nodes (and allows browsers); else one of them.
      rest: d && (d.proxy_status?.rest ? `https://rest.cosmos.directory/${d.path}` : d.best_apis?.rest?.[0]?.address.replace(/\/+$/, '')),
      rpc: d && (d.proxy_status?.rpc ? `https://rpc.cosmos.directory/${d.path}` : d.best_apis?.rpc?.[0]?.address.replace(/\/+$/, '')),
      explorer: d?.explorers?.find((e) => e.tx_page?.includes('${txHash}'))?.tx_page?.replace('${txHash}', '{tx}'),
      native,
      gas: fee ? { denom: fee.denom, price: fee.gas_price?.average ?? fee.gas_price?.low ?? '0' } : native && { denom: native.address, price: '0.025' },
      ids: { skip: c.chain_id },
      natives: native ? { skip: native } : {},
    })
    chains.set(`cosmos:${c.chain_id}`, chain)
  }

  for (const id of Object.keys(USDT0_MESH).map(Number)) {
    const chain = evm(id)
    if (chain) chain.ids.usdt0 = id
  }
  // Injective's own orderbook, for swaps there (see ./providers/orderbook.ts).
  for (const id of Object.keys(ONE_CHAIN).map(Number)) {
    const chain = evm(id)
    if (chain) chain.ids.orderbook = id
  }

  // What the bridges didn't say about EVM chains, from viem's chain list.
  for (const chain of chains.values()) {
    const v = chain.kind === 'evm' ? viemById.get(chain.chainId!) : undefined
    if (!v) continue
    chain.name ||= v.name
    chain.rpc ??= v.rpcUrls.default.http[0]
    chain.explorer ??= explorerTx(v.blockExplorers?.default.url)
    chain.native ??= { address: NATIVE, ...v.nativeCurrency }
  }
  for (const [chain, denom] of skipNatives) if (chain.native) chain.natives.skip = { ...chain.native, address: denom }
  return finish(chains)
}

function finish(map: Map<string, ChainInfo>): ChainInfo[] {
  // Chains no enabled bridge serves stay out, except the CCTP ones.
  const list = [...map.values()].filter((c) => c.domain !== undefined || Object.keys(c.ids).length)
  for (const c of list) {
    if (c.kind !== 'evm' || c.domain !== undefined) continue
    c.name = NAMES[c.chainId!] ?? (c.name.replace(/\s+Mainnet$/i, '') || `Chain ${c.chainId}`)
    c.id = IDS[c.chainId!] ?? slug(c.name)
  }

  // Ids are unique: the CCTP chains keep theirs, then the others outside Cosmos, then the Cosmos ones ("sei-cosmos").
  // An EVM chain's Cosmos side (Injective, Sei, Cronos…) goes by the same name: "Injective (Cosmos)".
  const rank = (c: ChainInfo) => (c.domain !== undefined ? 0 : c.kind === 'cosmos' ? 2 : 1)
  const names = new Set(list.filter((c) => c.kind !== 'cosmos').map((c) => c.name.toLowerCase()))
  const taken = new Set<string>()
  for (const c of [...list].sort((a, b) => rank(a) - rank(b))) {
    const base = c.id || slug(c.name)
    let id = taken.has(base) && c.kind === 'cosmos' ? `${base}-cosmos` : base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add((c.id = id))
    if (c.kind === 'cosmos' && names.has(c.name.toLowerCase())) c.name = `${c.name} (Cosmos)`

    // Tokens come from the first bridge with a list for the chain; its address for the gas token is the one the app uses.
    c.tokens = c.ids.lifi !== undefined ? 'lifi' : c.kind === 'cosmos' ? 'skip' : (['relay', 'layerzero', 'skip', 'debridge'] as const).find((s) => c.ids[s] !== undefined)
    if (c.kind !== 'evm' && c.kind !== 'solana' && c.kind !== 'cosmos') c.native = (c.tokens && c.natives[c.tokens]) || c.native
    // A logo for the gas token, from any bridge that lists the same one.
    if (c.native && !c.native.logo) c.native = { ...c.native, logo: Object.values(c.natives).find((n) => n?.logo && n.symbol === c.native!.symbol)?.logo }
  }

  // The CCTP chains in their order, then the rest by how many bridges reach them.
  const reach = (c: ChainInfo) => Object.keys(c.ids).length
  return joinSides(
    list.sort((a, b) => {
      if (a.domain !== undefined || b.domain !== undefined) return a.domain === undefined ? 1 : b.domain === undefined ? -1 : 0
      return reach(b) - reach(a) || a.name.localeCompare(b.name)
    }),
  )
}

// EVM chains whose Cosmos side is the same chain to the user, listed as one. On Injective the tokens are the same on both
// sides (each bank denom has an ERC20 twin: the MultiVM Token Standard) and so is the account (inj1… is the 0x… address).
// Bridges still see two chains: Skip reaches the Cosmos side as injective-1, the others the EVM side.
export const ONE_CHAIN: Record<number, string> = { 1776: 'injective-1' }

function joinSides(list: ChainInfo[]) {
  for (const c of list) {
    const cosmosId = c.kind === 'evm' ? ONE_CHAIN[c.chainId!] : undefined
    const side = cosmosId && list.find((s) => s.cosmosId === cosmosId)
    if (side) [c.cosmosSide, side.sideOf] = [side.id, c.id]
  }
  return list
}

// ---- The registry ------------------------------------------------------------------------------------

let registry: ChainInfo[] = build({})
let byId = new Map(registry.map((c) => [c.id, c]))
let byProvider = new Map<string, ChainInfo>()
const raw: Raw = {}

function rebuild() {
  registry = build(raw)
  byId = new Map(registry.map((c) => [c.id, c]))
  byProvider = new Map(registry.flatMap((c) => Object.entries(c.ids).map(([source, id]) => [`${source}:${id}`, c] as const)))
}

// Sources that fail keep their last answer and are asked again each minute; all of them every 6 hours.
async function load(all: boolean) {
  const keys = (Object.keys(SOURCES) as (keyof typeof SOURCES)[]).filter((k) => all || !raw[k])
  if (!keys.length) return
  await Promise.all(
    keys.map((k) =>
      SOURCES[k]().then(
        (value) => void ((raw as Record<string, unknown>)[k] = value),
        (err) => console.warn(`[chains] ${k}: ${(err as Error).message}`),
      ),
    ),
  )
  rebuild()
}
export const ready = network === 'mainnet' ? load(true) : Promise.resolve()
if (network === 'mainnet') {
  setInterval(() => void load(false), 60_000).unref()
  setInterval(() => void load(true), 6 * 3600_000).unref()
}

export const allChains = () => registry
export const chainById = (id: string) => byId.get(id)
export const chainByDomain = (domain: number) => registry.find((c) => c.domain === domain)
export const chainBySource = (source: Source, id: string | number) => byProvider.get(`${source}:${id}`)
// A chain by id, or by CCTP domain (a number, as the API took before chains had ids).
export const resolveChain = (value: string | number) => (typeof value === 'number' || /^\d+$/.test(value) ? chainByDomain(Number(value)) : chainById(value))

// A bridge's address for a token: the gas token is written differently by each, the rest the same.
export function tokenFor(chain: ChainInfo, source: Source, token: string) {
  const native = chain.native
  const theirs = chain.natives[source]
  if (!native || !theirs || !sameAddress(token, native.address)) return token
  if (chain.kind === 'evm' || chain.kind === 'solana') return theirs.address
  // Elsewhere only the same asset in the same units: Hyperliquid's "native" is USDC to some bridges and HYPE to
  // others, and Relay counts its USDC in 8 decimals where LI.FI uses 6.
  const symbol = (s: string) => s.split(/[\s(]/)[0]!.toUpperCase()
  return symbol(theirs.symbol) === symbol(native.symbol) && theirs.decimals === native.decimals ? theirs.address : token
}

// ---- Addresses ---------------------------------------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const FORMATS: Partial<Record<Kind, RegExp>> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  hypercore: /^0x[0-9a-fA-F]{40}$/,
  lighter: /^0x[0-9a-fA-F]{40}$/,
  bitcoin: /^(bc1[02-9ac-hj-np-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{1,64}$/,
  iota: /^0x[0-9a-fA-F]{64}$/,
  starknet: /^0x[0-9a-fA-F]{1,64}$/,
  zcash: /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$|^u1[02-9ac-hj-np-z]{100,}$/,
  ton: /^[EUk0]Q[A-Za-z0-9_-]{46}$|^-?\d:[0-9a-fA-F]{64}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  stellar: /^G[A-Z2-7]{55}$/,
}

// Whether an address can receive (or send) on the chain. Solana-style keys are 32 bytes of base58. A chain with a Cosmos
// side takes that side's form too (Injective's inj1…).
export function validAddress(chain: ChainInfo, address: string): boolean {
  if (chain.kind === 'solana' || chain.kind === 'eclipse') return BASE58.test(address) && address.length >= 32 && address.length <= 44
  if (chain.kind === 'cosmos') return bech32Decode(address)?.prefix === chain.bech32
  const side = chain.cosmosSide ? byId.get(chain.cosmosSide) : undefined
  if (side && validAddress(side, address)) return true
  return !!FORMATS[chain.kind]?.test(address)
}

// Stand-ins for price quotes before the user gives an address: valid, and nobody's (0xdead… where the format allows,
// else the chain's zero account). The Solana one is sha256("inj-cctp-redeemer quote placeholder").
const DEAD = new Uint8Array(20).fill(0xde)
const PLACEHOLDERS: Partial<Record<Kind, string>> = {
  evm: '0x000000000000000000000000000000000000dEaD',
  hypercore: '0x000000000000000000000000000000000000dEaD',
  lighter: '0x000000000000000000000000000000000000dEaD',
  solana: 'JDdYXVxVUrgimYYuvRhiu8G4cDWf3ziTWHkruNzZ1Bxz',
  eclipse: 'JDdYXVxVUrgimYYuvRhiu8G4cDWf3ziTWHkruNzZ1Bxz',
  bitcoin: 'bc1qmm0dahk7mm0dahk7mm0dahk7mm0dahk790t9jf',
  zcash: 't1eC31EyvubihdMj1Ms6G3GuR4T8iTrqNG4',
  tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  sui: `0x${'0'.repeat(60)}dead`,
  aptos: `0x${'0'.repeat(60)}dead`,
  iota: `0x${'0'.repeat(60)}dead`,
  starknet: `0x${'0'.repeat(60)}dead`,
  ton: 'UQDe3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3kNy', // not the zero account: that's a contract, which Relay won't pay
  xrp: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
  stellar: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
}
export const placeholder = (chain: ChainInfo) => (chain.kind === 'cosmos' ? bech32Encode(chain.bech32!, DEAD) : PLACEHOLDERS[chain.kind])

// The same account's address on another chain, where one key gives the same 20 bytes on both: any two EVM chains, Cosmos
// chains of one key type, or an EVM chain and a Cosmos chain with Ethereum's key type (Injective's inj1… is the 0x… there).
export function sameAccount(address: string, from: ChainInfo, to: ChainInfo): string | undefined {
  if (from.id === to.id) return address
  const evmLike = (c: ChainInfo) => c.kind === 'evm' || c.kind === 'hypercore'
  if (evmLike(from) && evmLike(to)) return address
  if (from.kind === 'solana' && to.kind === 'solana') return address
  if (from.kind === 'cosmos' && from.slip44 === 60 && evmLike(to)) {
    const decoded = bech32Decode(address)
    return decoded?.bytes.length === 20 ? `0x${Buffer.from(decoded.bytes).toString('hex')}` : undefined
  }
  if (to.kind !== 'cosmos') return
  if (from.kind === 'cosmos' && from.slip44 === to.slip44) {
    const decoded = bech32Decode(address)
    return decoded && bech32Encode(to.bech32!, decoded.bytes)
  }
  if (evmLike(from) && to.slip44 === 60 && /^0x[0-9a-fA-F]{40}$/.test(address)) return bech32Encode(to.bech32!, Uint8Array.from(Buffer.from(address.slice(2), 'hex')))
}

// An address of a chain with a Cosmos side, in the form one of its sides takes: inj1… on the Cosmos side, 0x… on the EVM one.
export function addressOnSide(address: string, side: ChainInfo) {
  const bytes = /^0x[0-9a-fA-F]{40}$/.test(address) ? Uint8Array.from(Buffer.from(address.slice(2), 'hex')) : bech32Decode(address)?.bytes
  if (bytes?.length !== 20) return address
  return side.kind === 'cosmos' ? bech32Encode(side.bech32!, bytes) : `0x${Buffer.from(bytes).toString('hex')}`
}

// ---- EVM clients -------------------------------------------------------------------------------------

// The CCTP chains' own clients (RPC_<NAME>), else one per chain on RPC_<ID> (e.g. RPC_BNB, RPC_MANTA_PACIFIC) or its public RPC.
const clients = new Map<number, PublicClient>()
export function evmClient(chain: ChainInfo): PublicClient | undefined {
  if (chain.kind !== 'evm' || !chain.chainId) return
  const configured = cctpChains.find((c) => c.chain.id === chain.chainId)
  if (configured) return configured.client as PublicClient
  let client = clients.get(chain.chainId)
  if (!client && (chain.rpc || process.env[rpcEnv(chain.id)])) {
    client = createPublicClient({ transport: transport(rpcEnv(chain.id), chain.rpc) }) as PublicClient
    clients.set(chain.chainId, client)
  }
  return client
}
