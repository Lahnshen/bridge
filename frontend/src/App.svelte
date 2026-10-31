<script lang="ts">
  import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right'
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import SearchIcon from '@lucide/svelte/icons/search'
  import injectiveLogo from './assets/injective.svg'
  import Account from '$lib/components/Account.svelte'
  import Bridge from '$lib/components/Bridge.svelte'
  import RecentList from '$lib/components/RecentList.svelte'
  import Swap from '$lib/components/Swap.svelte'
  import Track from '$lib/components/Track.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import WalletDialog from '$lib/components/WalletDialog.svelte'
  import { app, loadConfig, navigate } from '$lib/app.svelte'
  import { loadHistory } from '$lib/history.svelte'
  import { solanaWallet } from '$lib/solana-wallet.svelte'
  import { wallet } from '$lib/wallet.svelte'

  void loadConfig()

  // The wallet's indexed transfers fill the Recent list, refreshed when the wallet changes or the tab comes back.
  $effect(() => {
    if (wallet.address) void loadHistory(wallet.address)
  })
  const refreshHistory = () => document.visibilityState === 'visible' && wallet.address && loadHistory(wallet.address)

  const NAV = $derived(
    [
      { view: 'bridge', label: 'Bridge', icon: ArrowLeftRightIcon },
      { view: 'swap', label: 'Get INJ', icon: FuelIcon },
      { view: 'track', label: 'Track', icon: SearchIcon },
    ].filter((item) => item.view !== 'swap' || app.config?.swap) as { view: typeof app.view; label: string; icon: typeof SearchIcon }[],
  )
  const current = (view: typeof app.view) => app.view === view && !(view === 'bridge' && app.open)
</script>

{#snippet brand()}
  <span class="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
    <span class="flex size-6 items-center justify-center rounded-md bg-[#0c0c10] ring-1 ring-white/10">
      <img src={injectiveLogo} alt="" class="size-3.5" />
    </span>
    Injective Bridge
    {#if app.config?.network === 'testnet'}
      <span class="bg-warning/15 text-warning rounded px-1.5 py-px text-[10px] font-medium">Testnet</span>
    {/if}
  </span>
{/snippet}

<svelte:document onvisibilitychange={refreshHistory} />

<div class="flex min-h-svh">
  <aside class="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r md:flex">
    <div class="flex h-14 items-center px-4">{@render brand()}</div>
    <nav class="flex flex-col gap-0.5 px-2">
      {#each NAV as item (item.view)}
        <button
          class={[
            'flex h-8 items-center gap-2.5 rounded-md px-2 text-left transition-colors',
            current(item.view) ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
          ]}
          aria-current={current(item.view) ? 'page' : undefined}
          onclick={() => navigate(item.view)}
        >
          <item.icon class="size-4" />
          {item.label}
        </button>
      {/each}
    </nav>
    <RecentList class="mt-6 min-h-0 flex-1 overflow-y-auto px-2 pb-2" />
    <div class="border-sidebar-border flex flex-col gap-0.5 border-t p-2">
      <Account />
      {#if solanaWallet.address}<Account kind="solana" />{/if}
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="bg-background/80 sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur md:hidden">
      {@render brand()}
      <Account compact kind={wallet.address || !solanaWallet.address ? 'evm' : 'solana'} />
    </header>

    <main class="dots flex-1 px-4 pt-6 pb-20 md:pt-[12vh]">
      <div class="mx-auto w-full max-w-[26rem]">
        <div class={['bg-muted/70 mb-8 grid rounded-md p-0.5 md:hidden', NAV.length === 3 ? 'grid-cols-3' : 'grid-cols-2']}>
          {#each NAV as item (item.view)}
            <button
              class={['h-8 rounded-sm text-[13px] font-medium transition-colors', app.view === item.view ? 'bg-background shadow-xs dark:bg-white/12' : 'text-muted-foreground']}
              onclick={() => navigate(item.view)}
            >
              {item.label}
            </button>
          {/each}
        </div>

        {#if app.config}
          <div class={{ hidden: app.view !== 'bridge' }}><Bridge /></div>
          {#if app.config.swap}<div class={{ hidden: app.view !== 'swap' }}><Swap /></div>{/if}
          <div class={{ hidden: app.view !== 'track' }}><Track /></div>
        {:else if app.error}
          <div class="flex flex-col items-center gap-4 pt-16 text-center">
            <p class="text-muted-foreground">{app.error}</p>
            <Button variant="outline" size="sm" class="px-4" onclick={loadConfig}>Try again</Button>
          </div>
        {:else}
          <div class="flex justify-center pt-20"><Spinner class="text-muted-foreground size-5" /></div>
        {/if}
      </div>
    </main>
  </div>
</div>

<WalletDialog />
