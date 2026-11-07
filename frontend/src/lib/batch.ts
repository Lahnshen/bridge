import type { EvmChain, Hex } from './api'
import { authorized, hex, request, sleep, switchChain, wallet, walletError } from './wallet.svelte'

// EIP-5792 batches (https://eips.ethereum.org/EIPS/eip-5792): several calls in one wallet confirmation, run atomically, for
// the wallets that offer it (MetaMask on most chains, through its EIP-7702 smart account; Coinbase's smart wallet). Every
// other wallet signs one transaction at a time (runSteps), which is also the fallback whenever a wallet turns a batch down.

export type Call = { to: Hex; data: Hex; value?: bigint }
// supported: the wallet batches on that chain. ready: it can, once the user accepts its smart-account upgrade.
export type Atomic = 'supported' | 'ready' | 'none'

// The wallet declined to batch (no support after all, or the user turned down the upgrade): send the calls one by one.
export class BatchUnavailable extends Error {}
// Nobody can say whether it went out (the wallet lost the batch, say): sending it again could send it twice.
export class Unsure extends Error {}

const rejected = () => Object.assign(new Error('Request rejected.'), { code: 4001 })

// Per wallet, account and chain, for the session: an account can be a smart account on one chain and not another.
const support = new Map<string, Promise<Atomic>>()
const keyOf = (chainId: number) => `${wallet.connected?.id}:${wallet.address?.toLowerCase()}:${chainId}`

// Wallets answer in several shapes (atomic.status as in the spec, atomic.supported as in Coinbase's docs, or the older
// atomicBatch), some throw rather than say no, and some never answer: anything but a clear yes within 2 s means no.
export function atomicSupport(chainId: number): Promise<Atomic> {
  if (!wallet.address) return Promise.resolve('none')
  const key = keyOf(chainId)
  let known = support.get(key)
  if (!known) {
    const asked = request('wallet_getCapabilities', [wallet.address, [hex(chainId)]]).then((caps: Record<string, Record<string, any>> | null) => {
      const entry = Object.entries(caps ?? {}).find(([id]) => Number(id) === chainId)?.[1] ?? caps?.['0x0']
      const value = entry?.atomic?.status ?? entry?.atomic?.supported ?? (entry?.atomicBatch?.supported === true ? 'supported' : undefined)
      return value === 'supported' || value === 'ready' ? (value as Atomic) : 'none'
    })
    known = Promise.race([asked, sleep(2000).then(() => 'none' as const)]).catch(() => 'none' as const)
    support.set(key, known)
  }
  return known
}

// Sends the calls as one atomic batch on the chain. sent gets the wallet's id for the batch as soon as there is one, for
// the caller to keep: a batch is then followed by its id (batchStatus) even after a reload. Returns the hash of the
// transaction that ran it once it went through, or undefined if the wallet hasn't said in a few minutes (or gave no hash).
// Throws BatchUnavailable when the wallet won't batch, before anything was sent.
export async function sendCalls(chain: EvmChain, calls: Call[], progress: (label: string) => void, sent: (id: string) => void): Promise<Hex | undefined> {
  await switchChain(chain) // wallets batch on the chain they're on
  const from = await authorized()
  progress(calls.length > 1 ? `Confirm ${calls.length} calls at once in your wallet…` : 'Confirm in your wallet…')
  let answer: unknown
  try {
    answer = await request('wallet_sendCalls', [
      {
        version: '2.0.0',
        from,
        chainId: hex(chain.chainId),
        atomicRequired: true,
        calls: calls.map(({ to, data, value }) => ({ to, ...(data && data !== '0x' && { data }), value: hex(value ?? 0n) })),
      },
    ])
  } catch (err) {
    // A refusal pauses the run; any other answer means this wallet doesn't batch here (5750: it won't upgrade the account).
    if (walletError(err) === undefined || (err as { code?: number })?.code === -32002) throw err
    support.set(keyOf(chain.chainId), Promise.resolve('none'))
    throw new BatchUnavailable((err as Error)?.message ?? 'No batches')
  }
  // The spec answers { id }; some wallets answer the id alone.
  const id = typeof answer === 'string' ? answer : (answer as { id?: unknown } | null)?.id
  if (typeof id !== 'string') throw new Unsure('Your wallet took the batch without an id to follow it by.')
  sent(id)
  progress('Waiting for the batch…')
  let seen = false
  for (const end = Date.now() + 300_000; Date.now() < end; ) {
    await sleep(2000)
    const status = await batchStatus(id)
    // MetaMask forgets a one-call batch the user rejected, without having reported on it.
    if (status.code === 5730 && calls.length === 1 && !seen) throw rejected()
    seen ||= status.code === 100
    const result = batchResult(status)
    if (result !== 'pending') return result
  }
}

type Status = { code: number; hash?: Hex }
// What the wallet says of a batch, in EIP-5792's codes: 100 pending, 200 done, 400 not sent, 500 reverted (nothing moved),
// 600 partly reverted; 5730: it doesn't know the batch; 0: no answer (no wallet, or a wallet that's locked). Older wallets
// answer CONFIRMED and PENDING. hash: the transaction that ran it.
export async function batchStatus(id: string): Promise<Status> {
  try {
    const result: { status?: number | string; receipts?: { transactionHash?: Hex }[] } | null = await request('wallet_getCallsStatus', [id])
    const code = result?.status === 'CONFIRMED' ? 200 : result?.status === 'PENDING' ? 100 : Number(result?.status) || 0
    return { code, hash: result?.receipts?.map((r) => r.transactionHash).filter(Boolean).at(-1) }
  } catch (err) {
    return { code: (err as { code?: number })?.code === 5730 ? 5730 : 0 }
  }
}

// The batch's transaction once it ran (undefined when the wallet gives none), or 'pending' while it may still run. Throws
// when it didn't go through, and Unsure when the wallet can't tell.
export function batchResult({ code, hash }: Status): Hex | undefined | 'pending' {
  if (code === 200) return hash
  if (!code || code === 100) return 'pending'
  if (code === 400) throw new Error('Your wallet didn’t send the batch.')
  if (code === 500) throw new Error('The batch reverted, so nothing moved.')
  throw new Unsure(code === 600 ? 'Part of the batch reverted.' : 'Your wallet lost track of the batch.')
}
