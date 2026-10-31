import { erc20Abi, formatEther, formatUnits, isAddress, isHex, parseAbi, parseUnits, type Hex } from 'viem'
import { describe, HttpError, serial } from './cctp'
import { injective, INJECTIVE_DOMAIN, network, relayer, swapMaxUsdc, txUrl } from './config'
import { db } from './indexer'

// USDC → INJ on Injective, gas free for the user. Their wallet signs an EIP-3009 ReceiveWithAuthorization, which lets
// only the relayer pull the USDC. The relayer then buys INJ with a market order on Injective's INJ/USDC orderbook
// (through the exchange precompile), sends the INJ to the wallet, and sends back whatever USDC the order didn't use.
// Market orders fill at the end of the block, so the fill is read from Injective's indexer.
// https://docs.injective.network/developers-evm/exchange-precompile

const MARKET = '0xa8c14f892f7f7d2516442220a05b652d5afee3f57a5495981dfad7c99ef78e84' // INJ/USDC, quoted in the CCTP USDC
const EXCHANGE: Hex = '0x0000000000000000000000000000000000000065'
const LCD = 'https://sentry.lcd.injective.network'
const INDEXER = 'https://sentry.exchange.grpc-web.injective.network'
const E18 = 10n ** 18n
const TICK = 10n ** 15n // 0.001: the market's price tick (USDC) and quantity tick (INJ)
const TAKER_FEE = 10n ** 12n // 0.000001, ×1e18
const MIN_USDC = 1_100_000n // orders must be worth at least 1 USDC
const SLIPPAGE = 2n // per mille: how far the book may move up between the quote and the order

export const swapsEnabled = !!relayer && network === 'mainnet'

const usdcAbi = parseAbi([
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function name() view returns (string)',
  'function version() view returns (string)',
])
const exchangeAbi = parseAbi([
  'function createSpotMarketOrder(address sender, (string marketID, string subaccountID, string feeRecipient, uint256 price, uint256 quantity, string cid, string orderType, uint256 triggerPrice) order) returns ((string orderHash, string cid, uint256 quantity, uint256 price, uint256 fee))',
])

db.run(`CREATE TABLE IF NOT EXISTS swaps (
  id TEXT PRIMARY KEY, -- the authorization's nonce
  owner TEXT NOT NULL,
  value TEXT NOT NULL, -- USDC units pulled from the owner
  valid_before INTEGER NOT NULL,
  status TEXT NOT NULL, -- new → received → ordered → done, or failed
  quantity TEXT, -- INJ wei ordered
  inj TEXT, -- INJ wei sent to the owner
  refund TEXT, -- USDC units sent back
  payout_tx TEXT,
  refund_tx TEXT,
  created INTEGER NOT NULL
)`)
type Swap = { id: Hex; owner: Hex; value: string; valid_before: number; status: string; quantity: string | null; inj: string | null; refund: string | null; payout_tx: string | null; refund_tx: string | null }
const getSwap = (id: string) => db.query<Swap, [string]>('SELECT * FROM swaps WHERE id = ?').get(id)!
const setSwap = (id: string, fields: Partial<Swap>) => {
  const keys = Object.keys(fields)
  db.query(`UPDATE swaps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(fields) as string[]), id)
}

// ---- Pricing --------------------------------------------------------------------------------------

type Level = { price: bigint; quantity: bigint } // USDC per INJ ×1e18, INJ wei

export async function asks(): Promise<Level[]> {
  const res = await fetch(`${LCD}/injective/exchange/v2/spot/orderbook/${MARKET}?limit=100`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  if (!res?.ok) throw new HttpError(502, 'Could not load the INJ/USDC market, try again.')
  const { sells_price_level } = (await res.json()) as { sells_price_level: { p: string; q: string }[] }
  return sells_price_level.map((l) => ({ price: parseUnits(l.p, 18), quantity: parseUnits(l.q, 18) }))
}

// The market buy that `usdc` (6 decimals) pays for: its worst price, a little above the ask the last INJ costs, and the most
// INJ the exchange can hold quantity × worst price (+ taker fee) for.
export function plan(levels: Level[], usdc: bigint) {
  let budget = usdc * 10n ** 12n // USDC ×1e18
  let marginal = 0n
  for (const { price, quantity } of levels) {
    marginal = price
    const cost = (price * quantity) / E18
    if (cost >= budget) {
      budget = 0n
      break
    }
    budget -= cost
  }
  if (budget > 0n || !marginal) throw new HttpError(409, 'Not enough INJ on the market for this amount right now, try less.')
  const worst = ceil((marginal * (1000n + SLIPPAGE)) / 1000n, TICK)
  const quantity = floor((usdc * 10n ** 12n * E18 * E18) / (worst * (E18 + TAKER_FEE)), TICK)
  return { worst, quantity }
}
const ceil = (value: bigint, step: bigint) => ((value + step - 1n) / step) * step
const floor = (value: bigint, step: bigint) => (value / step) * step

function parseAmount(amount: string) {
  const usdc = /^\d+(\.\d{1,6})?$/.test(amount) ? parseUnits(amount, 6) : undefined
  if (!usdc) throw new HttpError(400, 'Invalid amount.')
  if (usdc < MIN_USDC) throw new HttpError(400, `The minimum is ${formatUnits(MIN_USDC, 6)} USDC.`)
  if (usdc > swapMaxUsdc) throw new HttpError(400, `The maximum is ${formatUnits(swapMaxUsdc, 6)} USDC.`)
  return usdc
}

let domain: Promise<{ name: string; version: string }> | undefined
const usdcDomain = () =>
  (domain ??= Promise.all([
    injective.client.readContract({ address: injective.usdc, abi: usdcAbi, functionName: 'name' }),
    injective.client.readContract({ address: injective.usdc, abi: usdcAbi, functionName: 'version' }),
  ]).then(([name, version]) => ({ name, version }), (err) => ((domain = undefined), Promise.reject(err))))

// What `amount` USDC buys now, and what the wallet signs to pay for it.
export async function swapQuote(amount: string) {
  if (!swapsEnabled) throw new HttpError(503, 'Swaps are disabled on this server.')
  const usdc = parseAmount(amount)
  const [{ quantity }, { name, version }] = await Promise.all([asks().then((levels) => plan(levels, usdc)), usdcDomain()])
  return {
    amount: formatUnits(usdc, 6),
    inj: formatEther(quantity),
    minInj: formatEther(floor((quantity * 995n) / 1000n, TICK)), // the book may move a little before the swap is sent
    price: formatUnits((usdc * 10n ** 12n * E18) / quantity, 18),
    to: relayer!.account.address,
    domain: { name, version, chainId: injective.chain.id, verifyingContract: injective.usdc },
  }
}

// ---- Swapping -------------------------------------------------------------------------------------

export type SwapRequest = { from: string; value: string; validAfter: number; validBefore: number; nonce: string; signature: string; minInj: string }

let running = Promise.resolve()

// Checks everything it can before any funds move: the signature (by simulating the USDC pull) and the price.
export async function swap(input: SwapRequest) {
  if (!swapsEnabled) throw new HttpError(503, 'Swaps are disabled on this server.')
  const { from, validAfter, validBefore, nonce, signature } = input
  const valid = isAddress(from) && isHex(nonce) && nonce.length === 66 && isHex(signature) && /^\d+$/.test(input.value) && /^\d+(\.\d{1,18})?$/.test(input.minInj)
  if (!valid) throw new HttpError(400, 'Invalid request.')
  const value = parseAmount(formatUnits(BigInt(input.value), 6))
  const minInj = parseUnits(input.minInj, 18)
  if (validBefore < Date.now() / 1000 + 60) throw new HttpError(400, 'The authorization expires too soon, sign a new one.')
  if (db.query('SELECT 1 FROM swaps WHERE id = ?').get(nonce)) throw new HttpError(409, 'This swap was already sent.')

  const args = [from, relayer!.account.address, value, BigInt(validAfter), BigInt(validBefore), nonce, signature] as const
  await injective.client.simulateContract({ account: relayer!.account, address: injective.usdc, abi: usdcAbi, functionName: 'receiveWithAuthorization', args }).catch((err) => {
    throw new HttpError(400, `The USDC transfer was refused: ${describe(err)}.`)
  })
  const order = plan(await asks(), value)
  if (order.quantity < minInj) throw new HttpError(409, 'The price moved, check the new quote and try again.')

  // One swap at a time: each reads its fill and USDC back from the relayer's balances.
  const job = running.then(() => execute(args, order))
  running = job.then(() => {}, () => {})
  return job
}

async function execute(args: readonly [Hex, Hex, bigint, bigint, bigint, Hex, Hex], order: { worst: bigint; quantity: bigint }) {
  const [owner, , value, , validBefore, id] = args
  db.query("INSERT INTO swaps (id, owner, value, valid_before, status, created) VALUES (?, ?, ?, ?, 'new', ?)").run(id, owner.toLowerCase(), String(value), Number(validBefore), Date.now())
  try {
    await send('receiveWithAuthorization', { address: injective.usdc, abi: usdcAbi, functionName: 'receiveWithAuthorization', args })
  } catch (err) {
    setSwap(id, { status: 'failed' })
    throw new HttpError(502, `Could not pull the USDC: ${describe(err)}.`)
  }
  setSwap(id, { status: 'received' })
  try {
    const sub = subaccount()
    const cid = id.slice(2, 34)
    await send('market order', {
      address: EXCHANGE,
      abi: exchangeAbi,
      functionName: 'createSpotMarketOrder',
      args: [relayer!.account.address, { marketID: MARKET, subaccountID: sub, feeRecipient: '', price: order.worst, quantity: order.quantity, cid, orderType: 'buy', triggerPrice: 0n }],
    })
    setSwap(id, { status: 'ordered', quantity: String(order.quantity) })
  } catch (err) {
    console.error(`[swap] ${id}: order failed, refunding:`, describe(err))
    // Unless it was never sent, it may have gone through after all.
    const fill = err instanceof Unsent ? undefined : await waitForFill(id, 15_000)
    return finish(id, fill ?? { inj: 0n, spent: 0n })
  }
  const fill = await waitForFill(id)
  // The indexer is behind: the background loop finishes it.
  if (!fill) return { status: 'pending' as const, inj: formatEther(order.quantity), refund: null, txHash: null, txUrl: undefined }
  return finish(id, fill)
}

// Sends the INJ the order bought and the USDC it didn't spend.
async function finish(id: Hex, { inj, spent }: { inj: bigint; spent: bigint }) {
  const s = getSwap(id)
  const owner = s.owner as Hex
  if (inj > 0n && !s.payout_tx) {
    const hash = await serial(async () => {
      const hash = await relayer!.sendTransaction({ to: owner, value: inj })
      const receipt = await injective.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
      if (receipt.status !== 'success') throw new Error(`INJ transfer ${hash} reverted`)
      return hash
    })
    setSwap(id, { inj: String(inj), payout_tx: hash })
  }
  const balance = await injective.client.readContract({ address: injective.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [relayer!.account.address] })
  const refund = [BigInt(s.value) - spent, balance].reduce((a, b) => (a < b ? a : b))
  if (refund > 0n && !s.refund_tx) {
    const hash = await send('refund', { address: injective.usdc, abi: erc20Abi, functionName: 'transfer', args: [owner, refund] })
    setSwap(id, { refund: String(refund), refund_tx: hash })
  }
  setSwap(id, { status: 'done' })
  const done = getSwap(id)
  console.log(`[swap] ${formatUnits(BigInt(done.value), 6)} USDC from ${owner}: ${formatEther(inj)} INJ, ${formatUnits(refund > 0n ? refund : 0n, 6)} USDC back`)
  const txHash = (done.payout_tx ?? done.refund_tx) as Hex | null
  return { status: 'done' as const, inj: formatEther(inj), refund: refund > 0n ? formatUnits(refund, 6) : null, txHash, txUrl: txHash ? txUrl(INJECTIVE_DOMAIN, txHash) : undefined }
}

// The transaction wasn't sent: its simulation failed.
class Unsent extends Error {}

// Simulated first, so a revert costs no gas; padded, as USDC on Injective runs a compliance hook on transfers.
async function send(label: string, call: { address: Hex; abi: any; functionName: string; args: readonly unknown[] }) {
  return serial(async () => {
    const gas = await injective.client.estimateContractGas({ account: relayer!.account, ...call } as never).catch((err) => {
      throw new Unsent(describe(err))
    })
    const hash = await relayer!.writeContract({ ...call, gas: (gas * 3n) / 2n } as never)
    const receipt = await injective.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') throw new Error(`${label} transaction ${hash} reverted`)
    return hash
  })
}

const subaccount = () => `${relayer!.account.address.toLowerCase()}${'0'.repeat(24)}`

// The order's fill from Injective's indexer, once its block is indexed: INJ bought and USDC spent (fees included).
export async function waitForFill(id: Hex, timeoutMs = 45_000, cid = id.slice(2, 34), sub = subaccount()) {
  const query = `subaccountId=${sub}&marketIds=${MARKET}&limit=50`
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await Bun.sleep(1500)
    try {
      const { orders = [] } = await indexer<{ orders?: { cid: string; orderHash: string; isActive: boolean; filledQuantity: string }[] }>(`/api/exchange/spot/v1/ordersHistory?${query}`)
      const order = orders.find((o) => o.cid === cid && !o.isActive)
      if (!order) continue
      const inj = BigInt(order.filledQuantity)
      if (!inj) return { inj, spent: 0n }
      const { trades = [] } = await indexer<{ trades?: { orderHash: string; price: { price: string; quantity: string }; fee: string }[] }>(`/api/exchange/spot/v2/trades?${query}`)
      const fills = trades.filter((t) => t.orderHash === order.orderHash)
      if (fills.reduce((sum, t) => sum + BigInt(t.price.quantity), 0n) !== inj) continue // trades not indexed yet
      // Prices are in USDC units per INJ wei; rounding up keeps the refund within what the order left.
      const spent = fills.reduce((sum, t) => sum + (parseUnits(t.price.price, 18) * BigInt(t.price.quantity) + parseUnits(t.fee, 18)) / E18 + 1n, 0n)
      return { inj, spent }
    } catch {}
  }
}

async function indexer<T>(path: string): Promise<T> {
  const res = await fetch(INDEXER + path, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`indexer ${res.status}`)
  return res.json() as Promise<T>
}

// ---- Recovery -------------------------------------------------------------------------------------

// Finishes swaps a restart or an indexer delay left halfway: USDC pulled but no order is sent back in full,
// an order placed gets its fill paid out.
export async function resumeSwaps() {
  if (!swapsEnabled) return
  while (true) {
    await Bun.sleep(60_000)
    const job = running.then(resumeOnce)
    running = job.then(() => {}, () => {})
    await job
  }
}

async function resumeOnce() {
  const open = db.query<Swap, [number]>("SELECT * FROM swaps WHERE status IN ('new', 'received', 'ordered') AND created < ?").all(Date.now() - 120_000)
  for (const s of open) {
    try {
      if (s.status === 'new') {
        const pulled = await injective.client.readContract({ address: injective.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [s.owner as Hex, s.id] })
        if (!pulled && s.valid_before < Date.now() / 1000) setSwap(s.id, { status: 'failed' })
        if (!pulled) continue
      }
      // Without an order (or one a restart cut off before it was recorded) the USDC goes back.
      const fill = await waitForFill(s.id, 10_000)
      if (fill || s.status !== 'ordered') await finish(s.id, fill ?? { inj: 0n, spent: 0n })
    } catch (err) {
      console.error(`[swap] could not finish ${s.id}:`, describe(err))
    }
  }
}
