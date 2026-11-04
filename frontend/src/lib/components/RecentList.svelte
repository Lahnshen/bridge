<script lang="ts">
  import { slide } from 'svelte/transition'
  import { app, chainFor, navigate } from '$lib/app.svelte'
  import type { Chain } from '$lib/api'
  import { ms } from '$lib/motion'
  import { history, historyKey, loadHistory } from '$lib/history.svelte'
  import { STATUS_DOT, STATUS_LABEL } from '$lib/status'
  import { recent, type Recent } from '$lib/transfers.svelte'
  import { wallet } from '$lib/wallet.svelte'
  import { Spinner } from '$lib/components/ui/spinner'
  import ChainIcon from './ChainIcon.svelte'

  // Transfers sent from this browser, plus everything the server has indexed for the connected wallet.
  let { class: className = '' }: { class?: string } = $props()

  type Row = { key: string; from?: Chain; to?: Chain; fromName: string; toName: string; amount?: string; symbol: string; status: Recent['status']; at: number }
  const side = (id: string | undefined, domain: number | undefined) => {
    const chain = chainFor(id, domain)
    return { chain, name: chain?.name ?? id ?? `Domain ${domain}` }
  }
  const sides = (from: string | undefined, sourceDomain: number | undefined, to: string | undefined, destinationDomain: number | undefined) => {
    const [a, b] = [side(from, sourceDomain), side(to, destinationDomain)]
    return { from: a.chain, to: b.chain, fromName: a.name, toName: b.name }
  }
  const mine = $derived(!!wallet.address && history.owner === wallet.address)
  const rows = $derived.by((): Row[] => {
    const sent = new Set(recent.map((r) => r.txHash))
    const indexed = mine ? history.transfers.filter((t) => !sent.has(t.txHash)) : []
    return [
      ...recent.map((r) => ({ key: r.txHash, ...sides(r.from, r.sourceDomain, r.to, r.destinationDomain), amount: r.amount, symbol: r.route?.fromToken.symbol ?? 'USDC', status: r.status, at: r.createdAt })),
      // Not timestamped yet means the server only just saw it.
      ...indexed.map((t) => ({ key: historyKey(t), ...sides(undefined, t.sourceDomain, undefined, t.destinationDomain), amount: t.amount, symbol: 'USDC', status: t.status, at: t.time ? t.time * 1000 : Date.now() })),
    ]
      .filter((row, i, all) => all.findIndex((r) => r.key === row.key) === i)
      .sort((a, b) => b.at - a.at)
  })

  // Small amounts (of ETH, say) keep a few significant digits.
  const amount = (value?: string) =>
    !value ? '—' : Number(value).toLocaleString('en-US', Number(value) >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 })
  function when(at: number) {
    const date = new Date(at)
    if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : '2-digit' })
  }
</script>

<section class={className} aria-label="Recent transfers">
  <h2 class="text-muted-foreground px-2 pb-1.5 text-[11px] font-medium">Recent</h2>
  {#each rows as row (row.key)}
    <button
      in:slide={{ duration: ms(160) }}
      class={[
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors',
        app.view === 'bridge' && app.open === row.key ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]',
      ]}
      title="{row.fromName} → {row.toName} · {STATUS_LABEL[row.status]} · {new Date(row.at).toLocaleString()}"
      onclick={() => navigate('bridge', row.key)}
    >
      <span class="flex shrink-0 -space-x-1">
        <ChainIcon chain={row.from ?? { id: '', name: row.fromName }} class="ring-sidebar size-4 text-[8px] ring-2" />
        <ChainIcon chain={row.to ?? { id: '', name: row.toName }} class="ring-sidebar size-4 text-[8px] ring-2" />
      </span>
      <span class="min-w-0 flex-1 truncate tabular-nums">{amount(row.amount)} {row.symbol}</span>
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
