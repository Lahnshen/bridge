<script lang="ts">
  import injectiveLogo from '../../assets/injective.svg'
  import { INJECTIVE } from '$lib/api'
  import { cn } from '$lib/utils'

  let { domain, name = '', class: className = '' }: { domain: number; name?: string; class?: string } = $props()

  // Brand colours with the chain's initial stand in for logos.
  const COLORS: Record<number, string> = {
    0: '#627eea', 1: '#e84142', 2: '#ff0420', 3: '#28a0f0', 6: '#0052ff', 7: '#8247e5', 10: '#f50db4', 11: '#1f1f1f', 12: '#4f46e5', 13: '#f97316', 14: '#1f1f1f',
    15: '#836ef9', 16: '#9e1f19', 18: '#244b81', 19: '#0f766e', 21: '#7132f5', 22: '#d9480f', 26: '#2563eb', 30: '#14a800', 32: '#002d74', 33: '#15803d', 37: '#1f1f1f',
  }
</script>

{#if domain === INJECTIVE}
  <span class={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0c0c10] ring-1 ring-white/15', className)} aria-hidden="true">
    <img src={injectiveLogo} alt="" class="size-3/5" />
  </span>
{:else}
  <span
    class={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-1 ring-white/15', className)}
    style:background={COLORS[domain] ?? '#52525b'}
    aria-hidden="true"
  >
    {name.charAt(0)}
  </span>
{/if}
