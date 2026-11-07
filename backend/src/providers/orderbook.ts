import { decodeFunctionData, encodeFunctionData, formatUnits, parseAbi, parseUnits, type Hex } from 'viem'
import { evmClient, sameAddress } from '../chains'
import { network } from '../config'
import { stableOf } from '../stables'
import { denomOnSide } from '../tokens'
import { getJson, ProviderError, type Provider } from './shared'

// Injective's own orderbook, its exchange module (the one Helix trades on, Skip's "injective-native"): a market sell of a
// token for Injective's USDC or USDT, which the EVM wallet sends to the exchange precompile. That trades the wallet's default
// subaccount, its bank balance, as Get INJ's relayer does (see ../swap.ts). Skip has no INJ market there: its INJ routes
// go through Terra and back, which needs an address there. Only markets quoted in those two stables, and sells only.
// Prices and quantities are human-readable, scaled by 1e18: https://github.com/InjectiveLabs/solidity-contracts/blob/master/src/Exchange.sol

export const EXCHANGE: Hex = '0x0000000000000000000000000000000000000065'
const LCD = 'https://sentry.lcd.injective.network'
export const orderAbi = parseAbi([
  'function createSpotMarketOrder(address sender, (string marketID, string subaccountID, string feeRecipient, uint256 price, uint256 quantity, string cid, string orderType, uint256 triggerPrice) order) returns ((string orderHash, string cid, uint256 quantity, uint256 price, uint256 fee))',
])
// A wallet's default subaccount (nonce 0): the one that trades its bank balance.
export const defaultSubaccount = (address: string) => `${address.toLowerCase()}${'0'.repeat(24)}`

type Market = {
  market_id: string
  base_denom: string
  quote_denom: string
  taker_fee_rate: string
  min_price_tick_size: string
  min_quantity_tick_size: string
  min_notional: string
  base_decimals: number
  quote_decimals: number
}

// The active spot markets, kept 10 minutes.
let markets: { at: number; list: Promise<Market[]> } | undefined
function marketList() {
  if (!markets || Date.now() - markets.at > 600_000) {
    const entry = { at: Date.now(), list: getJson<{ markets: Market[] }>(`${LCD}/injective/exchange/v2/spot/markets?status=Active&pagination.limit=500`).then((r) => r.markets ?? []) }
    markets = entry
    entry.list.catch(() => markets === entry && (markets = undefined))
  }
  return markets.list
}

const E18 = 10n ** 18n
const dec = (value: string) => parseUnits(value, 18) // a human-readable decimal, ×1e18
const floor = (value: bigint, step: bigint) => (step > 0n ? (value / step) * step : value)

export const orderbook: Provider = {
  id: 'orderbook',
  name: 'Injective orderbook',
  enabled: network === 'mainnet',
  supports: (from, to) => from.id === to.id && from.ids.orderbook !== undefined,

  async quote(req, signal) {
    // The proceeds go to the wallet that sells: never a route to anyone else.
    const kind = stableOf(req.to.id, req.toToken)
    if (!kind || !sameAddress(req.recipient, req.sender)) return
    const [base, quote, list] = await Promise.all([denomOnSide(req.from, req.fromToken), denomOnSide(req.to, req.toToken), marketList()])
    const m = base && quote ? list.find((m) => m.base_denom === base && m.quote_denom === quote) : undefined
    if (!m) return
    // What it sells: the amount in the market's quantity steps (the rest, under one step, stays in the wallet).
    const quantity = floor((req.amount * E18) / 10n ** BigInt(m.base_decimals), dec(m.min_quantity_tick_size))
    if (!quantity) return
    const book = await getJson<{ buys_price_level?: { p: string; q: string }[] }>(`${LCD}/injective/exchange/v2/spot/orderbook/${m.market_id}?limit=100`, { signal })
    // Down the bids, best first, until the quantity is sold: the proceeds, and the lowest price it reaches.
    let [left, proceeds, lowest] = [quantity, 0n, 0n]
    for (const level of book.buys_price_level ?? []) {
      const [price, size] = [dec(level.p), dec(level.q)]
      const take = size < left ? size : left
      proceeds += (price * take) / E18
      left -= take
      lowest = price
      if (!left) break
    }
    if (left || !lowest) throw new ProviderError(400, 'Not enough bids on the orderbook for this amount right now')
    const best = dec(book.buys_price_level![0]!.p)
    // The order's worst price: the lowest bid reached, less the slippage, in the market's price steps.
    const limit = floor((lowest * BigInt(10_000 - req.slippageBps)) / 10_000n, dec(m.min_price_tick_size))
    if ((quantity * limit) / E18 < dec(m.min_notional)) throw new ProviderError(400, `Orders on Injective's orderbook must be worth at least ${formatUnits(dec(m.min_notional), 18)} ${kind.toUpperCase()}`)
    const fee = dec(m.taker_fee_rate)
    const units = (value: bigint) => (value * (E18 - fee) * 10n ** BigInt(m.quote_decimals)) / E18 / E18 // quote ×1e18, less the fee, in base units
    const amountOut = units(proceeds)
    const sender = req.sender as Hex
    const order = { marketID: m.market_id, subaccountID: defaultSubaccount(sender), feeRecipient: '', price: limit, quantity, cid: '', orderType: 'sell', triggerPrice: 0n }
    const data = encodeFunctionData({ abi: orderAbi, functionName: 'createSpotMarketOrder', args: [sender, order] })
    return {
      provider: 'orderbook',
      amountOut: amountOut.toString(),
      minAmountOut: units((quantity * limit) / E18).toString(),
      seconds: 2,
      feeUsd: Number(formatUnits((proceeds * fee) / E18, 18)),
      // In the stablecoin, at a dollar: at the best bid, and what it gets.
      usdIn: Number(formatUnits((quantity * best) / E18, 18)),
      usdOut: Number(formatUnits(amountOut, m.quote_decimals)),
      steps: req.preview ? [] : [{ kind: 'evm', chainId: req.from.chainId!, to: EXCHANGE, data, value: '0' }],
      track: {},
    }
  },

  // A market order fills in its own block: the transaction is all there is to follow.
  async status({ txHash, from }) {
    const receipt = await evmClient(from)
      ?.getTransactionReceipt({ hash: txHash as Hex })
      .catch(() => undefined)
    if (!receipt) return { status: 'pending' }
    return { status: receipt.status === 'success' ? 'done' : 'failed', destinationTx: txHash }
  },
}

// The order a step places, for ../safety.ts: undefined when its data isn't one.
export function orderOf(data: Hex) {
  try {
    const call = decodeFunctionData({ abi: orderAbi, data })
    return call.functionName === 'createSpotMarketOrder' ? { sender: call.args[0], order: call.args[1] } : undefined
  } catch {}
}
