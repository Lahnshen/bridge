<script lang="ts" module>
  // A way to bridge: Circle CCTP or one of the other bridges' quotes, in destination token units.
  // id: the bridge's, or with the side for one of Injective's two (see routeKey in Bridge). tag: a note shown by the name.
  export type RouteOption = { id: string; provider: string; name: string; tag?: string; via?: string; out: bigint; min: bigint; seconds: number; time: string; fee: string }
</script>

<script lang="ts">
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import { flip } from 'svelte/animate'
  import { fly } from 'svelte/transition'
  import { formatToken } from '$lib/evm'
  import { ms } from '$lib/motion'
  import { providerLogo } from '$lib/routes'
  import type { Token } from '$lib/api'

  // The chosen route, and the others on demand. The first option is the best one.
  let { options, selected, token, onselect, disabled = false }: { options: RouteOption[]; selected: string; token: Token; onselect: (id: string) => void; disabled?: boolean } = $props()
  let expanded = $state(false)
  const shown = $derived(expanded ? options : options.filter((o) => o.id === selected))
</script>

<div class="flex flex-col gap-1.5" role="radiogroup" aria-label="Route">
  {#each shown as option (option.id)}
    <button
      type="button"
      role="radio"
      aria-checked={option.id === selected}
      {disabled}
      class={[
        'bg-card flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-[background-color,border-color,scale] active:scale-[0.99]',
        option.id === selected ? 'border-foreground/30' : 'hover:bg-muted/50',
      ]}
      animate:flip={{ duration: ms(180) }}
      in:fly={{ y: -4, duration: ms(160) }}
      onclick={() => {
        onselect(option.id)
        expanded = false
      }}
    >
      <img src={providerLogo(option.provider)} alt="" class="size-6 shrink-0 rounded-full object-cover" />
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5 text-[13px] font-medium">
          {option.name}
          {#if option.id === options[0]!.id && options.length > 1}<span class="bg-success/15 text-success rounded-sm px-1 py-px text-[10px] leading-none">Best</span>{/if}
          {#if option.tag}<span class="bg-muted text-muted-foreground rounded-sm px-1 py-px text-[10px] leading-none">{option.tag}</span>{/if}
        </span>
        <span class="text-muted-foreground block truncate text-[11px]">{option.via ? `via ${option.via} · ` : ''}{option.time} · {option.fee}</span>
      </span>
      <span class="shrink-0 text-right text-[13px] font-medium tabular-nums">
        {formatToken(option.out, token.decimals)} <span class="text-muted-foreground font-normal">{token.symbol}</span>
      </span>
    </button>
  {/each}
  {#if options.length > 1}
    <button type="button" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs transition-colors" {disabled} onclick={() => (expanded = !expanded)}>
      {expanded ? 'Fewer routes' : `${options.length - 1} more route${options.length > 2 ? 's' : ''}`}
      <ChevronDownIcon class={['size-3 transition-transform duration-200', expanded && 'rotate-180']} />
    </button>
  {/if}
</div>
