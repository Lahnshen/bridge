import type { Hex } from 'viem'
import { approval, decimal, getJson, idOn, ProviderError, reaches, sum, tokenOn, type Provider, type Step } from './shared'

// Across: relayers fill the transfer on the destination from their own funds and are repaid later; some routes go over
// Circle's CCTP (USDC) or OFT (USDT0) underneath. https://docs.across.to/introduction/swap-api
// Across asks for ACROSS_API_KEY and ACROSS_INTEGRATOR_ID (a 2-byte hex id) in production, from https://docs.across.to/tools/integrator-id.
// Without them it answers today, under stricter rate limits.

const API = 'https://app.across.to/api'
const key = process.env.ACROSS_API_KEY
const integratorId = process.env.ACROSS_INTEGRATOR_ID
const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}

type AcrossQuote = {
  approvalTxns?: { chainId: number; to: Hex; data: Hex }[]
  swapTx?: { ecosystem: 'evm' | 'svm'; chainId: number; to: Hex; data: string; value?: string; gas?: string }
  steps?: { bridge?: { provider?: string } }
  expectedOutputAmount: string
  minOutputAmount: string
  expectedFillTime: number
  fees?: { total?: { amountUsd?: string }; originGas?: { amountUsd?: string } }
}

const bridges: Record<string, string> = { cctp: 'CCTP', oft: 'OFT' }

export const across: Provider = {
  id: 'across',
  name: 'Across',
  enabled: true,
  // Injective isn't one of its chains; Tron, HyperCore and Lighter are destinations.
  supports: (from, to) => reaches('across', from, to),

  // https://docs.across.to/api-reference/swap/approval/get
  async quote(req, signal) {
    const params = new URLSearchParams({
      tradeType: 'exactInput',
      amount: req.amount.toString(),
      inputToken: tokenOn('across', req.from, req.fromToken),
      outputToken: tokenOn('across', req.to, req.toToken),
      originChainId: String(idOn('across', req.from)),
      destinationChainId: String(idOn('across', req.to)),
      depositor: req.sender,
      recipient: req.recipient,
      slippage: String(req.slippageBps / 10_000),
      ...(integratorId && { integratorId }),
      ...(req.preview && { skipOriginTxEstimation: 'true' }),
    })
    const q = await getJson<AcrossQuote>(`${API}/swap/approval?${params}`, { headers, signal }).catch((err) => {
      // 400 is an unsupported route or an amount too low or high; 404 a token it doesn't know.
      if (err instanceof ProviderError && (err.status === 400 || err.status === 404)) return undefined
      throw err
    })
    const tx = q?.swapTx
    if (!q || !tx) return

    const steps: Step[] = []
    // Solana: a serialized v0 transaction, already signed by the extra key CCTP needs, so its blockhash is fixed: send it within a minute.
    if (tx.ecosystem === 'svm') steps.push({ kind: 'solana', transaction: tx.data })
    else {
      for (const a of q.approvalTxns ?? []) steps.push(approval(a, req.amount) ?? { kind: 'evm', chainId: a.chainId, to: a.to, data: a.data, value: '0' })
      // Gas comes back as 0 when Across couldn't simulate (no allowance or balance yet); the wallet estimates then.
      steps.push({ kind: 'evm', chainId: tx.chainId, to: tx.to, data: tx.data as Hex, value: decimal(tx.value), gas: Number(tx.gas) > 0 ? tx.gas : undefined })
    }
    return {
      provider: 'across',
      via: bridges[q.steps?.bridge?.provider ?? ''],
      amountOut: q.expectedOutputAmount,
      minAmountOut: q.minOutputAmount,
      seconds: q.expectedFillTime,
      feeUsd: sum([q.fees?.total?.amountUsd]),
      costUsd: Number(q.fees?.originGas?.amountUsd) || undefined, // 0 when it wasn't simulated
      steps: req.preview ? [] : steps,
      track: {},
    }
  },

  // https://docs.across.to/introduction/tracking-deposits
  async status({ txHash, from }) {
    const params = new URLSearchParams({ depositTxnRef: txHash, originChainId: String(idOn('across', from)) })
    type Status = { status: string; fillTx?: string | null; depositRefundTxHash?: string | null }
    const s = await getJson<Status>(`${API}/deposit/status?${params}`, { headers }).catch((err): Status => {
      // Across indexes deposits every 10 s or so: a fresh one isn't found yet.
      if (err instanceof ProviderError && err.status === 404) return { status: 'pending' }
      throw err
    })
    if (s.status === 'filled') return { status: 'done', destinationTx: s.fillTx ?? undefined }
    if (s.status === 'refunded') return { status: 'refunded', destinationTx: s.depositRefundTxHash ?? undefined }
    // Unfilled by its deadline: Across refunds it to the sender on the source chain with a later settlement, several hours on.
    if (s.status === 'expired') return { status: 'refunded', note: 'Not filled in time; Across refunds it on the source chain within several hours.' }
    return { status: 'pending' }
  },
}
