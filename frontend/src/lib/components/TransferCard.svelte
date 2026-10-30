<script lang="ts">
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right'
  import CheckIcon from '@lucide/svelte/icons/check'
  import XIcon from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { INJECTIVE, redeem, type Transfer } from '$lib/api'
  import { app, chainOf } from '$lib/app.svelte'
  import { encode, formatAmount, short } from '$lib/evm'
  import type { Recent } from '$lib/transfers.svelte'
  import { connectWallet, sendTx, switchChain, waitForReceipt, wallet, walletError } from '$lib/wallet.svelte'
  import ChainIcon from './ChainIcon.svelte'

  // A transfer from a lookup, or one sent from this browser (which the server may not know about yet).
  let { item, onupdate }: { item: Transfer | Recent; onupdate: (transfer: Transfer) => void } = $props()

  const local = $derived('createdAt' in item ? item : undefined)
  const t = $derived(local ? local.transfer : (item as Transfer))
  const source = $derived(chainOf(item.sourceDomain))
  const destination = $derived(chainOf(item.destinationDomain))
  const sourceName = $derived(t?.sourceChain ?? source?.name ?? `Domain ${item.sourceDomain}`)
  const destinationName = $derived(t?.destinationChain ?? destination?.name ?? `Domain ${item.destinationDomain}`)
  const sourceUrl = $derived(t?.txUrl ?? (source?.explorer && item.txHash && `${source.explorer}/tx/${item.txHash}`))
  const sent = $derived(t?.time && new Date(t.time * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  const note = $derived(local?.note ?? t?.note ?? (item.status === 'confirming' ? `Waiting for ${sourceName} to confirm the transaction.` : undefined))

  let busy = $state('')
  let error = $state('')
  let handedOver = $state(false)

  const serverMints = $derived(item.destinationDomain === INJECTIVE && !!app.config?.autoRedeem)
  const claimable = $derived(!!t?.message && !!t.attestation && !!destination && (item.status === 'ready' || item.status === 'restricted'))
  const action = $derived(
    serverMints && item.status === 'ready'
      ? 'redeem'
      : serverMints && item.status === 'pending' && !local && !handedOver
        ? 'queue' // transfers sent from here are handed over automatically
        : claimable
          ? 'claim'
          : undefined,
  )

  type Step = 'done' | 'active' | 'todo' | 'error'
  const STEPS = ['Sent', 'Attested', 'Received']
  const steps = $derived.by((): Step[] => {
    switch (item.status) {
      case 'confirming': return ['active', 'todo', 'todo']
      case 'failed': return ['error', 'todo', 'todo']
      case 'pending': return ['done', 'active', 'todo']
      case 'ready': return ['done', 'done', 'active']
      case 'restricted': return ['done', 'done', claimable ? 'active' : 'error']
      case 'redeemed': return ['done', 'done', 'done']
    }
  })

  // Our server mints it on Injective, gas free. Before Circle attests, it queues it for later.
  async function serverRedeem() {
    busy = item.status === 'pending' ? 'Queuing…' : 'Redeeming…'
    error = ''
    try {
      const { transfers } = await redeem(item.txHash, item.sourceDomain)
      handedOver = true
      const updated = transfers.find((x) => x.nonce === t?.nonce) ?? transfers[0]
      if (updated) onupdate(updated)
    } catch (err) {
      error = (err as Error).message
    } finally {
      busy = ''
    }
  }

  // The connected wallet mints it on the destination chain.
  async function claim() {
    if (!wallet.address) return connectWallet()
    const chain = destination!
    const { message, attestation } = t!
    error = ''
    try {
      busy = `Switching to ${chain.name}…`
      await switchChain(chain)
      busy = 'Confirm in your wallet…'
      const data = encode.receiveMessage(message!, attestation!)
      const hash = await sendTx(chain, { to: app.config!.messageTransmitter, data }, { padGas: chain.domain === INJECTIVE })
      busy = 'Claiming…'
      if (!(await waitForReceipt(hash))) throw new Error('The claim transaction failed.')
      const redeemTxUrl = chain.explorer && `${chain.explorer}/tx/${hash}`
      onupdate({ ...t!, status: 'redeemed', note: undefined, message: undefined, attestation: undefined, redeemTx: hash, redeemTxUrl })
    } catch (err) {
      error = walletError(err) ?? ''
    } finally {
      busy = ''
    }
  }
</script>

<article class="bg-card rounded-lg border shadow-xs">
  <header class="flex items-center gap-3 px-4 pt-4">
    <span class="flex shrink-0 -space-x-1.5">
      <ChainIcon domain={item.sourceDomain} name={sourceName} class="ring-card size-6 text-[11px] ring-2" />
      <ChainIcon domain={item.destinationDomain} name={destinationName} class="ring-card size-6 text-[11px] ring-2" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-[15px] leading-tight font-semibold tracking-tight tabular-nums">{formatAmount(t?.amount ?? local?.amount)} USDC</p>
      <p class="text-muted-foreground truncate text-xs">
        {sourceName} → {destinationName}{#if t?.recipient}&nbsp;· to <span class="font-mono">{short(t.recipient)}</span>{/if}
      </p>
    </div>
    {#if sent}<time class="text-muted-foreground shrink-0 self-start text-[11px]" datetime={new Date(t!.time! * 1000).toISOString()}>{sent}</time>{/if}
  </header>

  <ol class="flex items-center gap-2 px-4 pt-4 text-xs" aria-label="Progress">
    {#each STEPS as label, i (label)}
      {#if i}
        <li aria-hidden="true" class={['relative h-px flex-1 overflow-hidden', steps[i - 1] === 'done' && steps[i] !== 'todo' ? 'bg-foreground/30' : 'bg-border']}>
          {#if steps[i - 1] === 'done' && steps[i] === 'active'}
            <span class="animate-travel bg-foreground/70 absolute inset-y-0 left-0 w-1/3"></span>
          {/if}
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
        <span class="sr-only">({steps[i] === 'done' ? 'done' : steps[i] === 'active' ? 'in progress' : steps[i] === 'error' ? 'failed' : 'to do'})</span>
      </li>
    {/each}
  </ol>

  {#if note}
    <p class="text-muted-foreground px-4 pt-3 text-xs leading-relaxed">{note}</p>
  {/if}

  <footer class="mt-4 flex min-h-12 items-center gap-3 border-t px-4 py-2">
    <div class="text-muted-foreground flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 text-xs">
      {#if sourceUrl}
        <a class="hover:text-foreground inline-flex items-center gap-0.5" href={sourceUrl} target="_blank" rel="noreferrer">
          {sourceName} tx<ArrowUpRightIcon class="size-3" />
        </a>
      {/if}
      {#if t?.redeemTxUrl}
        <a class="hover:text-foreground inline-flex items-center gap-0.5" href={t.redeemTxUrl} target="_blank" rel="noreferrer">
          {destinationName} tx<ArrowUpRightIcon class="size-3" />
        </a>
      {/if}
    </div>
    {#if action}
      <Button
        size="sm"
        variant={action === 'queue' ? 'outline' : 'default'}
        class="px-3.5"
        disabled={!!busy}
        title={action === 'queue' ? 'Mint it on Injective as soon as Circle attests it' : undefined}
        onclick={action === 'claim' ? claim : serverRedeem}
      >
        {#if busy}<Spinner class="size-3.5" />{busy}{:else if action === 'claim'}Claim on {destination?.name}{:else if action === 'queue'}Auto-redeem{:else}Redeem{/if}
      </Button>
    {/if}
  </footer>

  {#if error}
    <p class="text-destructive border-t px-4 py-2.5 text-xs">{error}</p>
  {/if}
</article>
