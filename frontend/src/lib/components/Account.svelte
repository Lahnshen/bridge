<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import LogOutIcon from '@lucide/svelte/icons/log-out'
  import WalletIcon from '@lucide/svelte/icons/wallet'
  import { Button } from '$lib/components/ui/button'
  import { short } from '$lib/evm'
  import { chainById } from '$lib/app.svelte'
  import { cosmosWallet, disconnectCosmos } from '$lib/cosmos-wallet.svelte'
  import { disconnectSolana, solanaWallet } from '$lib/solana-wallet.svelte'
  import { cn } from '$lib/utils'
  import { connectWallet, disconnect, wallet } from '$lib/wallet.svelte'

  // A connected wallet (EVM, Solana or Cosmos): a full row in the sidebar, a small pill in the mobile header. A Cosmos
  // wallet shows its address on the chain it was last connected for.
  let { compact = false, kind = 'evm' }: { compact?: boolean; kind?: 'evm' | 'solana' | 'cosmos' } = $props()
  const connected = $derived(kind === 'solana' ? solanaWallet : kind === 'cosmos' ? cosmosWallet : wallet)
  const network = $derived(kind === 'solana' ? 'Solana' : kind === 'cosmos' ? (chainById(cosmosWallet.chain)?.name ?? 'Cosmos') : '')

  let open = $state(false)
  let copied = $state(false)
  let root = $state<HTMLElement>()

  async function copy() {
    await navigator.clipboard.writeText(connected.address!).catch(() => {})
    copied = true
    setTimeout(() => {
      copied = open = false
    }, 900)
  }

  const item = 'hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:bg-muted'
</script>

<svelte:window onpointerdown={(event) => open && !root?.contains(event.target as Node) && (open = false)} onkeydown={(event) => event.key === 'Escape' && (open = false)} />

{#snippet avatar(className: string)}
  {#if connected.connected?.icon}
    <img src={connected.connected.icon} alt="" class={cn('shrink-0 rounded-md', className)} />
  {:else}
    <span class={cn('bg-muted flex shrink-0 items-center justify-center rounded-md', className)}><WalletIcon class="size-3.5" /></span>
  {/if}
{/snippet}

{#if connected.address}
  <div class="relative" bind:this={root}>
    <button
      class={[
        'flex items-center gap-2.5 rounded-md text-left transition-colors',
        compact ? 'bg-muted/70 hover:bg-muted h-8 pr-3 pl-1' : 'hover:bg-foreground/[0.05] h-11 w-full px-2',
        open && !compact && 'bg-foreground/[0.05]',
      ]}
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {#if compact}
        {@render avatar('size-6 rounded-sm')}
        <span class="font-mono text-xs">{short(connected.address)}</span>
      {:else}
        {@render avatar('size-7')}
        <span class="min-w-0 flex-1">
          <span class="block truncate font-mono text-xs">{short(connected.address)}</span>
          <span class="text-muted-foreground block truncate text-[11px]">{connected.connected?.name ?? 'Wallet'}{network ? ` · ${network}` : ''}</span>
        </span>
        <EllipsisIcon class="text-muted-foreground size-4" />
      {/if}
    </button>

    {#if open}
      <div
        role="menu"
        class={[
          'bg-popover animate-in fade-in-0 zoom-in-95 absolute z-30 w-48 rounded-lg border p-1 shadow-xl',
          compact ? 'top-full right-0 mt-1.5 origin-top-right' : 'bottom-full left-0 mb-1.5 w-full origin-bottom',
        ]}
      >
        <button role="menuitem" class={item} onclick={copy}>
          {#if copied}<CheckIcon class="size-3.5" /> Copied{:else}<CopyIcon class="size-3.5" /> Copy address{/if}
        </button>
        <button
          role="menuitem"
          class={item}
          onclick={() => {
            open = false
            if (kind === 'solana') disconnectSolana()
            else if (kind === 'cosmos') disconnectCosmos()
            else disconnect()
          }}
        >
          <LogOutIcon class="size-3.5" /> Disconnect
        </button>
      </div>
    {/if}
  </div>
{:else if kind === 'evm'}
  <Button variant="outline" size="sm" class={[!compact && 'w-full']} onclick={connectWallet}>Connect wallet</Button>
{/if}
