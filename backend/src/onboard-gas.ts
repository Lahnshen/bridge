import { within } from './cctp'
import { evmClient, type ChainInfo } from './chains'

// Gas for onboarding plans (see ./onboard.ts): what each destination needs, what a plan's transactions cost on each
// chain, and what a gas token keeps when it's moved itself. Measured on 2026-11-05 (gas-needs research); the costs are
// recomputed from the live gas price at plan time.

// Per destination: the gas to get when there's none, and the balance that counts as enough, in dollars. Elsewhere
// $0.50 and $0.05. On STABLE_GAS chains the stablecoin pays the gas, so there's nothing to get.
export const GAS: Record<string, [starterUsd: number, hasGasUsd: number]> = {
  injective: [1.1, 0.04], ethereum: [5, 3], base: [0.5, 0.05], arbitrum: [0.5, 0.1], optimism: [0.5, 0.05], polygon: [0.5, 0.1], avalanche: [0.5, 0.05],
  bnb: [0.5, 0.1], solana: [1, 0.3], monad: [0.25, 0.05], hyperevm: [1, 0.2], sonic: [0.5, 0.05], sei: [0.5, 0.05], unichain: [0.5, 0.05], linea: [1, 0.35],
  plasma: [0.25, 0.01], osmosis: [0.25, 0.02], arc: [0, 0.03], stable: [0, 0.01], tempo: [0, 0.01], noble: [0, 0.05], hyperliquid: [0, 0],
}
export const STABLE_GAS = new Set(['arc', 'stable', 'tempo', 'noble', 'hyperliquid'])

// What a gas token keeps when it's moved itself, besides twice the plan's gas there: in dollars, else $0.05; in the token
// on Solana, Injective and Monad (an account that would drop below 10 MON can't send there). The frontend uses the same.
const FLOOR_USD: Record<string, number> = { ethereum: 4, linea: 1, hyperevm: 0.15 }
const FLOOR_UNITS: Record<string, bigint> = { solana: 10_000_000n, injective: 10n ** 15n, monad: 10n * 10n ** 18n }

// Gas per transaction (an approval first for ERC20s, a CCTP burn always has one): a swap 300k, a bridge deposit 150k, a
// burn 120k (measured 112–118k). Monad charges the whole gas limit, which wallets set above what's used. On Solana in
// lamports: a swap with room for creating the token account it pays into (0.002 SOL), a burn also its event account; a
// bridge deposit only its fees (the bridge's accounts exist), with room for priority fees.
export type Tx = 'swap' | 'bridge' | 'cctp'
const UNITS: Record<Tx, bigint> = { swap: 300_000n, bridge: 150_000n, cctp: 120_000n }
const APPROVE = 50_000n
const LAMPORTS: Record<Tx, bigint> = { swap: 2_000_000n, bridge: 500_000n, cctp: 3_000_000n }
// On Cosmos chains, the gas limit a transaction is sent with (see ./cosmos.ts: half again what it simulated): a swap
// through Skip's contracts is a CosmWasm call, 0.75–1.9M gas used on Injective's Cosmos side (Nov 2026); a transfer or
// a burn far less.
const COSMOS_GAS: Record<Tx, number> = { swap: 3_000_000, bridge: 450_000, cctp: 450_000 }
// OP Stack chains add an L1 data fee to each transaction: ~1.5e-8 ETH in Nov 2026, allowed for at 1e-7.
const OP_STACK = new Set([10, 8453, 130, 480, 57073, 1868, 34443, 7777777, 1135, 81457, 252, 5330, 60808, 360])
const L1_FEE = 100_000_000_000n

// Each EVM chain's gas price, kept 30 seconds; undefined when its RPC doesn't answer.
const prices = new Map<string, { at: number; price: Promise<bigint | undefined> }>()
export function gasPrice(chain: ChainInfo): Promise<bigint | undefined> {
  const hit = prices.get(chain.id)
  if (hit && Date.now() - hit.at < 30_000) return hit.price
  const client = evmClient(chain)
  const price = client ? within(client.getGasPrice(), 5000).catch(() => undefined) : Promise.resolve(undefined)
  const entry = { at: Date.now(), price }
  prices.set(chain.id, entry)
  void price.then((p) => p === undefined && prices.get(chain.id) === entry && prices.delete(chain.id))
  return price
}

// What one transaction costs on the chain, in its gas token's base units (wei, lamports, the fee denom), padded by half
// for gas prices moving; undefined when the gas price isn't known. erc20: an approval comes first.
export function txCost(chain: ChainInfo, tx: Tx, erc20: boolean, gasPriceWei?: bigint): bigint | undefined {
  if (chain.kind === 'hypercore') return 0n
  if (chain.kind === 'solana') return LAMPORTS[tx]
  if (chain.kind === 'cosmos') {
    const price = Number(chain.gas?.price)
    return price > 0 ? BigInt(Math.ceil(COSMOS_GAS[tx] * price)) : undefined
  }
  if (gasPriceWei === undefined) return
  const approve = erc20 || tx === 'cctp'
  const units = (UNITS[tx] + (approve ? APPROVE : 0n)) * (chain.chainId === 143 ? 2n : 1n)
  return (units * gasPriceWei * 3n) / 2n + (OP_STACK.has(chain.chainId ?? 0) ? L1_FEE * (approve ? 2n : 1n) : 0n)
}

// What a gas token keeps, in its own base units: the floor, or twice the plan's gas there (need, in wei on EVM chains).
// Arc's and Stable's gas tokens are 6-decimal ERC20s, while gas is counted in 18-decimal wei.
export function reserveOf(chain: ChainInfo, decimals: number, price: number | undefined, need: bigint | undefined) {
  const fixed = FLOOR_UNITS[chain.id]
  const floor = fixed ?? (price ? BigInt(Math.ceil(((FLOOR_USD[chain.id] ?? 0.05) / price) * 10 ** Math.min(decimals, 15))) * 10n ** BigInt(Math.max(decimals - 15, 0)) : 0n)
  const gas = need === undefined ? 0n : chain.kind === 'evm' && decimals < 18 ? (2n * need) / 10n ** BigInt(18 - decimals) : 2n * need
  return floor > gas ? floor : gas
}
