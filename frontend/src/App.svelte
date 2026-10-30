<script lang="ts">
  import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right'
  import SearchIcon from '@lucide/svelte/icons/search'
  import injectiveLogo from './assets/injective.svg'
  import Account from '$lib/components/Account.svelte'
  import Bridge from '$lib/components/Bridge.svelte'
  import RecentList from '$lib/components/RecentList.svelte'
  import Track from '$lib/components/Track.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import WalletDialog from '$lib/components/WalletDialog.svelte'
  import { app, loadConfig, navigate } from '$lib/app.svelte'

  void loadConfig()

  const NAV = [
    { view: 'bridge', label: 'Bridge', icon: ArrowLeftRightIcon },
    { view: 'track', label: 'Track', icon: SearchIcon },
  ] as const
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

<div class="flex min-h-svh">
  <aside class="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r md:flex">
    <div class="flex h-14 items-center px-4">{@render brand()}</div>
    <nav class="flex flex-col gap-0.5 px-2">
      {#each NAV as item (item.view)}
        <button
          class={[
            'flex h-8 items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
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
    <div class="border-sidebar-border border-t p-2"><Account /></div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="bg-background/80 sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur md:hidden">
      {@render brand()}
      <Account compact />
    </header>

    <main class="dots flex-1 px-4 pt-6 pb-20 md:pt-[12vh]">
      <div class="mx-auto w-full max-w-[26rem]">
        <div class="bg-muted/70 mb-8 grid grid-cols-2 rounded-full p-0.5 md:hidden">
          {#each NAV as item (item.view)}
            <button
              class={['h-8 rounded-full text-[13px] font-medium transition-colors', app.view === item.view ? 'bg-background shadow-xs dark:bg-white/12' : 'text-muted-foreground']}
              onclick={() => navigate(item.view)}
            >
              {item.label}
            </button>
          {/each}
        </div>

        {#if app.config}
          <div class={{ hidden: app.view !== 'bridge' }}><Bridge /></div>
          <div class={{ hidden: app.view !== 'track' }}><Track /></div>
        {:else if app.error}
          <div class="flex flex-col items-center gap-4 pt-16 text-center">
            <p class="text-muted-foreground">{app.error}</p>
            <Button variant="outline" size="sm" class="rounded-full px-4" onclick={loadConfig}>Try again</Button>
          </div>
        {:else}
          <div class="flex justify-center pt-20"><Spinner class="text-muted-foreground size-5" /></div>
        {/if}
      </div>
    </main>
  </div>
</div>

<WalletDialog />
