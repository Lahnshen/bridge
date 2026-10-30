import { ApiError, getTxTransfers, INJECTIVE, redeem, type Transfer } from './api'

// Transfers bridged from this browser, kept in localStorage and polled until they land.

export type Recent = {
  txHash: string
  sourceDomain: number
  destinationDomain: number
  amount: string // USDC
  createdAt: number
  status: Transfer['status'] | 'confirming' | 'failed'
  transfer?: Transfer // latest state from the server
  queued?: boolean // handed to the server, which mints it on Injective once attested
  note?: string
}

const KEY = 'transfers'
const MAX = 30
const read = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}
export const recent = $state<Recent[]>(read())
const save = () => localStorage.setItem(KEY, JSON.stringify($state.snapshot(recent)))

// Returns the stored (reactive) copy, which is the one to update.
export function addRecent(item: Recent) {
  recent.unshift(item)
  recent.splice(MAX)
  save()
  return recent[0]!
}

export function failRecent(item: Recent, note: string) {
  item.status = 'failed'
  item.note = note
  save()
}

export function setTransfer(item: Recent, transfer: Transfer) {
  item.transfer = transfer
  item.status = transfer.status
  item.note = undefined
  save()
}

export const isFinal = (status: Recent['status']) => status === 'redeemed' || status === 'restricted' || status === 'failed'

const checkedAt = new Map<string, number>()
const handedAt = new Map<string, number>()
let serverRedeems = false
let tracking = false

export async function trackRecent(autoRedeem: boolean) {
  serverRedeems = autoRedeem
  if (tracking) return
  tracking = true
  while (true) {
    for (const item of recent) if (!isFinal(item.status) && due(item)) await refresh(item)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

// Often while a transfer is fresh (fast transfers land in seconds), less later (standard ones take ~20 min).
function due(item: Recent) {
  const age = Date.now() - item.createdAt
  const every = age < 3 * 60_000 ? 6000 : age < 60 * 60_000 ? 20_000 : 60_000
  return Date.now() - (checkedAt.get(item.txHash) ?? 0) >= every
}

export async function refresh(item: Recent) {
  checkedAt.set(item.txHash, Date.now())
  try {
    let [transfer] = (await getTxTransfers(item.txHash, item.sourceDomain)).transfers
    if (!transfer) return
    // The server mints transfers to Injective itself: hand this one over while it waits for Circle, and nudge it once it's ready.
    const handOver = transfer.status === 'ready' || (transfer.status === 'pending' && !item.queued)
    if (serverRedeems && transfer.destinationDomain === INJECTIVE && handOver && Date.now() - (handedAt.get(item.txHash) ?? 0) > 30_000) {
      handedAt.set(item.txHash, Date.now())
      try {
        transfer = (await redeem(item.txHash, item.sourceDomain)).transfers[0] ?? transfer
        item.queued = true
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) item.queued = true // already minted or can't be: nothing to hand over
      }
    }
    setTransfer(item, transfer)
  } catch (err) {
    // Right after sending, the server may not see the burn yet.
    if (err instanceof ApiError && err.status === 404 && Date.now() - item.createdAt < 15 * 60_000) return
    item.note = (err as Error).message
    save()
  }
}
