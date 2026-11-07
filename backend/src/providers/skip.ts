import type { Hex } from 'viem'
import { chainBySource, sameAccount, sameAddress } from '../chains'
import { encodeMessage, type CosmosMessage } from '../cosmos'
import { checkCosmos } from '../safety'
import { decimal, getJson, idOn, isNative, ProviderError, reaches, sum, tokenOn, usdValue, type Progress, type Provider, type QuoteRequest, type Step } from './shared'

// Skip Go: Skip's router over IBC, CCTP, Go Fast, Axelar, Eureka and more, the one bridge here that reaches (and sends
// from) the Cosmos chains. https://docs.skip.build/go/general/getting-started
// Without SKIP_API_KEY all requests share Skip's restrictive global rate limit; keys come from Skip's Discord.

const API = 'https://api.skip.build/v2'
const key = process.env.SKIP_API_KEY
const headers: Record<string, string> = key ? { authorization: key } : {}

// Skip's chain ids are EVM chain ids, "solana" and Cosmos chain ids; gas tokens are denoms like "base-native" on EVM chains.
const skipId = (chain: Parameters<typeof idOn>[1]) => String(idOn('skip', chain))

// Every chain a route passes through needs an address of the user's there, in case the transfer stops on the way (a
// swap's price moving past the slippage, say): the sender's or recipient's, or one of the user's other accounts' where
// the same key gives it (see sameAccount). Skip names those chains in the order it wants the addresses.
function addressOn(req: QuoteRequest, chainId: string, index: number, count: number) {
  if (index === 0) return req.sender
  if (index === count - 1) return req.recipient
  const chain = chainBySource('skip', chainId)
  if (!chain) return
  for (const known of [{ chain: req.from, address: req.sender }, { chain: req.to, address: req.recipient }, ...req.addresses]) {
    const address = sameAccount(known.address, known.chain, chain)
    if (address) return address
  }
}

const BRIDGES: Record<string, string> = {
  CCTP_V2: 'CCTP',
  GO_FAST: 'Go Fast',
  EUREKA: 'IBC Eureka',
  AXELAR: 'Axelar',
  STARGATE: 'Stargate',
  LAYER_ZERO: 'LayerZero',
  HYPERLANE: 'Hyperlane',
}

type Fee = { usd_amount?: string; fee_behavior?: 'FEE_BEHAVIOR_DEDUCTED' | 'FEE_BEHAVIOR_ADDITIONAL' }
type Route = {
  amount_out: string
  usd_amount_in?: string
  usd_amount_out?: string
  txs_required: number
  required_chain_addresses: string[]
  estimated_route_duration_seconds: number
  estimated_fees?: Fee[]
  operations: Record<string, unknown>[] // e.g. { cctp_transfer_v2: { bridge_id, … }, tx_index, amount_in, amount_out }
}
type Tx = {
  evm_tx?: { chain_id: string; to: Hex; data: string; value?: string; required_erc20_approvals?: { token_contract: Hex; spender: Hex; amount: string }[] }
  svm_tx?: { tx: string } // base64, already signed by any extra keypair it needs
  cosmos_tx?: { chain_id: string; signer_address: string; msgs: { msg: string; msg_type_url: string }[] }
}
type Status = {
  state?: string
  transfer_sequence?: unknown[]
  transfer_asset_release?: { chain_id: string; denom: string; amount?: string; released?: boolean }
  error?: { message?: string } | null
}

// 404 is "no routes found"; 400 is an unknown token or a route Skip can't vouch for the price of, except for amounts
// out of range ("too low to cover the relay fee") and fees too large for the amount, which are worth showing.
function noRoute(err: unknown): undefined {
  if (err instanceof ProviderError && /difference in usd value/i.test(err.message)) throw new ProviderError(400, 'Fees would take too much of this amount, try a larger one')
  if (err instanceof ProviderError && (err.status === 404 || (err.status === 400 && !/amount/i.test(err.message)))) return
  throw err
}

// The hash of the first of these txs found in a status transfer event; their nesting differs per bridge.
function txOf(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return
  const o = value as Record<string, { tx_hash?: string } | null>
  for (const k of keys) {
    const hash = o[k]?.tx_hash
    if (hash) return hash
  }
  for (const v of Object.values(o)) {
    const found = txOf(v, keys)
    if (found) return found
  }
}

export const skip: Provider = {
  id: 'skip',
  name: 'Skip',
  enabled: true,
  supports: (from, to) => reaches('skip', from, to),

  async quote(req, signal) {
    // A swap on one chain names one address, the sender's, which gets what it buys: never one for someone else.
    if (req.from.id === req.to.id && !sameAddress(req.recipient, req.sender)) return
    const [from, to] = [skipId(req.from), skipId(req.to)]
    const transfer = {
      source_asset_chain_id: from,
      source_asset_denom: tokenOn('skip', req.from, req.fromToken),
      dest_asset_chain_id: to,
      dest_asset_denom: tokenOn('skip', req.to, req.toToken),
      amount_in: req.amount.toString(),
    }
    const post = <T>(path: string, body: object) =>
      getJson<T>(`${API}/fungible/${path}`, { method: 'POST', headers, body: JSON.stringify({ ...transfer, ...body }), signal })
    const route = await post<Route>('route', {
      smart_relay: true, // Skip's relayer finishes on the destination (e.g. the CCTP mint), so one tx does it
      go_fast: true,
      allow_multi_tx: false,
      smart_swap_options: { split_routes: true, evm_swaps: true },
    }).catch(noRoute)
    if (!route || route.txs_required !== 1) return
    const chains = route.required_chain_addresses
    const addresses = chains.map((c, i) => addressOn(req, c, i, chains.length))
    // Chains where the user has to give an address first: the route is shown, with what it needs.
    const needs = chains.flatMap((c, i) => (addresses[i] ? [] : [chainBySource('skip', c)?.id ?? c]))
    const txs =
      req.preview || needs.length
        ? undefined
        : (
            await post<{ txs: Tx[] }>('msgs', {
              amount_out: route.amount_out,
              address_list: addresses,
              operations: route.operations,
              slippage_tolerance_percent: String(req.slippageBps / 100),
            }).catch(noRoute)
          )?.txs
    if (!req.preview && !needs.length && txs?.length !== 1) return

    const steps: Step[] = []
    let extraValue = 0n // gas token sent beyond the amount: bridge fees Skip doesn't list (Stargate, LayerZero)
    for (const { evm_tx: e, svm_tx: s, cosmos_tx: c } of txs ?? []) {
      if (c) {
        // Only messages the app knows how to sign, from the sender on the source chain.
        const messages = c.msgs.map((m) => encodeMessage(m.msg_type_url, m.msg))
        if (c.chain_id !== from || c.signer_address !== req.sender || messages.some((m) => !m)) return
        // Moving only the token sent, at most the amount (see ../safety.ts), else refused like the other checks there.
        const refused = checkCosmos(req, transfer.source_asset_denom, c.msgs)
        if (refused) throw new ProviderError(400, refused)
        steps.push({ kind: 'cosmos', chainId: c.chain_id, signer: c.signer_address, messages: messages as CosmosMessage[] })
      } else if (e) {
        const chain = Number(e.chain_id)
        // For the amount sent, whatever Skip asks for; ../safety.ts checks the token and spender.
        for (const a of e.required_erc20_approvals ?? []) {
          steps.push({ kind: 'approve', chainId: chain, token: a.token_contract, spender: a.spender, amount: req.amount.toString() })
        }
        const data = (e.data.startsWith('0x') ? e.data : `0x${e.data}`) as Hex // Skip leaves out the 0x
        steps.push({ kind: 'evm', chainId: chain, to: e.to, data, value: decimal(e.value) })
        extraValue = BigInt(decimal(e.value)) - (isNative(req.from, req.fromToken) ? req.amount : 0n)
      } else if (s) steps.push({ kind: 'solana', transaction: s.tx })
      else return
    }

    const fees = route.estimated_fees ?? []
    const additional = fees.filter((f) => f.fee_behavior === 'FEE_BEHAVIOR_ADDITIONAL')
    const amountOut = BigInt(route.amount_out)
    const swaps = route.operations.some((op) => 'swap' in op || 'evm_swap' in op) // does_swap misses EVM swaps
    const bridges = route.operations.flatMap((op) => Object.values(op).flatMap((v) => (v as { bridge_id?: string } | null)?.bridge_id ?? []))
    return {
      provider: 'skip',
      via: [...new Set(bridges.map((b) => BRIDGES[b] ?? b))].join(' + ') || undefined,
      amountOut: route.amount_out,
      // Skip's own min_amount_out is wrong for EVM swaps (the first hop's output, or even amount_in). Slippage is set per
      // swap, so a route that delivers at all delivers at least this; with no swap the amount is fixed.
      minAmountOut: (swaps ? (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n : amountOut).toString(),
      seconds: route.estimated_route_duration_seconds,
      feeUsd: sum(fees.filter((f) => f.fee_behavior !== 'FEE_BEHAVIOR_ADDITIONAL').map((f) => f.usd_amount)),
      usdIn: usdValue(route.usd_amount_in),
      usdOut: usdValue(route.usd_amount_out),
      // Skip doesn't estimate gas: only fees charged on top in the gas token (Axelar's) count here.
      costUsd: additional.length ? sum(additional.map((f) => f.usd_amount)) : undefined,
      costNative: !additional.length && extraValue > 0n ? extraValue.toString() : undefined,
      steps: req.preview ? [] : steps,
      needs: needs.length ? needs : undefined,
      track: { chain: from },
    }
  },

  // https://docs.skip.build/go/general/multi-chain-realtime-transaction-and-packet-tracking
  async status({ txHash, from, track }) {
    const chain = track.chain ?? skipId(from)
    const s = await getJson<Status & { transfers?: Status[] }>(`${API}/tx/status?${new URLSearchParams({ tx_hash: txHash, chain_id: chain })}`, {
      headers,
    }).catch((err) => {
      if (err instanceof ProviderError && err.status === 404) return undefined
      throw err
    })
    if (!s) {
      // Skip only follows txs it was told about. 404: not on chain yet; 400: "transaction failed" (reverted).
      const body = JSON.stringify({ tx_hash: txHash, chain_id: chain })
      const failed = await getJson(`${API}/tx/track`, { method: 'POST', headers, body }).then(
        () => undefined,
        (err) => (err instanceof ProviderError && err.status === 400 ? err.message : undefined),
      )
      return failed ? { status: 'failed', note: failed } : { status: 'pending' }
    }

    const t = s.transfers?.[0] ?? s
    const release = t.transfer_asset_release
    const result: Progress = { status: 'pending', note: t.error?.message }
    if (t.state === 'STATE_COMPLETED_SUCCESS') {
      result.status = 'done'
      result.destinationTx = txOf(t.transfer_sequence?.at(-1), ['receive_tx', 'order_filled_tx', 'execute_tx'])
      result.amountOut = release?.amount
    } else if (t.state === 'STATE_COMPLETED_ERROR') {
      // The tokens are back on the source chain, or stranded on another chain or as another token.
      result.status = release?.chain_id === chain ? 'refunded' : 'failed'
      result.destinationTx = txOf(t.transfer_sequence, ['order_refunded_tx'])
      result.note ??= release && `Released as ${release.denom} on chain ${release.chain_id}.`
    } else if (t.state === 'STATE_ABANDONED') {
      // Skip gave up following a stalled relay; the transfer itself may still complete.
      result.note ??= 'Skip stopped tracking this transfer.'
    } else if (t.state === 'STATE_UNKNOWN') result.status = 'failed'
    return result
  },
}
