<script lang="ts">
  import usdcLogo from '../../assets/usdc.svg'
  import { cn } from '$lib/utils'

  // A token's logo, or its first letter when it has none (or it fails to load).
  let { token, class: className = '' }: { token: { symbol: string; logo?: string }; class?: string } = $props()
  let failed = $state(false)
  const src = $derived(token.logo ?? (token.symbol === 'USDC' ? usdcLogo : undefined))
  $effect(() => {
    void src
    failed = false
  })
</script>

{#if src && !failed}
  <img {src} alt="" class={cn('size-5 shrink-0 rounded-full object-cover', className)} onerror={() => (failed = true)} />
{:else}
  <span class={cn('bg-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white', className)} aria-hidden="true">
    {token.symbol.charAt(0)}
  </span>
{/if}
