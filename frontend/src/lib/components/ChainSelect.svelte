<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import type { Chain } from '$lib/api'
  import ChainIcon from './ChainIcon.svelte'

  // A chain pill. With onchange it opens a list to pick from, otherwise it's a fixed label.
  let { value, chains = [], onchange, label, disabled = false }: { value: Chain; chains?: Chain[]; onchange?: (chain: Chain) => void; label: string; disabled?: boolean } =
    $props()

  let open = $state(false)
  let root = $state<HTMLElement>()
  let trigger = $state<HTMLButtonElement>()
  let list = $state<HTMLElement>()

  $effect(() => {
    if (open) list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  })

  function close(refocus = true) {
    open = false
    if (refocus) trigger?.focus()
  }

  function pick(chain: Chain) {
    onchange?.(chain)
    close()
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') return close()
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const pill = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-muted/80 pr-2.5 pl-1.5 text-[13px] font-medium'
</script>

<svelte:window onpointerdown={(event) => open && !root?.contains(event.target as Node) && close(false)} />

<div class="relative" bind:this={root} onfocusout={(event) => open && !root?.contains(event.relatedTarget as Node) && close(false)}>
  {#if onchange}
    <button
      bind:this={trigger}
      type="button"
      class="{pill} hover:bg-muted transition-colors disabled:opacity-60"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label="{label}: {value.name}"
      {disabled}
      onclick={() => (open = !open)}
    >
      <ChainIcon domain={value.domain} name={value.name} />
      {value.name}
      <ChevronDownIcon class="text-muted-foreground size-3.5" />
    </button>
  {:else}
    <span class={pill} aria-label="{label}: {value.name}">
      <ChainIcon domain={value.domain} name={value.name} />
      {value.name}
    </span>
  {/if}

  {#if open}
    <div
      bind:this={list}
      role="listbox"
      tabindex="-1"
      aria-label={label}
      class="bg-popover animate-in fade-in-0 zoom-in-95 absolute top-full right-0 z-30 mt-1.5 max-h-72 w-52 origin-top-right overflow-y-auto rounded-lg border p-1 shadow-xl"
      onkeydown={keydown}
    >
      {#each chains as chain (chain.domain)}
        <button
          type="button"
          role="option"
          aria-selected={chain.domain === value.domain}
          class="hover:bg-muted focus-visible:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none"
          onclick={() => pick(chain)}
        >
          <ChainIcon domain={chain.domain} name={chain.name} class="size-[18px] text-[9px]" />
          {chain.name}
          {#if chain.domain === value.domain}<CheckIcon class="text-muted-foreground ml-auto size-3.5" />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
