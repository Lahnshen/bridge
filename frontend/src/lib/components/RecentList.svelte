<script lang="ts">
  import { app, chainOf, navigate } from '$lib/app.svelte'
  import { STATUS_DOT, STATUS_LABEL } from '$lib/status'
  import { recent } from '$lib/transfers.svelte'
  import ChainIcon from './ChainIcon.svelte'

  let { class: className = '' }: { class?: string } = $props()

  const name = (domain: number) => chainOf(domain)?.name ?? `Domain ${domain}`
  const amount = (value: string) => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
</script>

<section class={className} aria-label="Recent transfers">
  <h2 class="text-muted-foreground px-2 pb-1.5 text-[11px] font-medium">Recent</h2>
  {#each recent as item (item.txHash)}
    <button
      class={[
        'flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
        app.view === 'bridge' && app.open === item.txHash ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]',
      ]}
      title="{name(item.sourceDomain)} → {name(item.destinationDomain)} · {STATUS_LABEL[item.status]}"
      onclick={() => navigate('bridge', item.txHash)}
    >
      <span class="flex shrink-0 -space-x-1">
        <ChainIcon domain={item.sourceDomain} name={name(item.sourceDomain)} class="ring-sidebar size-4 text-[8px] ring-2" />
        <ChainIcon domain={item.destinationDomain} name={name(item.destinationDomain)} class="ring-sidebar size-4 text-[8px] ring-2" />
      </span>
      <span class="min-w-0 flex-1 truncate tabular-nums">{amount(item.amount)} USDC</span>
      <span class={['size-1.5 shrink-0 rounded-full', STATUS_DOT[item.status]]}></span>
      <span class="sr-only">{STATUS_LABEL[item.status]}</span>
    </button>
  {:else}
    <p class="text-muted-foreground px-2 text-xs">No transfers yet</p>
  {/each}
</section>
