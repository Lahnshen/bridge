<script lang="ts">
  import ArrowDownUpIcon from '@lucide/svelte/icons/arrow-down-up'
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import XIcon from '@lucide/svelte/icons/x'
  import usdcLogo from '../../assets/usdc.svg'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getBalance, getFees, INJECTIVE, type Fees, type Hex } from '$lib/api'
  import { app, injective, navigate, remotes } from '$lib/app.svelte'
  import { encode, FORWARD_HOOK, formatUsdc, parseRecipient, parseUsdc, short, usdcString } from '$lib/evm'
  import { history, historyKey, updateHistory } from '$lib/history.svelte'
  import { addRecent, failRecent, recent, refresh, setTransfer } from '$lib/transfers.svelte'
  import { call, connectWallet, sendTx, switchChain, waitForReceipt, wallet, walletError } from '$lib/wallet.svelte'
  import ChainSelect from './ChainSelect.svelte'
  import TransferCard from './TransferCard.svelte'

  // One side is always Injective, `remote` is the other.
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('route') ?? '{}') as { remote?: number; outbound?: boolean }
    } catch {
      return {}
    }
  })()
  let remote = $state(remotes().find((c) => c.domain === saved.remote) ?? remotes()[0]!)
  let outbound = $state(!!saved.outbound)
  $effect(() => localStorage.setItem('route', JSON.stringify({ remote: remote.domain, outbound })))

  const source = $derived(outbound ? injective() : remote)
  const destination = $derived(outbound ? remote : injective())

  let amountText = $state('')
  let recipientText = $state('')
  let editingRecipient = $state(false)
  let fast = $state(true)
  let forward = $state(true)
  let busy = $state('')
  let error = $state('')

  // ---- Fees and balance ---------------------------------------------------------------------------

  const feeCache = new Map<string, { at: number; fees: Promise<Fees> }>()
  function loadFees(from: number, to: number) {
    const key = `${from}:${to}`
    let hit = feeCache.get(key)
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { at: Date.now(), fees: getFees(from, to) }
      feeCache.set(key, hit)
      hit.fees.catch(() => feeCache.delete(key))
    }
    return hit.fees
  }

  let fees = $state<Fees>()
  let feesError = $state('')
  let feesAttempt = $state(0)
  $effect(() => {
    const [from, to] = [source.domain, destination.domain]
    void feesAttempt
    fees = undefined
    feesError = ''
    let stale = false
    loadFees(from, to).then(
      (result) => !stale && (fees = result),
      (err) => !stale && (feesError = (err as Error).message),
    )
    return () => (stale = true)
  })

  let balance = $state<bigint>()
  let balanceAttempt = $state(0)
  $effect(() => {
    const [domain, address] = [source.domain, wallet.address]
    void balanceAttempt
    balance = undefined
    if (!address) return
    let stale = false
    getBalance(domain, address).then((result) => !stale && (balance = parseUsdc(result.balance)), () => {})
    return () => (stale = true)
  })

  // ---- Quote --------------------------------------------------------------------------------------

  const amount = $derived(parseUsdc(amountText))
  // Fast only pays off where a standard transfer is slow (sources that wait for Ethereum finality).
  const canFast = $derived(!outbound && fees?.fastBps != null && !!fees.standardTime)
  const canForward = $derived(outbound && fees?.forwardFee != null)
  const useFast = $derived(canFast && fast)
  const useForward = $derived(canForward && forward)
  const fee = $derived.by(() => {
    if (useFast) return amount ? (amount * BigInt(Math.round(fees!.fastBps! * 1000)) + 9_999_999n) / 10_000_000n : 0n
    if (useForward) return parseUsdc(fees!.forwardFee!) ?? 0n
    return 0n
  })
  // Fast fees are charged at attestation time: leave headroom in case the rate moves. Circle charges the forwarding fee in full.
  const maxFee = $derived(useFast ? (fee * 3n) / 2n + 1n : fee)
  const receive = $derived(amount && amount > fee ? amount - fee : 0n)
  // Nobody mints it for the recipient: they claim it on the destination chain.
  const selfClaim = $derived(outbound ? !useForward : !app.config!.autoRedeem)

  const recipient = $derived(
    recipientText.trim() ? parseRecipient(recipientText, destination.domain === INJECTIVE) : (wallet.address?.toLowerCase() as Hex | undefined),
  )

  const problem = $derived.by(() => {
    if (!amount) return 'Enter an amount'
    if (balance !== undefined && amount > balance) return 'Not enough USDC'
    if (!fees) return feesError ? 'Fees unavailable' : 'Loading fees…'
    if (maxFee >= amount) return 'Amount is below the fee'
    if (!recipient) return 'Enter a valid recipient'
  })

  // ---- Bridge -------------------------------------------------------------------------------------

  function setAmount(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.replace(',', '.')
    if (/^\d*\.?\d{0,6}$/.test(value)) amountText = value
    else event.currentTarget.value = amountText
  }

  async function submit() {
    if (!wallet.address) return connectWallet()
    const { tokenMessenger } = app.config!
    const [from, to, value, mintRecipient] = [source, destination, amount!, recipient!]
    const burn = { amount: value, destinationDomain: to.domain, mintRecipient, burnToken: from.usdc, maxFee, minFinalityThreshold: useFast ? 1000 : 2000 }
    const data = useForward ? encode.depositForBurnWithHook(burn, FORWARD_HOOK) : encode.depositForBurn(burn)
    const padGas = from.domain === INJECTIVE
    error = ''
    try {
      busy = `Switching to ${from.name}…`
      await switchChain(from)
      const allowance = BigInt(await call(from.usdc, encode.allowance(wallet.address, tokenMessenger)))
      if (allowance < value) {
        busy = 'Approve USDC in your wallet…'
        const approval = await sendTx(from, { to: from.usdc, data: encode.approve(tokenMessenger, value) }, { padGas })
        busy = 'Approving…'
        if (!(await waitForReceipt(approval))) throw new Error('The approval failed.')
      }
      busy = 'Confirm the transfer in your wallet…'
      const hash = await sendTx(from, { to: tokenMessenger, data }, { padGas })
      const item = addRecent({ txHash: hash, sourceDomain: from.domain, destinationDomain: to.domain, amount: usdcString(value), createdAt: Date.now(), status: 'confirming' })
      amountText = ''
      navigate('bridge', hash)
      waitForReceipt(hash).then(
        (ok) => {
          if (ok) void refresh(item)
          else failRecent(item, `The transaction failed on ${from.name}.`)
          balanceAttempt++
        },
        () => {},
      )
    } catch (err) {
      error = walletError(err) ?? ''
    } finally {
      busy = ''
    }
  }

  // ---- Sent transfer --------------------------------------------------------------------------------

  // Sent from here, or from the wallet's history.
  const opened = $derived(recent.find((r) => r.txHash === app.open) ?? history.transfers.find((t) => historyKey(t) === app.open))
  const heading = $derived.by(() => {
    if (!opened) return ''
    const message = 'createdAt' in opened ? opened.transfer?.message : opened.message
    const claim = !!message && (opened.status === 'restricted' || (opened.status === 'ready' && (opened.destinationDomain !== INJECTIVE || !app.config!.autoRedeem)))
    if (claim) return 'Ready to claim'
    return { confirming: 'Sending', pending: 'On its way', ready: 'Almost there', redeemed: 'Arrived', restricted: 'Needs attention', failed: 'Transfer failed' }[opened.status]
  })
</script>

{#snippet choice(label: string, options: { title: string; hint?: string; on: boolean; pick: () => void }[])}
  <div class="flex items-center justify-between gap-3">
    <span class="text-muted-foreground">{label}</span>
    <div class="bg-muted/70 flex rounded-md p-0.5" role="radiogroup" aria-label={label}>
      {#each options as option (option.title)}
        <button
          type="button"
          role="radio"
          aria-checked={option.on}
          disabled={!!busy}
          class={['h-6 rounded-sm px-2.5 transition-colors', option.on ? 'bg-background text-foreground shadow-xs dark:bg-white/12' : 'text-muted-foreground hover:text-foreground']}
          onclick={option.pick}
        >
          {option.title}{#if option.hint}<span class="text-muted-foreground ml-1">{option.hint}</span>{/if}
        </button>
      {/each}
    </div>
  </div>
{/snippet}

{#if opened}
  <button class="text-muted-foreground hover:text-foreground -ml-0.5 inline-flex items-center gap-1 text-xs transition-colors" onclick={() => navigate('bridge')}>
    <ArrowLeftIcon class="size-3.5" /> New transfer
  </button>
  <h1 class="mt-3 mb-5 font-serif text-[26px] leading-tight tracking-tight">{heading}</h1>
  <TransferCard item={opened} onupdate={(transfer) => ('createdAt' in opened ? setTransfer(opened, transfer) : updateHistory(transfer))} />
{:else}
  <h1 class="font-serif text-[26px] leading-tight tracking-tight">Bridge USDC</h1>
  <p class="text-muted-foreground mt-1">To and from Injective with Circle CCTP.</p>

  <form
    class="mt-6"
    onsubmit={(event) => {
      event.preventDefault()
      void submit()
    }}
  >
    <div class="bg-card rounded-lg border p-4 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground text-xs">From</span>
        <ChainSelect value={source} chains={remotes()} label="From" disabled={!!busy} onchange={outbound ? undefined : (chain) => (remote = chain)} />
      </div>
      <div class="mt-3 flex items-center gap-3">
        <input
          class="placeholder:text-muted-foreground/40 min-w-0 flex-1 bg-transparent text-[28px] leading-none font-medium tracking-tight tabular-nums outline-none"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          aria-label="Amount"
          value={amountText}
          oninput={setAmount}
          disabled={!!busy}
        />
        <span class="flex shrink-0 items-center gap-1.5 font-medium"><img src={usdcLogo} alt="" class="size-5" /> USDC</span>
      </div>
      {#if wallet.address}
        <div class="text-muted-foreground mt-2.5 flex h-4 items-center gap-1.5 text-xs">
          Balance <span class="tabular-nums">{balance === undefined ? '…' : formatUsdc(balance)}</span>
          {#if balance}
            <button type="button" class="text-foreground/80 hover:text-foreground font-medium" disabled={!!busy} onclick={() => (amountText = usdcString(balance!))}>Max</button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="relative z-10 flex h-1 items-center justify-center">
      <button
        type="button"
        class="bg-card hover:bg-muted flex size-8 items-center justify-center rounded-md border shadow-xs transition-colors"
        aria-label="Swap direction"
        disabled={!!busy}
        onclick={() => (outbound = !outbound)}
      >
        <ArrowDownUpIcon class="size-3.5" />
      </button>
    </div>

    <div class="bg-card rounded-lg border p-4 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground text-xs">To</span>
        <ChainSelect value={destination} chains={remotes()} label="To" disabled={!!busy} onchange={outbound ? (chain) => (remote = chain) : undefined} />
      </div>
      <div class="mt-3 flex items-center gap-3">
        <span class={['min-w-0 flex-1 truncate text-[28px] leading-none font-medium tracking-tight tabular-nums', !receive && 'text-muted-foreground/40']}>
          {receive ? formatUsdc(receive) : '0'}
        </span>
        <span class="flex shrink-0 items-center gap-1.5 font-medium"><img src={usdcLogo} alt="" class="size-5" /> USDC</span>
      </div>
      <div class="text-muted-foreground mt-2.5 flex h-4 items-center gap-1.5 text-xs">
        {#if editingRecipient}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class={['min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans', recipientText.trim() && !recipient ? 'text-destructive' : 'text-foreground']}
            placeholder={destination.domain === INJECTIVE ? 'Recipient 0x… or inj1… address' : 'Recipient 0x… address'}
            aria-label="Recipient address"
            autocomplete="off"
            spellcheck="false"
            autofocus
            disabled={!!busy}
            bind:value={recipientText}
          />
          <button
            type="button"
            class="hover:text-foreground"
            aria-label="Send to my wallet"
            onclick={() => {
              editingRecipient = false
              recipientText = ''
            }}
          >
            <XIcon class="size-3.5" />
          </button>
        {:else}
          To <span class={['text-foreground/80', wallet.address && 'font-mono']}>{wallet.address ? short(wallet.address) : 'your wallet'}</span>
          <button type="button" class="hover:text-foreground p-0.5" aria-label="Change recipient" disabled={!!busy} onclick={() => (editingRecipient = true)}>
            <PencilIcon class="size-3" />
          </button>
        {/if}
      </div>
    </div>

    <div class="mt-4 flex flex-col gap-2.5 px-1 text-xs">
      {#if canFast}
        {@render choice('Speed', [
          { title: 'Fast', hint: '< 1 min', on: fast, pick: () => (fast = true) },
          { title: 'Standard', hint: fees!.standardTime!, on: !fast, pick: () => (fast = false) },
        ])}
      {/if}
      {#if canForward}
        {@render choice('Delivery', [
          { title: 'Automatic', on: forward, pick: () => (forward = true) },
          { title: 'Claim myself', on: !forward, pick: () => (forward = false) },
        ])}
      {:else if selfClaim && fees}
        <div class="flex items-center justify-between gap-3">
          <span class="text-muted-foreground">Delivery</span>
          <span>Claim on {destination.name}</span>
        </div>
      {/if}
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground">Fee</span>
        {#if feesError}
          <button type="button" class="text-destructive hover:underline" onclick={() => feesAttempt++}>Couldn't load, retry</button>
        {:else if !fees}
          <span class="text-muted-foreground">…</span>
        {:else if useFast && !amount}
          <span class="tabular-nums">{(fees.fastBps! / 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%</span>
        {:else}
          <span class="tabular-nums">{fee ? `${formatUsdc(fee)} USDC` : 'Free'}</span>
        {/if}
      </div>
    </div>

    <Button type="submit" class="mt-5 h-11 w-full text-[13px]" disabled={!!busy || (!!wallet.address && !!problem)}>
      {#if busy}<Spinner class="size-4" />{busy}{:else if !wallet.address}Connect wallet{:else}{problem ?? `Bridge to ${destination.name}`}{/if}
    </Button>
    {#if error}
      <p class="text-destructive mt-3 text-center text-xs">{error}</p>
    {/if}
  </form>
{/if}
