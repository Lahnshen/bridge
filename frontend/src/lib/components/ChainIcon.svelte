<script lang="ts" module>
  // Logos for the CCTP chains, 64 px PNGs named after the chain's id. Other chains use the logo the bridges list.
  const files = import.meta.glob<string>('../../assets/chains/*.png', { eager: true, query: '?url', import: 'default' })
  const local = (id: string) => files[`../../assets/chains/${id}.png`]
</script>

<script lang="ts">
  import injectiveLogo from '../../assets/injective.svg'
  import { cn } from '$lib/utils'

  let { chain, class: className = '' }: { chain?: { id: string; name: string; logo?: string }; class?: string } = $props()
  let failed = $state(false)
  const src = $derived(chain && (local(chain.id) ?? chain.logo))
  $effect(() => {
    void src
    failed = false
  })
</script>

{#if chain?.id === 'injective' || chain?.id === 'injective-cosmos'}
  <span class={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[#0c0c10] ring-1 ring-white/15', className)} aria-hidden="true">
    <img src={injectiveLogo} alt="" class="size-3/5" />
  </span>
{:else if src && !failed}
  <img
    {src}
    alt=""
    loading="lazy"
    class={cn('bg-muted inline-block size-5 shrink-0 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/15', className)}
    aria-hidden="true"
    onerror={() => (failed = true)}
  />
{:else}
  <!-- No logo: the chain's initial. -->
  <span
    class={cn('bg-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-1 ring-white/15', className)}
    aria-hidden="true"
  >
    {chain?.name.charAt(0) ?? '?'}
  </span>
{/if}
