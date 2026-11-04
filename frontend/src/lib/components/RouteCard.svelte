<script lang="ts">
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right'
  import CheckIcon from '@lucide/svelte/icons/check'
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import XIcon from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import { INJECTIVE } from '$lib/api'
  import { app, chainFor, navigate, txLink } from '$lib/app.svelte'
  import { formatToken, parseAmount } from '$lib/evm'
  import { providerLogo } from '$lib/routes'
  import type { Recent, Route } from '$lib/transfers.svelte'
  import ChainIcon from './ChainIcon.svelte'

  // A transfer sent through another bridge than CCTP. That bridge reports its progress (see transfers.svelte.ts).
  let { item }: { item: Recent & { route: Route } } = $props()

  const route = $derived(item.route)
  const source = $derived(chainFor(item.from, item.sourceDomain))
  const destination = $derived(chainFor(item.to, item.destinationDomain))
  const sourceName = $derived(source?.name ?? item.from ?? `Domain ${item.sourceDomain}`)
  const destinationName = $derived(destination?.name ?? item.to ?? `Domain ${item.destinationDomain}`)
  const sourceUrl = $derived(txLink(source, item.txHash))
  const destinationUrl = $derived(txLink(route.refunded ? source : destination, route.destinationTx))
  const sent = $derived(new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  const amountIn = $derived(formatToken(parseAmount(item.amount, route.fromToken.decimals) ?? 0n, route.fromToken.decimals))
  const amountOut = $derived(formatToken(BigInt(route.received ?? route.amountOut), route.toToken.decimals))

  type Step = 'done' | 'active' | 'todo' | 'error'
  const STEPS = $derived(['Sent', `${route.name}`, 'Received'])
  const steps = $derived.by((): Step[] => {
    switch (item.status) {
      case 'confirming': return ['active', 'todo', 'todo']
      case 'redeemed': return ['done', 'done', 'done']
      case 'failed': return route.refunded ? ['done', 'error', 'todo'] : ['error', 'todo', 'todo']
      default: return ['done', 'active', 'todo']
    }
  })
  const note = $derived(item.note ?? (item.status === 'confirming' ? `Waiting for ${sourceName} to confirm the transaction.` : item.status === 'pending' ? `${route.name} is delivering it to ${destinationName}.` : undefined))
</script>

<article class="bg-card rounded-lg border shadow-xs">
  <header class="flex items-center gap-3 px-4 pt-4">
    <span class="flex shrink-0 -space-x-1.5">
      <ChainIcon chain={source} class="ring-card size-6 text-[11px] ring-2" />
      <ChainIcon chain={destination} class="ring-card size-6 text-[11px] ring-2" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-[15px] leading-tight font-semibold tracking-tight tabular-nums">
        {amountIn} {route.fromToken.symbol} <span class="text-muted-foreground font-normal">→</span> {amountOut} {route.toToken.symbol}
      </p>
      <p class="text-muted-foreground flex items-center gap-1 truncate text-xs">
        {sourceName} → {destinationName} · <img src={providerLogo(route.provider)} alt="" class="size-3 rounded-full" /> {route.name}{route.via ? ` via ${route.via}` : ''}
      </p>
    </div>
    <time class="text-muted-foreground shrink-0 self-start text-[11px]" datetime={new Date(item.createdAt).toISOString()}>{sent}</time>
  </header>

  <ol class="flex items-center gap-2 px-4 pt-4 text-xs" aria-label="Progress">
    {#each STEPS as label, i (i)}
      {#if i}
        <li aria-hidden="true" class={['relative h-px flex-1 overflow-hidden', steps[i - 1] === 'done' && steps[i] !== 'todo' ? 'bg-foreground/30' : 'bg-border']}>
          {#if steps[i - 1] === 'done' && steps[i] === 'active'}<span class="animate-travel bg-foreground/70 absolute inset-y-0 left-0 w-1/3"></span>{/if}
        </li>
      {/if}
      <li class={['flex items-center gap-1.5', steps[i] === 'todo' && 'text-muted-foreground', steps[i] === 'error' && 'text-destructive']}>
        <span
          class={[
            'flex size-4 items-center justify-center rounded-full',
            steps[i] === 'done' && 'bg-foreground text-background',
            steps[i] === 'active' && 'border-foreground/70 border',
            steps[i] === 'todo' && 'border-muted-foreground/40 border',
            steps[i] === 'error' && 'bg-destructive text-white',
          ]}
        >
          {#if steps[i] === 'done'}<CheckIcon class="size-2.5" strokeWidth={3} />
          {:else if steps[i] === 'error'}<XIcon class="size-2.5" strokeWidth={3} />
          {:else if steps[i] === 'active'}<span class="bg-foreground size-1.5 animate-pulse rounded-full"></span>{/if}
        </span>
        {label}
      </li>
    {/each}
  </ol>

  {#if note}<p class={['px-4 pt-3 text-xs', item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground']}>{note}</p>{/if}

  <footer class="text-muted-foreground mt-4 flex items-center gap-3 border-t px-4 py-3 text-xs">
    {#if sourceUrl}<a class="hover:text-foreground inline-flex items-center gap-0.5" href={sourceUrl} target="_blank" rel="noreferrer">{sourceName} tx<ArrowUpRightIcon class="size-3" /></a>{/if}
    {#if destinationUrl}
      <a class="hover:text-foreground inline-flex items-center gap-0.5" href={destinationUrl} target="_blank" rel="noreferrer">
        {route.refunded ? 'Refund' : `${destinationName} tx`}<ArrowUpRightIcon class="size-3" />
      </a>
    {/if}
    {#if item.status === 'redeemed' && destination?.domain === INJECTIVE && app.config?.swap}
      <Button size="sm" variant="outline" class="ml-auto px-3" onclick={() => navigate('swap')}><FuelIcon class="size-3.5" />Get INJ for gas</Button>
    {/if}
  </footer>
</article>
