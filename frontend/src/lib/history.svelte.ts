import { getHistory, type Transfer } from './api'

// The connected wallet's transfers as the server indexed them, shown in the Recent list next to the ones sent from here.

export const history = $state({
  owner: undefined as string | undefined, // the address these belong to
  transfers: [] as Transfer[],
  next: null as number | null, // offset of the next page
  loading: false,
  error: '',
})
let pagedIn = false // a later page was loaded, so a refresh of the first one leaves `next` alone
let latest = 0

// A transfer from the history, by its nonce (or burn tx before Circle has seen it).
export const historyKey = (t: Transfer) => t.nonce ?? t.txHash

// Refreshes the first page (new transfers, fresh statuses), or with `more` adds the next one.
export async function loadHistory(address: string, more = false) {
  if (history.owner !== address) {
    Object.assign(history, { owner: address, transfers: [], next: null, error: '' })
    pagedIn = false
  }
  const id = ++latest
  history.loading = true
  history.error = ''
  try {
    const page = await getHistory(address, more ? (history.next ?? 0) : 0)
    if (id !== latest) return
    const fresh = new Set(page.transfers.map(historyKey))
    const kept = history.transfers.filter((t) => !fresh.has(historyKey(t)))
    history.transfers = more ? [...kept, ...page.transfers] : [...page.transfers, ...kept]
    if (more || !pagedIn) history.next = page.next
    if (more) pagedIn = true
  } catch (err) {
    if (id === latest) history.error = (err as Error).message
  } finally {
    if (id === latest) history.loading = false
  }
}

export function updateHistory(transfer: Transfer) {
  history.transfers = history.transfers.map((t) => (historyKey(t) === historyKey(transfer) ? { ...transfer, time: transfer.time ?? t.time } : t))
}
