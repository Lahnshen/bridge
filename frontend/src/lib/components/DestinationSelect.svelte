<script lang="ts" module>
  // The destinations most people pick, in this order, above the rest (A to Z).
  const POPULAR = ['injective', 'ethereum', 'solana', 'base', 'arbitrum', 'arc', 'optimism', 'polygon', 'avalanche', 'bnb', 'hyperliquid', 'noble', 'osmosis']
</script>

<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import SearchIcon from '@lucide/svelte/icons/search'
  import XIcon from '@lucide/svelte/icons/x'
  import { tick } from 'svelte'
  import type { Destination, Token } from '$lib/api'
  import { chainById } from '$lib/app.svelte'
  import ChainIcon from './ChainIcon.svelte'
  import TokenIcon from './TokenIcon.svelte'

  // Where everything goes: a network, and one of its stables. Opens a list of the networks to onboard to, each with its
  // USDC and USDT (or USDT0) as chips; picking the network picks its first.
  let { destinations, chain, token, disabled = false, onchange }: { destinations: Destination[]; chain: string; token?: Token; disabled?: boolean; onchange: (chain: string, token: string) => void } =
    $props()

  // Typing straight away suits a mouse and keyboard; on a phone the keyboard would cover the list.
  const typing = matchMedia('(pointer: fine)').matches

  let dialog = $state<HTMLDialogElement>()
  let open = $state(false)
  let query = $state('')

  const network = $derived(chainById(chain))
  const words = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  // A search matches the start of words in a network's name or id, or a stable's symbol.
  const listed = $derived.by(() => {
    const q = words(query)
    const rank = (d: Destination) => (POPULAR.includes(d.chain) ? POPULAR.indexOf(d.chain) : POPULAR.length)
    const named = destinations.flatMap((d) => {
      const c = chainById(d.chain)
      const own = [...words(c?.name ?? d.chain), ...words(d.chain), ...d.tokens.flatMap((t) => words(t.symbol))]
      return c && q.every((part) => own.some((word) => word.startsWith(part))) ? [{ d, c }] : []
    })
    return named.sort((a, b) => rank(a.d) - rank(b.d) || a.c.name.localeCompare(b.c.name))
  })

  async function show() {
    query = ''
    open = true
    await tick()
    dialog?.showModal()
    dialog?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function pick(id: string, address: string) {
    onchange(id, address)
    dialog?.close()
  }
</script>

<button
  type="button"
  class="bg-muted/80 hover:bg-muted inline-flex h-11 min-w-0 shrink-0 items-center gap-2 rounded-md pr-2 pl-1.5 text-left transition-[background-color,scale] active:scale-[0.97] disabled:opacity-60"
  aria-haspopup="dialog"
  aria-label="Onboard to: {token?.symbol ?? 'a stablecoin'} on {network?.name ?? chain}"
  {disabled}
  onclick={show}
>
  <span class="relative shrink-0">
    {#if token}<TokenIcon {token} class="size-7 text-xs" />{:else}<span class="skeleton block size-7 rounded-full"></span>{/if}
    <ChainIcon chain={network} class="ring-muted absolute -right-1 -bottom-0.5 size-3.5 text-[7px] ring-2" />
  </span>
  <span class="flex min-w-0 flex-col">
    <span class="max-w-28 truncate text-[13px] leading-tight font-medium">{token?.symbol ?? '…'}</span>
    <span class="text-muted-foreground max-w-28 truncate text-[11px] leading-tight">{network?.name ?? chain}</span>
  </span>
  <ChevronDownIcon class="text-muted-foreground size-3.5 shrink-0" />
</button>

<dialog
  bind:this={dialog}
  class="bg-popover text-popover-foreground m-auto h-[min(100dvh-2rem,34rem)] w-[min(100%-2rem,26rem)] overflow-hidden rounded-lg border p-0 shadow-2xl"
  aria-label="Pick where to onboard"
  onclose={() => (open = false)}
  onclick={(event) => event.target === dialog && dialog?.close()}
>
  {#if open}
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-4 py-2.5">
        <h2 class="text-sm font-semibold tracking-tight">Onboard to</h2>
        <button type="button" class="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1 transition-colors" aria-label="Close" onclick={() => dialog?.close()}>
          <XIcon class="size-4" />
        </button>
      </div>
      <label class="flex items-center gap-2 border-b px-3">
        <SearchIcon class="text-muted-foreground size-3.5 shrink-0" />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="placeholder:text-muted-foreground h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          placeholder="Search {destinations.length} networks"
          aria-label="Search networks"
          autocomplete="off"
          spellcheck="false"
          autofocus={typing}
          bind:value={query}
        />
      </label>
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Network">
        {#each listed as { d, c } (d.chain)}
          <div
            role="option"
            aria-selected={d.chain === chain}
            tabindex="-1"
            class={['flex h-10 items-center gap-2 rounded-md px-2 transition-colors', d.chain === chain ? 'bg-muted' : 'hover:bg-muted/60']}
          >
            <button type="button" class="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-[13px]" onclick={() => pick(d.chain, d.tokens[0]!.address)}>
              <ChainIcon chain={c} class="size-[18px] text-[9px]" />
              <span class="min-w-0 truncate font-medium">{c.name}</span>
              {#if d.receiveOnly}<span class="text-muted-foreground shrink-0 text-[10px]" title="The app can't sign there: paste the address to receive at">Paste an address</span>{/if}
            </button>
            <span class="flex shrink-0 gap-1">
              {#each d.tokens as t (t.address)}
                {@const on = d.chain === chain && t.address === token?.address}
                <button
                  type="button"
                  class={['flex h-7 items-center gap-1 rounded-md border px-1.5 text-xs font-medium transition-[background-color,scale] active:scale-95', on ? 'bg-background border-foreground/30' : 'hover:bg-background']}
                  aria-pressed={on}
                  aria-label="{t.symbol} on {c.name}"
                  onclick={() => pick(d.chain, t.address)}
                >
                  <TokenIcon token={t} class="size-4" />{t.symbol}
                  {#if on}<CheckIcon class="text-muted-foreground size-3" />{/if}
                </button>
              {/each}
            </span>
          </div>
        {:else}
          <p class="text-muted-foreground px-2 py-6 text-center text-xs">No network named “{query.trim()}”.</p>
        {/each}
      </div>
    </div>
  {/if}
</dialog>
