<script lang="ts">
  import { app, chainOf, navigate } from '$lib/app.svelte'
  import { history, historyKey, loadHistory } from '$lib/history.svelte'
  import { STATUS_DOT, STATUS_LABEL } from '$lib/status'
  import { recent, type Recent } from '$lib/transfers.svelte'
  import { wallet } from '$lib/wallet.svelte'
  import { Spinner } from '$lib/components/ui/spinner'
  import ChainIcon from './ChainIcon.svelte'

  // Transfers sent from this browser, plus everything the server has indexed for the connected wallet.
  let { class: className = '' }: { class?: string } = $props()

  type Row = { key: string; sourceDomain: number; destinationDomain: number; amount?: string; status: Recent['status']; at: number }
  const mine = $derived(!!wallet.address && history.owner === wallet.address)
  const rows = $derived.by((): Row[] => {
    const sent = new Set(recent.map((r) => r.txHash))
    const indexed = mine ? history.transfers.filter((t) => !sent.has(t.txHash)) : []
    return [
      ...recent.map((r) => ({ key: r.txHash, sourceDomain: r.sourceDomain, destinationDomain: r.destinationDomain, amount: r.amount, status: r.status, at: r.createdAt })),
      // Not timestamped yet means the server only just saw it.
      ...indexed.map((t) => ({ key: historyKey(t), sourceDomain: t.sourceDomain, destinationDomain: t.destinationDomain, amount: t.amount, status: t.status, at: t.time ? t.time * 1000 : Date.now() })),
    ].sort((a, b) => b.at - a.at)
  })

  const name = (domain: number) => chainOf(domain)?.name ?? `Domain ${domain}`
  const amount = (value?: string) => (value ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
  function when(at: number) {
    const date = new Date(at)
    if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : '2-digit' })
  }
</script>

<section class={className} aria-label="Recent transfers">
  <h2 class="text-muted-foreground px-2 pb-1.5 text-[11px] font-medium">Recent</h2>
  {#each rows as row}
    <button
      class={[
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors',
        app.view === 'bridge' && app.open === row.key ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]',
      ]}
      title="{name(row.sourceDomain)} → {name(row.destinationDomain)} · {STATUS_LABEL[row.status]} · {new Date(row.at).toLocaleString()}"
      onclick={() => navigate('bridge', row.key)}
    >
      <span class="flex shrink-0 -space-x-1">
        <ChainIcon domain={row.sourceDomain} name={name(row.sourceDomain)} class="ring-sidebar size-4 text-[8px] ring-2" />
        <ChainIcon domain={row.destinationDomain} name={name(row.destinationDomain)} class="ring-sidebar size-4 text-[8px] ring-2" />
      </span>
      <span class="min-w-0 flex-1 truncate tabular-nums">{amount(row.amount)} USDC</span>
      <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">{when(row.at)}</span>
      <span class={['size-1.5 shrink-0 rounded-full', STATUS_DOT[row.status]]}></span>
      <span class="sr-only">{STATUS_LABEL[row.status]}</span>
    </button>
  {:else}
    {#if !(mine && history.loading)}<p class="text-muted-foreground px-2 text-xs">No transfers yet</p>{/if}
  {/each}

  {#if mine && history.error}
    <p class="text-muted-foreground px-2 pt-1.5 text-xs">
      {history.error}
      <button class="text-foreground underline-offset-2 hover:underline" onclick={() => loadHistory(wallet.address!, rows.length > recent.length)}>Retry</button>
    </p>
  {:else if mine && (history.loading || history.next !== null)}
    <button
      class="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] mt-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors disabled:pointer-events-none"
      disabled={history.loading}
      onclick={() => loadHistory(wallet.address!, true)}
    >
      {#if history.loading}<Spinner class="size-3.5" />Loading…{:else}Load more{/if}
    </button>
  {/if}
</section>
