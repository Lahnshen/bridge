import { createPublicClient, createWalletClient, fallback, http, parseUnits, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as c from 'viem/chains'

const env = process.env
const testnet = env.NETWORK === 'testnet'
const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback)

export const network = testnet ? 'testnet' : 'mainnet'
export const port = num(env.PORT, 3000)
export const host = env.HOST || '0.0.0.0'
export const corsOrigins = (env.CORS_ORIGIN || '*').split(',').map((o) => o.trim())
export const trustProxy = env.TRUST_PROXY === 'true'
export const requestsPerMinute = num(env.RATE_LIMIT_PER_MINUTE, 120)
export const redeemsPerMinute = num(env.REDEEM_LIMIT_PER_MINUTE, 5)
export const minRedeemAmount = parseUnits(env.MIN_REDEEM_USDC || '0', 6)
export const dbPath = env.DB_PATH || 'cctp.sqlite'
export const lookbackHours = num(env.INDEX_LOOKBACK_HOURS, 72)
export const pollMs = num(env.INDEX_POLL_SECONDS, 30) * 1000

export const IRIS_API = testnet ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com'
export const INJECTIVE_DOMAIN = 29
export const SOLANA_DOMAIN = 5
// CCTP V2 contracts share one address on every EVM chain: https://developers.circle.com/cctp/references/contract-addresses
export const TOKEN_MESSENGER: Hex = testnet ? '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' : '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
export const MESSAGE_TRANSMITTER: Hex = testnet ? '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' : '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'

// CCTP V2 EVM chains: [domain, name, mainnet, USDC, testnet, testnet USDC]. Injective first, every other chain bridges to and from it.
// https://developers.circle.com/cctp/concepts/supported-chains-and-domains, https://developers.circle.com/stablecoins/usdc-contract-addresses
const evmChains: [number, string, Chain, Hex, Chain?, Hex?][] = [
  [29, 'Injective', c.injective, '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', c.injectiveTestnet, '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d'],
  [0, 'Ethereum', c.mainnet, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', c.sepolia, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
  [1, 'Avalanche', c.avalanche, '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', c.avalancheFuji, '0x5425890298aed601595a70AB815c96711a31Bc65'],
  [2, 'OP Mainnet', c.optimism, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', c.optimismSepolia, '0x5fd84259d66Cd46123540766Be93DFE6D43130D7'],
  [3, 'Arbitrum', c.arbitrum, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', c.arbitrumSepolia, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'],
  [6, 'Base', c.base, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', c.baseSepolia, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  [7, 'Polygon', c.polygon, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', c.polygonAmoy, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'],
  [10, 'Unichain', c.unichain, '0x078D782b760474a361dDA0AF3839290b0EF57AD6', c.unichainSepolia, '0x31d0220469e10c4E71834a79b1f276d740d3768F'],
  [11, 'Linea', c.linea, '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', c.lineaSepolia, '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7'],
  [12, 'Codex', c.codex, '0xd996633a415985DBd7D6D12f4A4343E31f5037cf', c.codexTestnet, '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f'],
  [13, 'Sonic', c.sonic, '0x29219dd400f2Bf60E5a23d13Be72B486D4038894'],
  [14, 'World Chain', c.worldchain, '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', c.worldchainSepolia, '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88'],
  [15, 'Monad', c.monad, '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', c.monadTestnet, '0x534b2f3A21130d7a60830c2Df862319e593943A3'],
  [16, 'Sei', c.sei, '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', c.seiTestnet, '0x4fCF1784B31630811181f670Aea7A7bEF803eaED'],
  [18, 'XDC', c.xdc, '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1', c.xdcTestnet, '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4'],
  [19, 'HyperEVM', c.hyperEvm, '0xb88339CB7199b77E23DB6E890353E22632Ba630f', c.hyperliquidEvmTestnet, '0x2B3370eE501B4a559b57D449569354196457D8Ab'],
  [21, 'Ink', c.ink, '0x2D270e6886d130D724215A266106e6832161EAEd', c.inkSepolia, '0xFabab97dCE620294D2B0b0e46C68964e326300Ac'],
  [22, 'Plume', c.plumeMainnet, '0x222365EF19F7947e5484218551B56bb3965Aa7aF', c.plumeSepolia, '0xcB5f30e335672893c7eb944B374c196392C19D18'],
  [26, 'Arc', c.arc, '0x3600000000000000000000000000000000000000', c.arcTestnet, '0x3600000000000000000000000000000000000000'],
  [30, 'Morph', c.morph, '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B'],
  [32, 'Cronos', c.cronos, '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D', c.cronosTestnet, '0xEb33dc5fac03833e132593659e1dE7256aB59794'],
  [33, 'Plasma', c.plasma, '0x2d661C89D812261039AF9764eceaAee884f5F67F', c.plasmaTestnet, '0xE67Fb267022cBA8064Dd388CC2FED724F3120D9D'],
  [37, 'X Layer', c.xLayer, '0xB6CEceAB302E2E4948951eE7843FC24E92933061', c.xLayerTestnet, '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3'],
]
// Chains we can't scan: transfers from them can still be redeemed by tx hash (+ domain), and transfers to them are shown.
const otherDomains: Record<number, string> = { 5: 'Solana', 8: 'Sui', 9: 'Aptos', 25: 'Starknet', 27: 'Stellar', 28: 'EDGE', 31: 'Pharos' }

// RPC_<NAME> overrides the public RPC, e.g. RPC_ETHEREUM or RPC_OP_MAINNET. Comma-separate several URLs for fallback.
const rpcEnv = (name: string) => `RPC_${name.toUpperCase().replace(/\W+/g, '_')}`
function transport(rpcEnv: string) {
  const urls = env[rpcEnv]?.split(',').map((u) => u.trim()).filter(Boolean) ?? []
  const transports = (urls.length ? urls : [undefined]).map((url) => http(url, { timeout: 10_000, retryCount: 1 }))
  return transports.length > 1 ? fallback(transports) : transports[0]!
}

export const chains = evmChains.flatMap(([domain, name, mainnet, usdc, testChain, testUsdc]) => {
  const chain = testnet ? testChain : mainnet
  if (!chain) return []
  const client = createPublicClient({ chain, transport: transport(rpcEnv(name)) })
  return [{ domain, name: testnet ? chain.name : name, rpcEnv: rpcEnv(name), chain, client, usdc: (testnet ? testUsdc : usdc)! }]
})
export type EvmChain = (typeof chains)[number]
export const chainOf = (domain: number) => chains.find((chain) => chain.domain === domain)

export const injective = chainOf(INJECTIVE_DOMAIN)!
export const relayer = env.RELAYER_PRIVATE_KEY
  ? createWalletClient({ account: privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex), chain: injective.chain, transport: transport(injective.rpcEnv) })
  : undefined

export const domainName = (domain: number) => chainOf(domain)?.name ?? otherDomains[domain]

export function txUrl(domain: number, hash: string) {
  if (domain === SOLANA_DOMAIN) return `https://solscan.io/tx/${hash}${testnet ? '?cluster=devnet' : ''}`
  const explorer = chainOf(domain)?.chain.blockExplorers?.default.url
  return explorer && `${explorer}/tx/${hash}`
}
