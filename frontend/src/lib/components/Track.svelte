<script lang="ts">
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right'
  import SearchIcon from '@lucide/svelte/icons/search'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getHistory, getTxTransfers, isAddress, isTxHash, type Transfer } from '$lib/api'
  import { linkedQuery } from '$lib/app.svelte'
  import RecentList from './RecentList.svelte'
  import TransferCard from './TransferCard.svelte'

  // A tx hash shows its transfers, an address every transfer from or to it (finished ones too), a page at a time.
  let query = $state(linkedQuery)
  let searched = $state('')
  let results = $state<Transfer[]>()
  let next = $state<number | null>(null) // offset of the address's next page
  let loading = $state(false)
  let loadingMore = $state(false)
  let error = $state('')
  let latest = 0

  const key = (t: Transfer) => `${t.sourceDomain}:${t.txHash}:${t.nonce ?? ''}`

  async function search(q = query.trim()) {
    if (!isAddress(q) && !isTxHash(q)) {
      error = 'Enter a 0x…, inj1… or Solana address, or a transaction hash.'
      results = undefined
      return
    }
    const id = ++latest
    loading = true
    error = ''
    try {
      const page = isTxHash(q) ? { ...(await getTxTransfers(q)), next: null } : await getHistory(q)
      if (id !== latest) return
      results = page.transfers
      next = page.next
      searched = q
      history.replaceState(null, '', `/track?q=${encodeURIComponent(q)}`)
    } catch (err) {
      if (id === latest) {
        error = (err as Error).message
        results = undefined
      }
    } finally {
      if (id === latest) loading = false
    }
  }

  async function loadMore() {
    const id = latest
    loadingMore = true
    error = ''
    try {
      const page = await getHistory(searched, next!)
      if (id !== latest) return
      const seen = new Set(results!.map(key))
      results = [...results!, ...page.transfers.filter((t) => !seen.has(key(t)))]
      next = page.next
    } catch (err) {
      if (id === latest) error = (err as Error).message
    } finally {
      loadingMore = false
    }
  }

  if (linkedQuery) void search(linkedQuery)

  // Keep transfers in flight fresh.
  $effect(() => {
    if (!results?.some((t) => t.status === 'pending')) return
    const timer = setInterval(refreshPending, 30_000)
    return () => clearInterval(timer)
  })

  async function refreshPending() {
    const id = latest
    const txs = new Map(results!.filter((t) => t.status === 'pending' && t.txHash).map((t) => [t.txHash, t.sourceDomain]))
    for (const [hash, domain] of txs) {
      const fresh = await getTxTransfers(hash, domain).catch(() => undefined)
      if (id !== latest) return
      for (const transfer of fresh?.transfers ?? []) merge(transfer)
    }
  }

  const merge = (transfer: Transfer) => (results = results?.map((t) => (key(t) === key(transfer) ? { ...transfer, time: transfer.time ?? t.time } : t)))

  function update(transfer: Transfer) {
    latest++ // a refresh started before this is stale
    merge(transfer)
  }
</script>

<h1 class="font-serif text-[26px] leading-tight tracking-tight">Track a transfer</h1>
<p class="text-muted-foreground mt-1">Find any USDC transfer by wallet address or transaction hash.</p>

<form
  class="bg-card focus-within:border-ring focus-within:ring-ring/30 mt-6 flex h-12 items-center gap-2.5 rounded-lg border pr-1.5 pl-4 shadow-xs transition-shadow focus-within:ring-3"
  onsubmit={(event) => {
    event.preventDefault()
    void search()
  }}
>
  <SearchIcon class="text-muted-foreground size-4 shrink-0" />
  <input
    class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-[13px]"
    placeholder="Address or transaction hash"
    aria-label="Wallet address or transaction hash"
    autocomplete="off"
    spellcheck="false"
    bind:value={query}
  />
  <button
    type="submit"
    class="bg-primary text-primary-foreground hover:bg-primary/90 flex size-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40"
    aria-label="Search"
    disabled={loading || !query.trim()}
  >
    {#if loading}<Spinner class="size-4" />{:else}<ArrowRightIcon class="size-4" />{/if}
  </button>
</form>

{#if error}
  <p class="text-destructive mt-3 px-4 text-xs">{error}</p>
{/if}

{#if results}
  <div class="mt-5 flex flex-col gap-3">
    {#each results as transfer (key(transfer))}
      <TransferCard item={transfer} onupdate={update} />
    {:else}
      <p class="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-xs">No transfers found for this address.</p>
    {/each}
    {#if next !== null}
      <button
        class="text-muted-foreground hover:text-foreground bg-card flex h-10 items-center justify-center gap-2 rounded-lg border text-xs shadow-xs transition-colors disabled:pointer-events-none"
        disabled={loadingMore}
        onclick={loadMore}
      >
        {#if loadingMore}<Spinner class="size-3.5" />Loading…{:else}Load more{/if}
      </button>
    {/if}
  </div>
{:else if !error}
  <RecentList class="mt-8 md:hidden" />
{/if}
