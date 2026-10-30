<script lang="ts">
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right'
  import SearchIcon from '@lucide/svelte/icons/search'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getAddressTransfers, getTxTransfers, isAddress, isTxHash, type Transfer } from '$lib/api'
  import { linkedQuery } from '$lib/app.svelte'
  import RecentList from './RecentList.svelte'
  import TransferCard from './TransferCard.svelte'

  let query = $state(linkedQuery)
  let searched = $state('')
  let results = $state<Transfer[]>()
  let loading = $state(false)
  let error = $state('')
  let latest = 0

  async function search(q = query.trim(), quiet = false) {
    if (!isAddress(q) && !isTxHash(q)) {
      error = 'Enter a 0x… or inj1… address, or a transaction hash.'
      results = undefined
      return
    }
    const id = ++latest
    if (!quiet) {
      loading = true
      error = ''
    }
    try {
      const { transfers } = await (isTxHash(q) ? getTxTransfers(q) : getAddressTransfers(q))
      if (id !== latest) return
      results = transfers
      searched = q
      if (!quiet) history.replaceState(null, '', `?q=${encodeURIComponent(q)}`)
    } catch (err) {
      if (id === latest && !quiet) {
        error = (err as Error).message
        results = undefined
      }
    } finally {
      if (id === latest) loading = false
    }
  }

  if (linkedQuery) void search(linkedQuery)

  // Keep transfers in flight fresh.
  $effect(() => {
    if (!results?.some((t) => t.status === 'pending')) return
    const timer = setInterval(() => search(searched, true), 30_000)
    return () => clearInterval(timer)
  })

  function update(transfer: Transfer) {
    latest++ // a refresh started before this is stale
    results = results?.map((t) => (t.txHash === transfer.txHash && t.nonce === transfer.nonce ? transfer : t))
  }
</script>

<h1 class="font-serif text-[26px] leading-tight tracking-tight">Track a transfer</h1>
<p class="text-muted-foreground mt-1">Find any USDC transfer to or from Injective.</p>

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
    {#each results as transfer, i (`${transfer.txHash}:${transfer.nonce ?? i}`)}
      <TransferCard item={transfer} onupdate={update} />
    {:else}
      <p class="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-xs">No pending transfers for this address.</p>
    {/each}
  </div>
{:else if !error}
  <RecentList class="mt-8 md:hidden" />
{/if}
