import { decodeFunctionData, erc20Abi, type Hex } from 'viem'
import { decimal, getJson, idOn, ProviderError, reaches, tokenOn, usdValue, type Progress, type Provider, type Step } from './shared'

// LayerZero's Value Transfer API: OFTs, Stargate, CCTP and Aori behind one quote, Injective EVM included.
// https://docs.layerzero.network/v2/developers/value-transfer-api/overview, spec: https://docs.layerzero.network/openapi/vt-api.json
// Quotes, steps and status need LAYERZERO_API_KEY (from LayerZero); without one the provider is off.

const API = 'https://transfer.layerzero-api.com/v1'
const key = process.env.LAYERZERO_API_KEY
const headers = { 'x-api-key': key ?? '' }

// Chains go by their chainKey ("ethereum", "injective", "aptos"), from its chain list (../chains.ts, loaded only with a
// key). The gas token is 0xEeee…EEeE on EVM chains and a pseudo-mint on Solana: the list's nativeCurrency says which.

type UserStep = {
  type: 'TRANSACTION' | 'SIGNATURE'
  chainKey: string
  chainType?: string
  // EVM: to, data, value, chainId (gasLimit optional). Solana: encoding 'base64' and data, the serialized transaction.
  transaction?: { encoded: { to?: Hex; data: string; value?: string; chainId?: number; gasLimit?: string; encoding?: string } }
}
type LzQuote = {
  id: string
  routeSteps: { type: string; srcChainKey: string; description?: string }[]
  fees?: { chainKey: string; type: string; amount: string; address: string }[]
  duration?: { estimated: string | null } // ms
  feeUsd?: string
  srcAmount: string
  dstAmount: string
  dstAmountMin?: string
  userSteps?: UserStep[]
}
type LzToken = { chainKey: string; address: string; decimals: number; price?: { usd: number } }
type LzStatus = {
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
  executionHistory?: { event: string; transaction?: { chainKey: string; hash: string } }[]
}

const ROUTES: Record<string, string> = { OFT: 'OFT', OFT_V2: 'OFT', STARGATE_V2_TAXI: 'Stargate', STARGATE_V2_BUS: 'Stargate Bus', CCTP: 'CCTP', AORI: 'Aori', AORI_V1: 'Aori' }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const noKey = () => new ProviderError(401, 'LayerZero needs LAYERZERO_API_KEY.')

// Transactions only. SIGNATURE steps (Aori's EIP-712 intents, posted back through /submit-signature) have no Step kind.
function toStep(s: UserStep): Step | undefined {
  const tx = s.transaction?.encoded
  if (s.type !== 'TRANSACTION' || !tx) return
  if (s.chainType === 'SOLANA') return tx.encoding === 'base64' ? { kind: 'solana', transaction: tx.data } : undefined
  if (s.chainType !== 'EVM' || !tx.to || !tx.chainId) return
  // The ERC-20 approval of LayerZero's TransferDelegate, as an approve step so the app can skip it when the allowance covers it.
  if (tx.data.startsWith('0x095ea7b3')) {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
    if (functionName === 'approve') return { kind: 'approve', chainId: tx.chainId, token: tx.to, spender: args[0], amount: args[1].toString() }
  }
  return { kind: 'evm', chainId: tx.chainId, to: tx.to, data: tx.data as Hex, value: decimal(tx.value), gas: tx.gasLimit && decimal(tx.gasLimit) }
}

export const layerzero: Provider = {
  id: 'layerzero',
  name: 'LayerZero',
  enabled: !!key,
  supports: (from, to) => reaches('layerzero', from, to),

  // https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/quotes
  async quote(req, signal) {
    if (!key) throw noKey()
    const src = { chainKey: String(idOn('layerzero', req.from)), native: req.from.natives.layerzero?.address ?? '' }
    const body = {
      srcChainKey: src.chainKey,
      dstChainKey: String(idOn('layerzero', req.to)),
      srcTokenAddress: tokenOn('layerzero', req.from, req.fromToken),
      dstTokenAddress: tokenOn('layerzero', req.to, req.toToken),
      srcWalletAddress: req.sender,
      dstWalletAddress: req.recipient,
      amount: req.amount.toString(),
      // The fee tolerance sets dstAmountMin, i.e. it's the slippage.
      options: { amountType: 'EXACT_SRC_AMOUNT', feeTolerance: { type: 'PERCENT', amount: req.slippageBps / 100 } },
    }
    const res = await getJson<{ quotes?: LzQuote[]; tokens?: LzToken[] }>(`${API}/quotes`, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(
      (err) => {
        // 400 for tokens or pairs it doesn't route.
        if (err instanceof ProviderError && (err.status === 400 || err.status === 404)) return undefined
        throw err
      },
    )
    // Several routes may come back: the one delivering the most among those the app can execute.
    const doable = (q: LzQuote) => (q.userSteps ?? []).every((s) => toStep(s) || (s.type === 'TRANSACTION' && s.chainType === 'SOLANA'))
    const q = res?.quotes?.filter(doable).reduce<LzQuote | undefined>((best, q) => (!best || BigInt(q.dstAmount) > BigInt(best.dstAmount) ? q : best), undefined)
    if (!q) return

    // Solana transactions carry a blockhash that lasts about a minute, so they're built separately from the quote.
    const userSteps =
      !req.preview && req.from.kind === 'solana'
        ? (await getJson<{ userSteps: UserStep[] }>(`${API}/build-user-steps`, { method: 'POST', headers, body: JSON.stringify({ quoteId: q.id }), signal })).userSteps
        : (q.userSteps ?? [])
    const steps = userSteps.map(toStep)
    if (!req.preview && (!steps.length || steps.some((s) => !s))) return

    // LayerZero's messaging fee, paid in the source chain's gas token on top of the amount; in USD when the quote prices it.
    const native = (q.fees ?? [])
      .filter((f) => f.type === 'MESSAGE' && f.chainKey === src.chainKey && same(f.address, src.native))
      .reduce((total, f) => total + BigInt(f.amount), 0n)
    const gasToken = res?.tokens?.find((t) => t.chainKey === src.chainKey && same(t.address, src.native))
    const costUsd = native && gasToken?.price ? (Number(native) / 10 ** gasToken.decimals) * gasToken.price.usd : undefined
    // The amounts in USD, at the prices the quote lists for its tokens.
    const priced = (chainKey: string, address: string, amount: string) => {
      const t = res?.tokens?.find((t) => t.chainKey === chainKey && same(t.address, address))
      return t?.price ? usdValue((Number(amount) / 10 ** t.decimals) * t.price.usd) : undefined
    }
    const ms = Number(q.duration?.estimated)
    return {
      provider: 'layerzero',
      via: [...new Set((q.routeSteps ?? []).map((r) => ROUTES[r.type] ?? r.type))].join(' + ') || undefined,
      amountOut: q.dstAmount,
      minAmountOut: q.dstAmountMin ?? q.dstAmount,
      seconds: ms > 0 ? Math.round(ms / 1000) : 600, // no estimate: assume ten minutes
      feeUsd: Number(q.feeUsd) || 0, // srcAmountUsd - dstAmountUsd, taken out of the transfer
      usdIn: priced(body.srcChainKey, body.srcTokenAddress, q.srcAmount),
      usdOut: priced(body.dstChainKey, body.dstTokenAddress, q.dstAmount),
      costUsd,
      costNative: costUsd === undefined && native ? native.toString() : undefined,
      steps: req.preview ? [] : (steps as Step[]),
      track: { quoteId: q.id },
    }
  },

  // https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/status (OFT and Stargate routes need txHash)
  async status({ txHash, track }) {
    if (!key) throw noKey()
    if (!track.quoteId) throw new ProviderError(400, 'Missing the LayerZero quote id.')
    const s = await getJson<LzStatus>(`${API}/status/${encodeURIComponent(track.quoteId)}?${new URLSearchParams({ txHash })}`, { headers }).catch((err) => {
      // 404 and UNKNOWN: not seen yet, right after sending.
      if (err instanceof ProviderError && err.status === 404) return { status: 'UNKNOWN' } as LzStatus
      throw err
    })
    const result: Progress = { status: 'pending', destinationTx: s.executionHistory?.find((e) => e.event === 'DELIVERED')?.transaction?.hash }
    if (s.status === 'SUCCEEDED') result.status = 'done'
    else if (s.status === 'FAILED') result.status = 'failed'
    else if (s.status === 'UNKNOWN') result.note = "LayerZero hasn't seen the transfer yet."
    return result
  },
}
