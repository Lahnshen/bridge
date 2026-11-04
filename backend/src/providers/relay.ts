import type { Hex } from 'viem'
import { HYPERLIQUID_API, sameAddress, type ChainInfo } from '../chains'
import { base58Encode, publicKey, solanaRpc } from '../solana'
import { approval, decimal, getJson, idOn, ProviderError, reaches, sum, tokenOn, usdValue, type Progress, type Provider, type Step, type TypedData } from './shared'

// Relay: solvers fill the transfer on the destination from their own funds, then settle with Relay.
// https://docs.relay.link/references/api/get-quote-v2. Without RELAY_API_KEY quotes are limited (50 a minute per key, less
// anonymously), and Relay's docs say keys are required on /quote/v2 from October 2026: https://dashboard.relay.link

const API = 'https://api.relay.link'
const key = process.env.RELAY_API_KEY
const headers: Record<string, string> = key ? { 'x-api-key': key } : {}

type Amount = { amount: string; amountUsd?: string; minimumAmount: string }
type EvmTx = { chainId: number; to: Hex; data: Hex; value?: string; gas?: string | number }
type SolanaIx = { programId: string; data: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }
type SolanaTx = { instructions: SolanaIx[]; addressLookupTableAddresses?: string[] }
// From Hyperliquid: a message mapping the transfer's nonce to the order, then the transfer (a Hyperliquid action).
type Authorize = { sign: { signatureKind: string; domain: TypedData['domain']; types: TypedData['types']; primaryType: string; value: TypedData['message'] }; post: { endpoint: string; body: Record<string, unknown> } }
type HyperliquidTx = { action: { type: string; parameters: Record<string, unknown> }; nonce: number; eip712Types: TypedData['types']; eip712PrimaryType: string }
type RelayQuote = {
  requestId?: string
  steps: { id: string; kind: string; items?: { data?: EvmTx | SolanaTx | Authorize | HyperliquidTx }[] }[]
  fees?: { gas?: Amount; relayer?: Amount; app?: Amount }
  details: { currencyIn?: Amount; currencyOut: Amount; timeEstimate: number }
}

// Hyperliquid's perps USDC, which the app counts in 6 decimals like LI.FI and Across; Relay counts it in 8, at this address.
// https://docs.relay.link/references/api/api_guides/hyperliquid-support
const PERPS_USDC = '0x00000000000000000000000000000000'
const perpsScale = (chain: ChainInfo, token: string) => (chain.kind === 'hypercore' && chain.native && sameAddress(token, chain.native.address) ? 100n : 1n)

export const relay: Provider = {
  id: 'relay',
  name: 'Relay',
  enabled: true,
  // Injective isn't one of its chains; Bitcoin, Tron, TON, XRP, Eclipse and Lighter are destinations. From Hyperliquid
  // it's the one bridge here: the EVM wallet signs Hyperliquid's transfer.
  supports: (from, to) => reaches('relay', from, to),

  async quote(req, signal) {
    const [scaleIn, scaleOut] = [perpsScale(req.from, req.fromToken), perpsScale(req.to, req.toToken)]
    const fromHyperliquid = req.from.kind === 'hypercore'
    const body = {
      user: req.sender,
      recipient: req.recipient,
      originChainId: idOn('relay', req.from),
      destinationChainId: idOn('relay', req.to),
      originCurrency: scaleIn > 1n ? PERPS_USDC : tokenOn('relay', req.from, req.fromToken),
      destinationCurrency: scaleOut > 1n ? PERPS_USDC : tokenOn('relay', req.to, req.toToken),
      amount: (req.amount * scaleIn).toString(),
      tradeType: 'EXACT_INPUT',
      slippageTolerance: String(req.slippageBps),
      // Not includeComputeUnitLimit: Relay's limit ran Solana swap routes out of compute in simulation; the default is ample.
      indicativeQuote: req.preview, // the price without building transactions
      ...(fromHyperliquid && { protocolVersion: 'v2', refundTo: req.sender }), // v2: the nonce-mapping flow below
    }
    const q = await getJson<RelayQuote>(`${API}/quote/v2`, { method: 'POST', body: JSON.stringify(body), headers, signal }).catch((err) => {
      // 400 is every "can't quote this" (no route, amount too low or high, unsupported token); 401, 429 and 5xx are errors.
      if (err instanceof ProviderError && (err.status === 400 || err.status === 404)) return undefined
      throw err
    })
    if (!q) return

    const steps: Step[] = []
    for (const step of q.steps)
      for (const { data } of step.items ?? []) {
        if (!data) return // still to poll for
        // From Hyperliquid, a message that maps the transfer's nonce to the order, signed at any chain. Other signatures
        // (permits) are bound to their chain: nothing the app runs.
        if (step.kind === 'signature') {
          if (!fromHyperliquid || step.id !== 'authorize' || !('sign' in data) || data.sign.signatureKind !== 'eip712') return
          const { domain, types, primaryType, value: message } = data.sign
          steps.push({ kind: 'signature', typedData: { domain, types, primaryType, message }, post: { url: API + data.post.endpoint, body: data.post.body } })
          continue
        }
        if (step.kind !== 'transaction') return
        if ('action' in data) {
          if (!fromHyperliquid) return
          const action = { type: data.action.type, ...data.action.parameters }
          steps.push({ kind: 'hyperliquid', api: HYPERLIQUID_API, action, nonce: data.nonce, types: data.eip712Types, primaryType: data.eip712PrimaryType, order: q.requestId ?? '' })
          continue
        }
        if ('instructions' in data) {
          const transaction = await solanaTransaction(req.sender, data)
          if (!transaction) return
          steps.push({ kind: 'solana', transaction })
        } else if ('to' in data) {
          const { chainId, to, data: input, value, gas } = data
          steps.push(approval(data, req.amount) ?? { kind: 'evm', chainId, to, data: input, value: decimal(value), gas: gas ? decimal(gas) : undefined })
        } else return
      }
    const { fees, details } = q
    return {
      provider: 'relay',
      amountOut: (BigInt(details.currencyOut.amount) / scaleOut).toString(),
      minAmountOut: (BigInt(details.currencyOut.minimumAmount) / scaleOut).toString(),
      seconds: details.timeEstimate,
      feeUsd: sum([fees?.relayer?.amountUsd, fees?.app?.amountUsd]), // the relayer's can be negative: a reward for rebalancing it
      costUsd: sum([fees?.gas?.amountUsd]),
      usdIn: usdValue(details.currencyIn?.amountUsd),
      usdOut: usdValue(details.currencyOut.amountUsd),
      steps: req.preview ? [] : steps,
      track: { requestId: q.requestId ?? '' },
    }
  },

  // https://docs.relay.link/references/api/get-intents-status-v3
  async status({ track }) {
    const s = await getJson<{ status: string; txHashes?: string[]; failReason?: string; refundFailReason?: string }>(
      `${API}/intents/status/v3?requestId=${encodeURIComponent(track.requestId ?? '')}`,
      { headers },
    )
    const result: Progress = { status: 'pending', destinationTx: s.txHashes?.at(-1) } // the fill, or the refund on the source chain
    const reason = (r?: string) => (r && r !== 'N/A' ? r : undefined)
    if (s.status === 'success') result.status = 'done'
    else if (s.status === 'refund') result.status = 'refunded'
    else if (s.status === 'failure') {
      // A failed fill is retried or refunded, unless Relay says the refund can't happen either.
      result.status = reason(s.refundFailReason) ? 'failed' : 'pending'
      result.note = reason(s.refundFailReason) ?? reason(s.failReason)
    }
    return result
  },
}

// Relay gives a Solana deposit as instructions and address lookup tables. This compiles them into an unsigned v0 transaction
// paid by the sender, base64. https://solana.com/docs/core/transactions#versioned-transactions
async function solanaTransaction(payer: string, { instructions, addressLookupTableAddresses: tables = [] }: SolanaTx) {
  // Each account with its strongest role, the payer first.
  const roles = new Map<string, { signer: boolean; writable: boolean; program: boolean }>()
  const note = (key: string, signer: boolean, writable: boolean, program = false) => {
    const r = roles.get(key)
    roles.set(key, { signer: signer || !!r?.signer, writable: writable || !!r?.writable, program: program || !!r?.program })
  }
  note(payer, true, true)
  for (const ix of instructions) {
    note(ix.programId, false, false, true)
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable)
  }
  if ([...roles].some(([k, r]) => r.signer && k !== payer)) return // another key would have to sign

  // Accounts in a lookup table are referenced by their index there instead of being listed; signers and programs can't be.
  const accounts = tables.length
    ? (await solanaRpc<{ value: ({ data: [string, string] } | null)[] }>('getMultipleAccounts', [tables, { encoding: 'base64' }])).value
    : []
  const loaded = new Set<string>()
  const lookups = accounts
    .map((account, t) => {
      const raw = Buffer.from(account?.data[0] ?? '', 'base64').subarray(56) // addresses follow a 56-byte header
      const entries = Array.from({ length: raw.length / 32 }, (_, i) => base58Encode(raw.subarray(i * 32, i * 32 + 32)))
      const take = (writable: boolean) =>
        [...roles].flatMap(([k, r]) => {
          const i = r.signer || r.program || r.writable !== writable || loaded.has(k) ? -1 : entries.indexOf(k)
          if (i >= 0) loaded.add(k)
          return i >= 0 ? [{ key: k, index: i }] : []
        })
      return { table: tables[t]!, writable: take(true), readonly: take(false) }
    })
    .filter((l) => l.writable.length + l.readonly.length)
  // Listed accounts go writable signers, read-only signers, writable others, read-only others (the sort is stable: payer stays first).
  const rank = (r: { signer: boolean; writable: boolean }) => (r.signer ? 0 : 2) + (r.writable ? 0 : 1)
  const listed = [...roles].filter(([k]) => !loaded.has(k)).sort(([, a], [, b]) => rank(a) - rank(b))
  const order = [...listed.map(([k]) => k), ...lookups.flatMap((l) => l.writable.map((e) => e.key)), ...lookups.flatMap((l) => l.readonly.map((e) => e.key))]
  const index = (k: string) => order.indexOf(k)

  const { value } = await solanaRpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const out: number[] = []
  const length = (n: number) => {
    for (; n >= 0x80; n >>= 7) out.push((n & 0x7f) | 0x80)
    out.push(n)
  }
  const pubkey = (k: string) => {
    const bytes = publicKey(k)
    if (!bytes) throw new Error(`Relay returned an invalid Solana address: ${k}`)
    out.push(...bytes)
  }
  // Message: version 0, header (1 signer, the payer; 0 read-only signers; read-only others), keys, blockhash, instructions, lookups.
  out.push(0x80, 1, 0, listed.filter(([, r]) => !r.signer && !r.writable).length)
  length(listed.length)
  listed.forEach(([k]) => pubkey(k))
  pubkey(value.blockhash)
  length(instructions.length)
  for (const ix of instructions) {
    const data = Buffer.from(ix.data.replace(/^0x/, ''), 'hex')
    out.push(index(ix.programId))
    length(ix.keys.length)
    out.push(...ix.keys.map((k) => index(k.pubkey)))
    length(data.length)
    out.push(...data)
  }
  length(lookups.length)
  for (const l of lookups) {
    pubkey(l.table)
    length(l.writable.length)
    out.push(...l.writable.map((e) => e.index))
    length(l.readonly.length)
    out.push(...l.readonly.map((e) => e.index))
  }
  // One empty signature slot, for the sender's wallet.
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(out)]).toString('base64')
}
