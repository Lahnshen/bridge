<script lang="ts" module>
  // Chain logos, 64 px PNGs named after the chain.
  const files = import.meta.glob<string>('../../assets/chains/*.png', { eager: true, query: '?url', import: 'default' })
  const SLUGS: Record<number, string> = {
    0: 'ethereum', 1: 'avalanche', 2: 'optimism', 3: 'arbitrum', 5: 'solana', 6: 'base', 7: 'polygon', 10: 'unichain', 11: 'linea', 12: 'codex',
    13: 'sonic', 14: 'worldchain', 15: 'monad', 16: 'sei', 18: 'xdc', 19: 'hyperevm', 21: 'ink', 22: 'plume', 25: 'starknet', 26: 'arc',
    27: 'stellar', 28: 'edge', 30: 'morph', 31: 'pharos', 32: 'cronos', 33: 'plasma', 37: 'xlayer',
  }
  const logo = (domain: number) => files[`../../assets/chains/${SLUGS[domain]}.png`]
</script>

<script lang="ts">
  import injectiveLogo from '../../assets/injective.svg'
  import { INJECTIVE } from '$lib/api'
  import { cn } from '$lib/utils'

  let { domain, name = '', class: className = '' }: { domain: number; name?: string; class?: string } = $props()
  const src = $derived(logo(domain))
</script>

{#if domain === INJECTIVE}
  <span class={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0c0c10] ring-1 ring-white/15', className)} aria-hidden="true">
    <img src={injectiveLogo} alt="" class="size-3/5" />
  </span>
{:else if src}
  <img {src} alt="" class={cn('inline-block size-5 shrink-0 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/15', className)} aria-hidden="true" />
{:else}
  <!-- No logo: the chain's initial. -->
  <span
    class={cn('bg-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-1 ring-white/15', className)}
    aria-hidden="true"
  >
    {name.charAt(0)}
  </span>
{/if}
