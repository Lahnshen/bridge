import { sameAddress } from './chains'

// Each chain's canonical USDC and USDT (USDT0 on its mesh), by registry id, as their issuers deploy them: Circle's USDC
// table, Tether's and USDT0's deployment lists, and Noble's USDC over IBC on Cosmos chains. Decimals and symbols were read
// on-chain (Nov 2026). Always matched by exact address or denom, never by symbol: look-alikes share it (Polygon's
// USDC.e, X Layer's old USDC.e, HyperEVM's fake 18-decimal USDC priced at 2.7e20, ~90 fake USDTs on Tron).

export type Stable = { address: string; decimals: number; symbol: string }
export type StableKind = 'usdc' | 'usdt'

export const STABLES: Record<string, Partial<Record<StableKind, Stable>>> = {
  injective: { usdc: { address: '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13', decimals: 6, symbol: 'USDT' } },
  ethereum: { usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' } },
  avalanche: { usdc: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, symbol: 'USDt' } },
  optimism: { usdc: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x01bFF41798a0BcF287b996046Ca68b395DbC1071', decimals: 6, symbol: 'USD₮0' } },
  arbitrum: { usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USD₮0' } },
  base: { usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' } },
  polygon: { usdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT0' } },
  unichain: { usdc: { address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6, symbol: 'USD₮0' } },
  linea: { usdc: { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6, symbol: 'USDC' } },
  codex: { usdc: { address: '0xd996633a415985DBd7D6D12f4A4343E31f5037cf', decimals: 6, symbol: 'USDC' } },
  sonic: { usdc: { address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', decimals: 6, symbol: 'USDC' } },
  worldchain: { usdc: { address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6, symbol: 'USDC' } },
  monad: { usdc: { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, symbol: 'USDT0' } },
  sei: { usdc: { address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6, symbol: 'USD₮0' } },
  xdc: { usdc: { address: '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1', decimals: 6, symbol: 'USDC' } },
  hyperevm: { usdc: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6, symbol: 'USD₮0' } },
  ink: { usdc: { address: '0x2D270e6886d130D724215A266106e6832161EAEd', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x0200C29006150606B650577BBE7B6248F58470c1', decimals: 6, symbol: 'USD₮0' } },
  plume: { usdc: { address: '0x222365EF19F7947e5484218551B56bb3965Aa7aF', decimals: 6, symbol: 'USDC' } },
  arc: { usdc: { address: '0x3600000000000000000000000000000000000000', decimals: 6, symbol: 'USDC' } },
  edge: { usdc: { address: '0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c', decimals: 6, symbol: 'USDC' } },
  morph: { usdc: { address: '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, symbol: 'USDT0' } },
  pharos: { usdc: { address: '0xC879C018dB60520F4355C26eD1a6D572cdAC1815', decimals: 6, symbol: 'USDC' } },
  cronos: { usdc: { address: '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D', decimals: 6, symbol: 'USDC' } },
  plasma: { usdc: { address: '0x2d661C89D812261039AF9764eceaAee884f5F67F', decimals: 6, symbol: 'USDC' }, usdt: { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6, symbol: 'USDT0' } },
  xlayer: { usdc: { address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, symbol: 'USD₮0' } },
  solana: { usdc: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' }, usdt: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT' } },
  // Binance-Peg, with 18 decimals.
  bnb: { usdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' }, usdt: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' } },
  celo: { usdc: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, symbol: 'USDC' }, usdt: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, symbol: 'USD₮' } },
  zksync: { usdc: { address: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', decimals: 6, symbol: 'USDC' } },
  gnosis: { usdc: { address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', decimals: 6, symbol: 'USDC' } },
  sui: { usdc: { address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', decimals: 6, symbol: 'USDC' } },
  tron: { usdt: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' } },
  // Perps USDC, the registry's gas token there (LI.FI's address for it).
  hyperliquid: { usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' } },
  megaeth: { usdt: { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6, symbol: 'USDT0' } },
  berachain: { usdt: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, symbol: 'USD₮0' } },
  mantle: { usdt: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, symbol: 'USDT0' } },
  stable: { usdt: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, symbol: 'USDT0' } },
  tempo: { usdt: { address: '0x20C00000000000000000000014f22CA97301EB73', decimals: 6, symbol: 'USDT0' } },
  flare: { usdt: { address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, symbol: 'USD₮0' } },
  rootstock: { usdt: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, symbol: 'USD₮0' } },
  'conflux-espace': { usdt: { address: '0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff', decimals: 6, symbol: 'USDT0' } },
  kaia: { usdt: { address: '0xd077A400968890Eacc75cdc901F0356c943e4fDb', decimals: 6, symbol: 'USD₮' } },
  noble: { usdc: { address: 'uusdc', decimals: 6, symbol: 'USDC' } },
  osmosis: {
    usdc: { address: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', decimals: 6, symbol: 'USDC' },
    usdt: { address: 'ibc/4ABBEF4C8926DDDB320AE5188CFD63267ABBCEFC0583E4AE05D6E5AA2401DDAB', decimals: 6, symbol: 'USDT' }, // Kava's Tether-issued USDT
  },
  dydx: { usdc: { address: 'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5', decimals: 6, symbol: 'USDC' } },
  neutron: { usdc: { address: 'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81', decimals: 6, symbol: 'USDC' } },
  kava: { usdt: { address: 'erc20/tether/usdt', decimals: 6, symbol: 'USDT' } },
}

// Whether a token is one of the chain's canonical stables, and which.
export function stableOf(chain: string, address: string): StableKind | undefined {
  const s = STABLES[chain]
  if (s?.usdc && sameAddress(s.usdc.address, address)) return 'usdc'
  if (s?.usdt && sameAddress(s.usdt.address, address)) return 'usdt'
}
