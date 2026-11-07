<script lang="ts" module>
  import type { Dropped } from '$lib/api'

  const REASONS: Record<Dropped, string> = {
    'too-small': 'Too small for the fees',
    'no-route': 'No route',
    'high-loss': 'Would lose too much',
    illiquid: 'Not enough liquidity',
    'needs-gas': 'No gas to move it',
    'needs-wallet': 'Needs another wallet',
    unsupported: 'Not supported',
  }
</script>

<script lang="ts">
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right'
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import XIcon from '@lucide/svelte/icons/x'
  import { fade, slide } from 'svelte/transition'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import type { Leg, Plan, Token } from '$lib/api'
  import { chainById, navigate, txLink } from '$lib/app.svelte'
  import { formatToken, short } from '$lib/evm'
  import { ms } from '$lib/motion'
  import { walletKind } from '$lib/address'
  import { begin, cancelPlan, confirmations, dismiss, finished, isMine, onboard, ownOn, retry, run, skip, stop, walletFor, type LegRun, type Session, type Target } from '$lib/onboard.svelte'
  import { duration, providerLogo, usd } from '$lib/routes'
  import ChainIcon from './ChainIcon.svelte'
  import TokenIcon from './TokenIcon.svelte'

  // A plan before it runs, or a run in progress: its legs by the network they start on (and the account, from several),
  // what stays where it is, and what's left behind. While running, each leg shows how it's doing, and failed ones can be
  // retried or skipped.
  let { plan, target, session }: { plan: Plan; target: Target; session?: Session } = $props()

  const destination = $derived(chainById(target.to))
  // Whose a network's legs are, where the plan sends from several accounts of a wallet.
  const senders = $derived(target.senders ?? [])
  function ownerOn(id: string, group = 0) {
    const chain = chainById(id)
    const kind = chain && walletKind(chain)
    const many = (kind === 'evm' || kind === 'solana') && new Set(senders.map((a) => a[kind]).filter(Boolean)).size > 1
    return many && chain ? ownOn(chain, senders[group] ?? {}) : undefined
  }
  const groups = $derived.by(() => {
    const byChain = new Map<string, Leg[]>()
    for (const leg of plan.legs) byChain.set(`${leg.group ?? 0}:${leg.from}`, [...(byChain.get(`${leg.group ?? 0}:${leg.from}`) ?? []), leg])
    return [...byChain].map(([key, legs]) => ({ key, chain: chainById(legs[0]!.from), id: legs[0]!.from, owner: ownerOn(legs[0]!.from, legs[0]!.group), legs }))
  })
  // The accounts the wallets sign from: with several of one, the user switches between them as asked.
  const switches = $derived(groups.some((g) => g.owner))
  const runOf = (leg: Leg): LegRun | undefined => session?.legs[leg.id]
  const count = $derived(confirmations(plan.legs))
  // The wallet batches only after upgrading the account (EIP-7702), which it asks about first.
  const upgrade = $derived(Object.values(onboard.support).includes('ready'))
  const done = $derived(session ? plan.legs.filter((l) => runOf(l)?.status === 'done' || runOf(l)?.status === 'skipped').length : 0)
  const over = $derived(!!session && finished(session))
  const failures = $derived(session ? plan.legs.filter((l) => runOf(l)?.status === 'failed').length : 0)
  const moving = $derived(session ? plan.legs.filter((l) => runOf(l)?.status === 'sent').length : 0)
  const tally = $derived(`${done} of ${plan.legs.length} done${moving ? `, ${moving} on the way` : ''}.`)
  // What reached the destination in its token, once the legs that land there are done; the INJ from Get INJ apart.
  const arrived = $derived(
    plan.legs
      .filter((l) => l.to === target.to && l.kind !== 'get-inj' && l.purpose === 'consolidate' && runOf(l)?.status === 'done')
      .reduce((sum, l) => sum + BigInt(runOf(l)!.out ?? l.amountOut), 0n),
  )
  const gotInj = $derived(plan.legs.find((l) => l.kind === 'get-inj' && runOf(l)?.status === 'done'))
  // A run that ended without sending anything arrived nowhere: it isn't shown as done.
  const moved = $derived(plan.legs.some((l) => runOf(l)?.status === 'sent' || runOf(l)?.status === 'done'))
  const landed = $derived(over && moved)
  // Continue has something to do: a leg whose inputs are in (or one declined, asked for again), or transfers to follow.
  const final = (id: string) => ['done', 'skipped'].includes(session?.legs[id]?.status ?? 'done')
  const ready = $derived(plan.legs.some((l) => runOf(l)?.declined || runOf(l)?.status === 'sent' || (runOf(l)?.status === 'waiting' && [...(l.after ?? []), ...(l.inputs ?? [])].every(final))))
  // Funds that go to an address the connected wallets don't hold get a second look before signing.
  const mine = $derived(!!destination && isMine(destination, target.recipient))
  let showDropped = $state(false)

  const amount = (value: string | bigint, token: Pick<Token, 'decimals' | 'symbol'>) => `${formatToken(BigInt(value), token.decimals)} ${token.symbol}`
  const inj = (value: string) => `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 })} INJ`
  function title(leg: Leg) {
    const to = chainById(leg.to)?.name ?? leg.to
    if (leg.kind === 'get-inj') return 'Get INJ for gas'
    if (leg.kind === 'swap') return `Swap ${leg.fromToken.symbol} to ${leg.toToken.symbol}`
    if (leg.purpose === 'refuel') return `Gas for ${to}`
    if (leg.purpose === 'gas') return `${leg.toToken.symbol} for gas on ${to}`
    return `${leg.fromToken.symbol === leg.toToken.symbol ? leg.fromToken.symbol : `${leg.fromToken.symbol} as ${leg.toToken.symbol}`} to ${to}`
  }
  // In and out, as planned until the leg ran, less what its skipped inputs would have brought.
  function flow(leg: Leg) {
    const r = runOf(leg)
    const planned = BigInt(leg.amount)
    const skipped = (leg.inputs ?? []).filter((id) => session?.legs[id]?.status === 'skipped')
    const left = skipped.reduce((sum, id) => sum - BigInt(plan.legs.find((l) => l.id === id)?.amountOut ?? 0), planned)
    const sends = !skipped.length ? planned : left > BigInt(leg.base) ? left : BigInt(leg.base)
    const gets = sends === planned ? BigInt(leg.amountOut) : (BigInt(leg.amountOut) * sends) / planned
    const out = leg.kind === 'get-inj' && r?.out ? inj(r.out) : `${r?.status === 'done' ? '' : '≈ '}${amount(r?.out ?? gets, leg.toToken)}`
    return `${amount(r?.amount ?? sends, leg.fromToken)} → ${out}`
  }
  // The bridge, and how long it takes once a run shows statuses where the plan shows times.
  const via = (leg: Leg) => [leg.name, leg.via?.replace(/\s*\(.*\)$/, ''), session && duration(leg.seconds)].filter(Boolean).join(' · ')
  // A transfer to another chain opens in the Bridge tab, which follows it; a swap links to the explorer.
  const link = (leg: Leg, r?: LegRun) => (r?.txHash && !r.recentKey && leg.kind === 'swap' ? txLink(chainById(leg.from), r.txHash) : undefined)
  const GAS: Record<Plan['gas']['kind'], string> = { none: 'Not added', 'has-gas': 'You have gas there', stable: 'Paid in the stable', 'get-inj': 'Get INJ, gas free', topup: 'Added to a transfer', leg: 'A small transfer', unavailable: 'Not planned' }
</script>

{#snippet row(label: string, value: string, title?: string, tone = '')}
  <div class="flex items-center justify-between gap-3">
    <span class="text-muted-foreground shrink-0">{label}</span>
    <span class={['truncate text-right tabular-nums', tone]} {title}>{value}</span>
  </div>
{/snippet}

{#snippet status(r?: LegRun)}
  {@const s = r?.status ?? 'waiting'}
  <span class="flex size-5 shrink-0 items-center justify-center" aria-label={s}>
    {#if s === 'running'}
      <Spinner class="size-4" />
    {:else if s === 'sent'}
      <span class="border-foreground/60 flex size-4 items-center justify-center rounded-full border"><span class="bg-foreground size-1.5 animate-pulse rounded-full"></span></span>
    {:else if s === 'done'}
      <span class="bg-foreground text-background flex size-4 items-center justify-center rounded-full" in:fade={{ duration: ms(150) }}><CheckIcon class="size-2.5" strokeWidth={3} /></span>
    {:else if s === 'failed'}
      <span class="bg-destructive flex size-4 items-center justify-center rounded-full text-white"><XIcon class="size-2.5" strokeWidth={3} /></span>
    {:else if s === 'skipped'}
      <span class="border-muted-foreground/40 text-muted-foreground flex size-4 items-center justify-center rounded-full border"><MinusIcon class="size-2.5" strokeWidth={3} /></span>
    {:else}
      <span class="border-muted-foreground/40 size-4 rounded-full border"></span>
    {/if}
  </span>
{/snippet}

{#if !session}
  <button class="text-muted-foreground hover:text-foreground -ml-0.5 inline-flex items-center gap-1 text-xs transition-colors" onclick={cancelPlan}>
    <ArrowLeftIcon class="size-3.5" /> Change the selection
  </button>
{/if}

<!-- What arrives, and what it costs. -->
<div class="bg-card mt-3 rounded-lg border p-3.5 shadow-xs">
  <span class="text-muted-foreground text-xs">{landed ? 'Arrived' : 'You receive'}</span>
  <div class="mt-1.5 flex items-center gap-3">
    <div class="min-w-0 flex-1">
      {#key landed ? arrived : plan.summary.amountOut}
        <span class={['settle block truncate text-[26px] leading-none font-medium tracking-tight tabular-nums', over && !moved && 'text-muted-foreground line-through decoration-1']}>
          {landed ? '' : '≈ '}{formatToken(landed ? arrived : BigInt(plan.summary.amountOut), target.toToken.decimals)}
        </span>
      {/key}
      <span class="text-muted-foreground mt-1 block truncate text-xs tabular-nums">
        {#if landed}{gotInj ? `plus ${inj(session!.legs[gotInj.id]!.out ?? '0')} for gas` : `on ${destination?.name}`}{:else if over}Nothing was sent{:else}at least {formatToken(BigInt(plan.summary.minAmountOut), target.toToken.decimals)}, from {usd(plan.summary.usdIn)}{/if}
      </span>
    </div>
    <span class="bg-muted/80 inline-flex h-11 shrink-0 items-center gap-2 rounded-md pr-2.5 pl-1.5">
      <span class="relative shrink-0">
        <TokenIcon token={target.toToken} class="size-7 text-xs" />
        <ChainIcon chain={destination} class="ring-muted absolute -right-1 -bottom-0.5 size-3.5 text-[7px] ring-2" />
      </span>
      <span class="flex flex-col">
        <span class="text-[13px] leading-tight font-medium">{target.toToken.symbol}</span>
        <span class="text-muted-foreground text-[11px] leading-tight">{destination?.name}</span>
      </span>
    </span>
  </div>
  <div class="mt-3.5 flex flex-col gap-2 border-t pt-3 text-xs">
    <div class="flex items-center justify-between gap-3">
      <span class="text-muted-foreground shrink-0">To</span>
      <span class="flex min-w-0 items-center gap-1.5" title={target.recipient}>
        {#if !mine}<span class="bg-warning/15 text-warning shrink-0 rounded-sm px-1 py-px text-[10px] leading-none">Not a connected wallet</span>{/if}
        <span class="truncate font-mono">{short(target.recipient)}</span>
      </span>
    </div>
    {#if !over}
      {@render row('Fees', `${usd(plan.summary.feesUsd)}${plan.summary.costUsd >= 0.01 ? ` + ${usd(plan.summary.costUsd)} network` : ''}`, 'Taken by the bridges, plus the gas paid on the way')}
      {@render row('Time', plan.legs.length ? duration(plan.summary.seconds) : '—', 'The longest chain of steps, end to end')}
      {#if plan.gas.kind !== 'none' || plan.gas.detail}
        {@render row(`Gas on ${destination?.name}`, GAS[plan.gas.kind], undefined, plan.gas.kind === 'unavailable' ? 'text-warning' : '')}
        {#if plan.gas.detail}<p class="text-muted-foreground -mt-1 text-[11px] leading-snug text-pretty">{plan.gas.detail}</p>{/if}
      {/if}
      {#if plan.legs.length}{@render row('Wallet confirmations', `${count}`, 'At most: approvals the wallet already has are skipped')}{/if}
    {/if}
  </div>
  {#if !session && upgrade}
    <p class="bg-muted/60 text-muted-foreground mt-3 rounded-md px-2.5 py-2 text-[11px] leading-relaxed">
      Your wallet can confirm each network's steps at once if you let it upgrade your account to its smart account. Declining is fine: the steps then go one by one.
    </p>
  {/if}
  {#if !session && switches}
    <p class="bg-muted/60 text-muted-foreground mt-3 rounded-md px-2.5 py-2 text-[11px] leading-relaxed">
      These steps send from several of your accounts. Your wallet signs from the account it's on, so switch accounts in it when asked: each account's steps go together.
    </p>
  {/if}
</div>

{#if plan.legs.length}
  <ol class="mt-3 flex flex-col gap-2" aria-label="Steps">
    {#each groups as g (g.key)}
      <li class="bg-card rounded-lg border shadow-xs">
        <div class="flex h-9 items-center gap-2 border-b px-3.5">
          <ChainIcon chain={g.chain ?? { id: g.id, name: g.id }} class="size-4 text-[8px]" />
          <span class="truncate text-xs font-medium">
            From {g.chain?.name ?? g.id}{#if g.owner}<span class="text-muted-foreground ml-1.5 font-mono text-[11px] font-normal" title={g.owner}>{short(g.owner)}</span>{/if}
          </span>
          <span class="text-muted-foreground ml-auto text-[11px] tabular-nums">{g.legs.length} step{g.legs.length === 1 ? '' : 's'} · {confirmations(g.legs)} to confirm</span>
        </div>
        <ol>
          {#each g.legs as leg (leg.id)}
            {@const r = runOf(leg)}
            {@const logo = providerLogo(leg.provider)}
            <li class="flex gap-2.5 px-3.5 py-2.5">
              {#if leg.kind === 'get-inj'}
                <span class="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full"><FuelIcon class="size-3.5" /></span>
              {:else if logo}
                <img src={logo} alt="" class="size-6 shrink-0 rounded-full object-cover" />
              {:else}
                <TokenIcon token={leg.fromToken} class="size-6" />
              {/if}
              <div class="min-w-0 flex-1">
                <p class={['text-[13px] leading-tight font-medium', r?.status === 'skipped' && 'text-muted-foreground line-through decoration-1']}>{title(leg)}</p>
                <p class="text-muted-foreground mt-0.5 truncate text-[11px] tabular-nums" title={flow(leg)}>{flow(leg)}</p>
                <p class="text-muted-foreground/80 truncate text-[11px]">{via(leg)}</p>
                {#if r?.status === 'running' && onboard.current === leg.id && onboard.action}
                  <p class="mt-1 text-[11px]" in:fade={{ duration: ms(120) }}>{onboard.action}</p>
                {:else if r?.status === 'sent'}
                  <p class="text-muted-foreground mt-1 flex items-center gap-2 text-[11px]">
                    {leg.kind === 'swap' ? 'Confirming…' : 'On its way…'}
                    {#if r.recentKey}<button class="text-foreground/80 hover:text-foreground underline-offset-2 hover:underline" onclick={() => navigate('bridge', r.recentKey)}>Follow it</button>{/if}
                  </p>
                {:else if r?.status === 'failed'}
                  <p class="text-destructive mt-1 text-[11px] leading-snug" transition:slide={{ duration: ms(150) }}>{r.error}</p>
                  <div class="mt-1.5 flex gap-1.5">
                    <Button size="xs" variant="outline" class="px-2" disabled={onboard.running || onboard.elsewhere} onclick={() => retry(leg.id)}>Retry</Button>
                    <Button size="xs" variant="ghost" class="text-muted-foreground px-2" disabled={onboard.elsewhere} onclick={() => skip(leg.id)}>Skip</Button>
                  </div>
                {:else if r?.status === 'skipped' && r.error}
                  <p class="text-muted-foreground mt-1 text-[11px]">{r.error}</p>
                {/if}
                {#if r?.status === 'done' && (link(leg, r) || r.recentKey)}
                  <p class="mt-1 text-[11px]">
                    {#if r.recentKey}
                      <button class="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline" onclick={() => navigate('bridge', r.recentKey)}>Details</button>
                    {:else}
                      <a class="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5" href={link(leg, r)} target="_blank" rel="noreferrer">
                        Transaction<ArrowUpRightIcon class="size-3" />
                      </a>
                    {/if}
                  </p>
                {/if}
              </div>
              {#if session}{@render status(r)}{:else}<span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">{duration(leg.seconds)}</span>{/if}
            </li>
          {/each}
        </ol>
      </li>
    {/each}
  </ol>
{/if}

{#if plan.kept.length || plan.dropped.length}
  <div class="mt-3 flex flex-col gap-1.5 px-1 text-xs">
    {#if plan.kept.length}
      <p class="text-muted-foreground">
        Already there: <span class="text-foreground/80 tabular-nums">{plan.kept.map((k) => amount(k.amount, k.token)).join(', ')}</span>
      </p>
    {/if}
    {#if plan.dropped.length}
      <button type="button" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start transition-colors" onclick={() => (showDropped = !showDropped)}>
        Left behind ({plan.dropped.length}{plan.dropped.some((d) => d.usd) ? `, ${usd(plan.dropped.reduce((sum, d) => sum + (d.usd ?? 0), 0))}` : ''})
        <ChevronDownIcon class={['size-3 transition-transform duration-200', showDropped && 'rotate-180']} />
      </button>
      {#if showDropped}
        <ul class="flex flex-col gap-1" transition:slide={{ duration: ms(150) }}>
          {#each plan.dropped as d, i (i)}
            {@const chain = chainById(d.chain)}
            {@const connect = d.reason === 'needs-wallet' && chain && !session ? walletFor(chain) : undefined}
            {@const owner = ownerOn(d.chain, d.group)}
            <li class="flex items-center gap-2" title={d.detail}>
              <TokenIcon token={d.token} class="size-4 text-[8px]" />
              <span class="min-w-0 flex-1 truncate">
                {d.token.symbol} on {chain?.name ?? d.chain}{owner ? ` (${short(owner)})` : ''}{d.usd !== undefined ? ` · ${usd(d.usd)}` : ''}
                <span class="text-muted-foreground">· {REASONS[d.reason] ?? d.reason}</span>
              </span>
              <!-- Connecting it reads the holdings again, and the plan is made again with it. -->
              {#if connect}
                <button type="button" class="text-foreground shrink-0 underline-offset-2 hover:underline" onclick={connect.connect}>{connect.label}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{/if}

{#if !session}
  <Button class="mt-4 h-11 w-full text-[13px] transition-[background-color,scale] active:scale-[0.99]" disabled={!plan.legs.length} onclick={begin}>
    {#if plan.legs.length}Start · {count} confirmation{count === 1 ? '' : 's'}{:else}Nothing to move{/if}
  </Button>
  <p class="text-muted-foreground mt-2.5 px-1 text-center text-[11px] leading-relaxed">
    Each step is quoted again before you sign it, and stops if the price got more than 0.5% worse. Exact approvals only.
  </p>
{:else if onboard.running || onboard.elsewhere}
  <!-- Another tab running it: this one only shows it. -->
  <div class="mt-4 flex items-center gap-3" in:fade={{ duration: ms(120) }}>
    <p class="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-xs">
      <Spinner class="size-3.5 shrink-0" /><span class="truncate">{onboard.elsewhere ? 'Running in another tab…' : onboard.stopping ? 'Stopping after this step…' : onboard.action || 'Working…'}</span>
    </p>
    {#if !onboard.elsewhere}<Button variant="outline" size="sm" class="px-3.5" disabled={onboard.stopping} onclick={stop}>Stop</Button>{/if}
  </div>
  <p class="text-muted-foreground mt-2 px-1 text-[11px]">{tally} Steps already sent can't be undone.</p>
{:else if over}
  <div class="mt-4 flex items-center gap-3">
    <p class="text-muted-foreground min-w-0 flex-1 text-xs">
      {!moved ? 'Nothing was sent: your holdings stay where they are.' : failures ? `Done, but ${failures} step${failures === 1 ? '' : 's'} failed: what they held stays on its network.` : 'All done.'}
    </p>
    <Button variant="outline" size="sm" class="px-3.5" onclick={dismiss}>New onboard</Button>
  </div>
{:else}
  <div class="mt-4 flex items-center gap-3">
    <p class="text-muted-foreground min-w-0 flex-1 text-xs">
      {ready || !failures ? (session.paused ?? 'Transfers on their way.') : 'A failed step holds up the ones after it: retry or skip it.'}
      <span class="tabular-nums">{tally}</span>
    </p>
    {#if ready}<Button size="sm" class="px-3.5" onclick={run}>Continue</Button>{/if}
  </div>
  <!-- Always a way out: what was sent keeps going, and the rest stays where it is. -->
  <button class="text-muted-foreground hover:text-foreground mt-2 px-1 text-[11px] underline-offset-2 hover:underline" onclick={dismiss}>End this run here</button>
{/if}
