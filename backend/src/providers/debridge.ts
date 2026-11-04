import type { Hex } from 'viem'
import { network } from '../config'
import { base58Decode, solanaRpc } from '../solana'
import { decimal, getJson, idOn, isNative, ProviderError, reaches, sum, tokenOn, usdValue, type Provider, type Step } from './shared'

// deBridge (DLN): solvers fill an order on the destination chain from their own funds, so the amount the order asks for
// is what arrives (or the order is cancelled and refunded); there's no slippage to set.
// https://docs.debridge.com/dln-details/integration-guidelines/order-creation/creating-order/creating-order
// No key needed: 50 requests a minute per endpoint, 300 with DEBRIDGE_API_KEY (https://forms.gle/doWLQpr8oemphoaf9).

const API = 'https://dln.debridge.finance/v1.0'
const TRACKING = 'https://dln-api.debridge.finance/api'
const key = process.env.DEBRIDGE_API_KEY

type Cost = { type: string; amountIn: string; payload?: { feeAmount?: string } }
type CreateTx = {
  estimation: {
    srcChainTokenIn: { amount: string; approximateUsdValue: number }
    srcChainTokenOut?: { approximateUsdValue: number } // the reserve asset the input is swapped to first, if it isn't one
    dstChainTokenOut: { amount: string; approximateUsdValue?: number }
    costsDetails: Cost[]
  }
  tx?: { to?: Hex; data?: string; value?: string }
  order: { approximateFulfillmentDelay: number }
  orderId?: string // with tx only
  fixFee: string
  estimatedTransactionFee?: { total: string }
}

// Solver margin, protocol fee and the solver's gas are taken out of the reserve asset in flight; slippage buffers aren't fees.
const FEES = ['DlnProtocolFee', 'TakerMargin', 'EstimatedOperatingExpenses']

export const debridge: Provider = {
  id: 'debridge',
  name: 'deBridge',
  enabled: network === 'mainnet',
  // Chains by deBridge's own ids: chains added lately get ids of its own, e.g. Injective is 100000029, Tron 100000026.
  supports: (from, to) => reaches('debridge', from, to),

  async quote(req, signal) {
    const params = new URLSearchParams({
      srcChainId: String(idOn('debridge', req.from)),
      srcChainTokenIn: tokenOn('debridge', req.from, req.fromToken),
      srcChainTokenInAmount: req.amount.toString(),
      dstChainId: String(idOn('debridge', req.to)),
      dstChainTokenOut: tokenOn('debridge', req.to, req.toToken),
      dstChainTokenOutAmount: 'auto', // a fixed amount would make it a limit order solvers may ignore
      ...(!req.preview && {
        senderAddress: req.sender,
        srcChainOrderAuthorityAddress: req.sender, // also gets the refund if the order is cancelled
        dstChainOrderAuthorityAddress: req.recipient, // may cancel the order, so it must be the user's on that chain
        dstChainTokenOutRecipient: req.recipient,
      }),
      ...(key && { accesstoken: key }),
    })
    const q = await getJson<CreateTx>(`${API}/dln/order/create-tx?${params}`, { signal }).catch((err) => {
      // 400s are deBridge declining: amount too small (or over $5.5M), a token it doesn't know, no route.
      if (err instanceof ProviderError && err.status === 400) return undefined
      throw err
    })
    if (!q) return

    const { estimation: e, tx } = q
    const steps: Step[] = []
    if (tx?.data && req.from.kind === 'solana') steps.push({ kind: 'solana', transaction: await withBlockhash(tx.data) })
    else if (tx?.to && tx.data) {
      const chainId = req.from.chainId!
      // Without prependOperatingExpenses the order spends exactly the amount, so that's the allowance it needs.
      if (!isNative(req.from, req.fromToken)) steps.push({ kind: 'approve', chainId, token: req.fromToken as Hex, spender: tx.to, amount: req.amount.toString() })
      steps.push({ kind: 'evm', chainId, to: tx.to, data: tx.data as Hex, value: decimal(tx.value) })
    }

    const reserveUsd = (e.srcChainTokenOut ?? e.srcChainTokenIn).approximateUsdValue
    const fees = e.costsDetails.filter((c) => FEES.includes(c.type)).map((c) => (Number(c.payload?.feeAmount) / Number(c.amountIn)) * reserveUsd)
    // The flat fee is in the gas token: priced only when that's what is sent. Solana's transaction estimate already includes it.
    const gas = BigInt(q.estimatedTransactionFee?.total ?? 0)
    const paid = req.from.kind === 'solana' ? (gas > 0n ? gas : BigInt(q.fixFee)) : BigInt(q.fixFee) + gas
    return {
      provider: 'debridge',
      amountOut: e.dstChainTokenOut.amount,
      minAmountOut: e.dstChainTokenOut.amount,
      seconds: q.order.approximateFulfillmentDelay,
      feeUsd: sum(fees),
      usdIn: usdValue(e.srcChainTokenIn.approximateUsdValue),
      usdOut: usdValue(e.dstChainTokenOut.approximateUsdValue),
      costUsd: isNative(req.from, req.fromToken) ? (Number(paid) * e.srcChainTokenIn.approximateUsdValue) / Number(e.srcChainTokenIn.amount) : undefined,
      costNative: decimal(q.fixFee),
      steps: req.preview ? [] : steps,
      track: { ...(q.orderId && { orderId: q.orderId }) }, // previews have no order yet
    }
  },

  // https://docs.debridge.com/dln-details/integration-guidelines/order-creation/order-tracking-api/tracking-orders
  async status({ txHash, track }) {
    type Str = { stringValue?: string } | null
    type Order = {
      state: string
      takeOfferWithMetadata: { amount: Str }
      actualFulfillAmount?: Str
      fulfilledDstEventMetadata?: { transactionHash?: Str } | null
    }
    const url = track.orderId ? `${TRACKING}/Orders/${track.orderId}` : `${TRACKING}/Orders/creationTxHash/${txHash}`
    const o = await getJson<Order>(url).catch((err) => {
      // 422 "Order not found": not indexed yet, a few seconds after the source transaction.
      if (err instanceof ProviderError && (err.status === 422 || err.status === 404)) return undefined
      throw err
    })
    if (!o) return { status: 'pending' }
    switch (o.state) {
      case 'Fulfilled':
      case 'SentUnlock':
      case 'ClaimedUnlock':
        return {
          status: 'done',
          destinationTx: o.fulfilledDstEventMetadata?.transactionHash?.stringValue,
          amountOut: o.actualFulfillAmount?.stringValue ?? o.takeOfferWithMetadata.amount?.stringValue,
        }
      // Cancelled on the destination chain; the funds come back on the source chain once the cancel message is claimed there.
      case 'OrderCancelled':
      case 'SentOrderCancel':
        return { status: 'pending', note: 'Cancelled, refund on its way to the source chain.' }
      case 'ClaimedOrderCancel':
        return { status: 'refunded', note: 'Cancelled and refunded on the source chain.' } // the cancel tx is on the destination chain, not the refund
      default:
        return { status: 'pending' }
    }
  },
}

// deBridge's Solana transaction comes with an empty (all-zero) blockhash: put in a recent one so the wallet can sign it as is.
async function withBlockhash(hex: string) {
  const tx = Buffer.from(hex.slice(2), 'hex')
  // Signatures (count, 64 bytes each), the v0 prefix, a 3-byte header, account keys (count, 32 bytes each), then the blockhash.
  // Counts are single bytes: a transaction is too small for 128 of either.
  let at = 1 + 64 * tx[0]!
  if (tx[at]! & 0x80) at++
  at += 3
  at += 1 + 32 * tx[at]!
  if (tx.subarray(at, at + 32).every((b) => b === 0)) {
    const { value } = await solanaRpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
    tx.set(base58Decode(value.blockhash)!, at)
  }
  return tx.toString('base64')
}
