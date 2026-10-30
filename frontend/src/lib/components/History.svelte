<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getHistory, type Transfer } from '$lib/api'
  import { app } from '$lib/app.svelte'
  import { short } from '$lib/evm'
  import { STATUS_DOT, STATUS_LABEL } from '$lib/status'
  import { connectWallet, wallet } from '$lib/wallet.svelte'
  import ChainIcon from './ChainIcon.svelte'
  import TransferCard from './TransferCard.svelte'

  let transfers = $state<Transfer[]>([])
  let next = $state<number | null>(null)
  let loading = $state(false)
  let error = $state('')
  let open = $state<string>() // the row shown as a full card
  let owner: string | undefined // the address the list belongs to
  let failed = 0 // offset of the page that failed to load
  let latest = 0

  const key = (t: Transfer) => `${t.txHash}:${t.nonce}`
  const amount = (value?: string) => (value ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')

  async function load(address: string, offset = 0) {
    const id = ++latest
    loading = true
    error = ''
    try {
      const page = await getHistory(address, offset)
      if (id !== latest) return
      // New transfers push older ones down a page, so a later page can repeat a few.
      const seen = new Set(offset ? transfers.map(key) : [])
      transfers = [...(offset ? transfers : []), ...page.transfers.filter((t) => !seen.has(key(t)))]
      next = page.next
    } catch (err) {
      if (id !== latest) return
      error = (err as Error).message
      failed = offset
    } finally {
      if (id === latest) loading = false
    }
  }

  // Refreshes each time the view opens, and starts over for another wallet.
  $effect(() => {
    const address = wallet.address
    if (app.view !== 'history' || !address) return
    untrack(() => {
      if (owner !== address) {
        owner = address
        transfers = []
        next = null
        open = undefined
      }
      void load(address)
    })
  })

  function update(transfer: Transfer) {
    transfers = transfers.map((t) => (key(t) === key(transfer) ? { ...transfer, time: transfer.time ?? t.time } : t))
  }

  const date = (t: Transfer) => (t.time ? new Date(t.time * 1000) : new Date()) // not timestamped yet means just sent
  function day(value: Date) {
    if (value.toDateString() === new Date().toDateString()) return 'Today'
    if (value.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday'
    const year = value.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year })
  }
  const groups = $derived.by(() => {
    const list: { day: string; transfers: Transfer[] }[] = []
    for (const t of transfers) {
      const label = day(date(t))
      if (list.at(-1)?.day === label) list.at(-1)!.transfers.push(t)
      else list.push({ day: label, transfers: [t] })
    }
    return list
  })
</script>

<h1 class="font-serif text-[26px] leading-tight tracking-tight">History</h1>
<p class="text-muted-foreground mt-1">
  {#if wallet.address}Transfers from or to <span class="font-mono text-xs">{short(wallet.address)}</span>.{:else}Your transfers to and from Injective.{/if}
</p>

{#if !wallet.address}
  <div class="bg-card mt-6 flex flex-col items-center gap-3 rounded-2xl border px-4 py-8 text-center shadow-xs">
    <p class="text-muted-foreground text-xs">Connect a wallet to see its transfers.</p>
    <Button size="sm" class="rounded-full px-4" onclick={connectWallet}>Connect wallet</Button>
  </div>
{:else if !transfers.length && loading}
  <div class="flex justify-center pt-12"><Spinner class="text-muted-foreground size-5" /></div>
{:else if !transfers.length && !error}
  <p class="text-muted-foreground mt-6 rounded-2xl border border-dashed px-4 py-6 text-center text-xs">No transfers for this wallet yet.</p>
{:else}
  <div class="mt-6 flex flex-col gap-5">
    {#each groups as group}
      <section aria-label={group.day}>
        <h2 class="text-muted-foreground px-1 pb-2 text-[11px] font-medium">{group.day}</h2>
        <div class="flex flex-col gap-2">
          {#each group.transfers as t, i (`${key(t)}:${i}`)}
            {#if open === key(t)}
              <TransferCard item={t} onupdate={update} />
            {:else}
              <button
                class="bg-card hover:bg-muted/50 flex h-14 w-full items-center gap-3 rounded-2xl border px-4 text-left shadow-xs transition-colors"
                onclick={() => (open = key(t))}
              >
                <span class="flex shrink-0 -space-x-1.5">
                  <ChainIcon domain={t.sourceDomain} name={t.sourceChain} class="ring-card size-6 text-[11px] ring-2" />
                  <ChainIcon domain={t.destinationDomain} name={t.destinationChain} class="ring-card size-6 text-[11px] ring-2" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] leading-tight font-medium tabular-nums">{amount(t.amount)} USDC</span>
                  <span class="text-muted-foreground block truncate text-xs">{t.sourceChain} → {t.destinationChain}</span>
                </span>
                <span class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                  <span class={['size-1.5 rounded-full', STATUS_DOT[t.status]]}></span>
                  {t.status === 'redeemed' && t.time
                    ? date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                    : STATUS_LABEL[t.status]}
                </span>
              </button>
            {/if}
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

{#if wallet.address && error}
  <div class="mt-4 flex items-center justify-center gap-3 text-xs">
    <p class="text-destructive">{error}</p>
    <Button variant="outline" size="sm" class="rounded-full px-3.5" onclick={() => load(wallet.address!, failed)}>Try again</Button>
  </div>
{:else if wallet.address && next !== null && transfers.length}
  <div class="mt-4 flex justify-center">
    <Button variant="outline" size="sm" class="rounded-full px-4" disabled={loading} onclick={() => load(wallet.address!, next!)}>
      {#if loading}<Spinner class="size-3.5" />{/if}Load more
    </Button>
  </div>
{/if}
