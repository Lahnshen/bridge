import type { Hex } from 'viem'
import { decimal, getJson, idOn, isNative, ProviderError, reaches, sum, tokenOn, usdValue, type Progress, type Provider, type Step } from './shared'

// LI.FI: an aggregator of bridges and DEXs. https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
// Without LIFI_API_KEY it allows 200 requests per 2 hours for the whole server, so set one: https://portal.li.fi

const API = 'https://li.quest/v1'
const key = process.env.LIFI_API_KEY
const headers: Record<string, string> = key ? { 'x-lifi-api-key': key } : {}

type LifiQuote = {
  tool: string
  toolDetails?: { name: string }
  estimate: {
    toAmount: string
    toAmountMin: string
    fromAmountUSD?: string
    toAmountUSD?: string
    approvalAddress?: Hex
    executionDuration: number
    feeCosts?: { amountUSD?: string; included?: boolean }[]
    gasCosts?: { amountUSD?: string }[]
  }
  transactionRequest?: { to?: Hex; data: string; value?: string; gasLimit?: string; chainId?: number }
}

export const lifi: Provider = {
  id: 'lifi',
  name: 'LI.FI',
  enabled: true,
  supports: (from, to) => reaches('lifi', from, to),

  // Destinations include Bitcoin, Sui, Tron, Zcash, Hyperliquid and Lighter.
  async quote(req, signal) {
    const params = new URLSearchParams({
      fromChain: String(idOn('lifi', req.from)),
      toChain: String(idOn('lifi', req.to)),
      fromToken: tokenOn('lifi', req.from, req.fromToken),
      toToken: tokenOn('lifi', req.to, req.toToken),
      fromAmount: req.amount.toString(),
      fromAddress: req.sender,
      toAddress: req.recipient,
      slippage: String(req.slippageBps / 10_000),
    })
    const q = await getJson<LifiQuote>(`${API}/quote?${params}`, { headers, signal }).catch((err) => {
      // 404 (and 400 for unsupported pairs) means no route.
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) return undefined
      throw err
    })
    if (!q) return

    const { estimate: e, transactionRequest: tx } = q
    const steps: Step[] = []
    if (tx && req.from.kind === 'solana') steps.push({ kind: 'solana', transaction: tx.data })
    else if (tx?.to) {
      const chain = req.from.chainId!
      if (!isNative(req.from, req.fromToken) && e.approvalAddress) {
        steps.push({ kind: 'approve', chainId: chain, token: req.fromToken as Hex, spender: e.approvalAddress, amount: req.amount.toString() })
      }
      steps.push({ kind: 'evm', chainId: chain, to: tx.to, data: tx.data as Hex, value: decimal(tx.value), gas: tx.gasLimit && decimal(tx.gasLimit) })
    }
    return {
      provider: 'lifi',
      via: q.toolDetails?.name ?? q.tool,
      amountOut: e.toAmount,
      minAmountOut: e.toAmountMin,
      seconds: e.executionDuration,
      feeUsd: sum((e.feeCosts ?? []).filter((f) => f.included !== false).map((f) => f.amountUSD)),
      usdIn: usdValue(e.fromAmountUSD),
      usdOut: usdValue(e.toAmountUSD),
      costUsd: sum([...(e.gasCosts ?? []).map((g) => g.amountUSD), ...(e.feeCosts ?? []).filter((f) => f.included === false).map((f) => f.amountUSD)]),
      steps: req.preview ? [] : steps,
      track: { bridge: q.tool },
    }
  },

  // https://docs.li.fi/introduction/user-flows-and-examples/status-tracking
  async status({ txHash, from, to, track }) {
    const params = new URLSearchParams({ txHash, fromChain: String(idOn('lifi', from)), toChain: String(idOn('lifi', to)), ...(track.bridge && { bridge: track.bridge }) })
    type Status = { status: string; substatus?: string; substatusMessage?: string; receiving?: { txHash?: string; amount?: string } }
    const s = await getJson<Status>(`${API}/status?${params}`, { headers }).catch((err): Status => {
      // Right after sending, LI.FI may not have seen the tx yet.
      if (err instanceof ProviderError && err.status === 404) return { status: 'NOT_FOUND' }
      throw err
    })
    const result: Progress = { status: 'pending', destinationTx: s.receiving?.txHash, amountOut: s.receiving?.amount, note: s.substatusMessage }
    if (s.status === 'DONE') result.status = s.substatus === 'REFUNDED' ? 'refunded' : 'done'
    else if (s.status === 'FAILED' || s.status === 'INVALID') result.status = 'failed'
    return result
  },
}
