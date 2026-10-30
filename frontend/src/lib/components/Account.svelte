<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import LogOutIcon from '@lucide/svelte/icons/log-out'
  import WalletIcon from '@lucide/svelte/icons/wallet'
  import { Button } from '$lib/components/ui/button'
  import { short } from '$lib/evm'
  import { cn } from '$lib/utils'
  import { connectWallet, disconnect, wallet } from '$lib/wallet.svelte'

  // The connected wallet: a full row in the sidebar, a small pill in the mobile header.
  let { compact = false }: { compact?: boolean } = $props()

  let open = $state(false)
  let copied = $state(false)
  let root = $state<HTMLElement>()

  async function copy() {
    await navigator.clipboard.writeText(wallet.address!).catch(() => {})
    copied = true
    setTimeout(() => {
      copied = open = false
    }, 900)
  }

  const item = 'hover:bg-muted flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none focus-visible:bg-muted'
</script>

<svelte:window onpointerdown={(event) => open && !root?.contains(event.target as Node) && (open = false)} onkeydown={(event) => event.key === 'Escape' && (open = false)} />

{#snippet avatar(className: string)}
  {#if wallet.connected?.icon}
    <img src={wallet.connected.icon} alt="" class={cn('shrink-0 rounded-md', className)} />
  {:else}
    <span class={cn('bg-muted flex shrink-0 items-center justify-center rounded-md', className)}><WalletIcon class="size-3.5" /></span>
  {/if}
{/snippet}

{#if wallet.address}
  <div class="relative" bind:this={root}>
    <button
      class={[
        'flex items-center gap-2.5 rounded-lg text-left transition-colors',
        compact ? 'bg-muted/70 hover:bg-muted h-8 rounded-full pr-3 pl-1' : 'hover:bg-foreground/[0.05] h-11 w-full px-2',
        open && !compact && 'bg-foreground/[0.05]',
      ]}
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {#if compact}
        {@render avatar('size-6 rounded-full')}
        <span class="font-mono text-xs">{short(wallet.address)}</span>
      {:else}
        {@render avatar('size-7')}
        <span class="min-w-0 flex-1">
          <span class="block truncate font-mono text-xs">{short(wallet.address)}</span>
          <span class="text-muted-foreground block truncate text-[11px]">{wallet.connected?.name ?? 'Wallet'}</span>
        </span>
        <EllipsisIcon class="text-muted-foreground size-4" />
      {/if}
    </button>

    {#if open}
      <div
        role="menu"
        class={[
          'bg-popover animate-in fade-in-0 zoom-in-95 absolute z-30 w-48 rounded-xl border p-1 shadow-xl',
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
            disconnect()
          }}
        >
          <LogOutIcon class="size-3.5" /> Disconnect
        </button>
      </div>
    {/if}
  </div>
{:else}
  <Button variant="outline" size="sm" class={['rounded-full', !compact && 'w-full']} onclick={connectWallet}>Connect wallet</Button>
{/if}
