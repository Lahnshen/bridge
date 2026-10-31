<script lang="ts">
  import ArrowDownUpIcon from '@lucide/svelte/icons/arrow-down-up'
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import XIcon from '@lucide/svelte/icons/x'
  import usdcLogo from '../../assets/usdc.svg'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getBalance, getFees, INJECTIVE, type Chain, type EvmChain, type Fees, type Hex, type SolanaChain } from '$lib/api'
  import { app, chainOf, injective, navigate } from '$lib/app.svelte'
  import { encode, formatUsdc, forwardHook, parseRecipient, parseUsdc, short, usdcString, type Burn } from '$lib/evm'
  import { history, historyKey, updateHistory } from '$lib/history.svelte'
  import { accountExists, burnOnSolana, isSolanaAddress, publicKey, solanaKeyHex, solanaMintRecipient, usdcAccount } from '$lib/solana'
  import { connectSolanaWallet, signSolanaTransaction, solanaWallet } from '$lib/solana-wallet.svelte'
  import { addRecent, failRecent, recent, refresh, setTransfer } from '$lib/transfers.svelte'
  import { call, connectWallet, sendTx, switchChain, waitForReceipt, wallet, walletError } from '$lib/wallet.svelte'
  import ChainSelect from './ChainSelect.svelte'
  import TransferCard from './TransferCard.svelte'

  // Any two chains, Injective being the default destination. Earlier versions saved one side, the other being Injective.
  const saved = (() => {
    try {
      const route = JSON.parse(localStorage.getItem('route') ?? '{}') as { from?: number; to?: number; remote?: number; outbound?: boolean }
      if (route.remote === undefined) return route
      return route.outbound ? { from: INJECTIVE, to: route.remote } : { from: route.remote, to: INJECTIVE }
    } catch {
      return {}
    }
  })()
  const to = chainOf(saved.to) ?? injective()
  const fromDomain = saved.from ?? 0 // Ethereum
  const from = (fromDomain !== to.domain && chainOf(fromDomain)) || app.chains.find((c) => c.domain !== to.domain)!
  let source = $state<Chain>(from)
  let destination = $state<Chain>(to)
  $effect(() => localStorage.setItem('route', JSON.stringify({ from: source.domain, to: destination.domain })))

  let amountText = $state('')
  let recipientText = $state('')
  let editingRecipient = $state(false)
  let fast = $state(true)
  let forward = $state(true)
  let busy = $state('')
  let error = $state('')

  // Picking the chain on the other side swaps the two.
  function pick(side: 'from' | 'to', chain: Chain) {
    if (chain.domain === (side === 'from' ? destination : source).domain) return flip()
    if (side === 'to' && chain.kind !== destination.kind) resetRecipient()
    if (side === 'from') source = chain
    else destination = chain
  }
  function flip() {
    if (source.kind !== destination.kind) resetRecipient()
    ;[source, destination] = [destination, source]
  }
  function resetRecipient() {
    recipientText = ''
    editingRecipient = false
  }

  // The connected wallet that can sign on (or receive on) a chain.
  const addressOn = (chain: Chain) => (chain.kind === 'solana' ? solanaWallet.address : wallet.address?.toLowerCase())
  const connectFor = (chain: Chain) => (chain.kind === 'solana' ? connectSolanaWallet() : connectWallet())
  const sender = $derived(addressOn(source))

  // ---- Fees and balance ---------------------------------------------------------------------------

  const feeCache = new Map<string, { at: number; fees: Promise<Fees> }>()
  function loadFees(from: number, to: number, setup: boolean) {
    const key = `${from}:${to}:${setup}`
    let hit = feeCache.get(key)
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { at: Date.now(), fees: getFees(from, to, setup) }
      feeCache.set(key, hit)
      hit.fees.catch(() => feeCache.delete(key))
    }
    return hit.fees
  }

  let fees = $state<Fees>()
  let feesError = $state('')
  let feesAttempt = $state(0)
  $effect(() => {
    const [from, to, setup] = [source.domain, destination.domain, needsSetup]
    void feesAttempt
    fees = undefined
    feesError = ''
    let stale = false
    loadFees(from, to, setup).then(
      (result) => !stale && (fees = result),
      (err) => !stale && (feesError = (err as Error).message),
    )
    return () => (stale = true)
  })

  let balance = $state<bigint>()
  let balanceAttempt = $state(0)
  $effect(() => {
    const [domain, address] = [source.domain, sender]
    void balanceAttempt
    balance = undefined
    if (!address) return
    let stale = false
    getBalance(domain, address).then((result) => !stale && (balance = parseUsdc(result.balance)), () => {})
    return () => (stale = true)
  })

  // ---- Quote --------------------------------------------------------------------------------------

  const amount = $derived(parseUsdc(amountText))
  const toInjective = $derived(destination.domain === INJECTIVE)
  // Fast only pays off where a standard transfer is slow (sources that wait for Ethereum finality).
  const canFast = $derived(fees?.fastBps != null && !!fees.standardTime)
  // To Injective our server mints it. Elsewhere Circle can deliver it for a fee, or the recipient claims it,
  // which this app can only do on EVM chains.
  const canForward = $derived(!toInjective && fees?.forwardFee != null)
  const mustForward = $derived(destination.kind === 'solana')
  const useFast = $derived(canFast && fast)
  const useForward = $derived(canForward && (forward || mustForward))
  const fastFee = $derived(useFast && amount ? (amount * BigInt(Math.round(fees!.fastBps! * 1000)) + 9_999_999n) / 10_000_000n : 0n)
  const forwardFee = $derived(useForward ? (parseUsdc(fees!.forwardFee!) ?? 0n) : 0n)
  // Fast fees are charged at attestation time, so they get headroom in case the rate moves, except when forwarding:
  // then Circle keeps the whole maxFee.
  const maxFee = $derived(useForward ? fastFee + forwardFee : useFast ? (fastFee * 3n) / 2n + 1n : 0n)
  const fee = $derived(useForward ? maxFee : fastFee)
  const receive = $derived(amount && amount > fee ? amount - fee : 0n)
  // Nobody mints it for the recipient: they claim it on the destination chain.
  const selfClaim = $derived(toInjective ? !app.config!.autoRedeem : !useForward)

  const recipientValue = $derived(recipientText.trim() || addressOn(destination) || '')
  const recipient = $derived(
    !recipientValue ? undefined : destination.kind === 'solana' ? (isSolanaAddress(recipientValue) ? recipientValue : undefined) : parseRecipient(recipientValue, toInjective),
  )

  // CCTP mints into a Solana wallet's USDC account. When it has none yet, Circle's forwarder creates it, for a higher fee.
  let needsSetup = $state(false)
  const solanaAccount = (chain: Chain, owner: string) => usdcAccount(publicKey(owner)!, chain as SolanaChain)
  $effect(() => {
    const [to, owner] = [destination, recipient]
    needsSetup = false
    if (to.kind !== 'solana' || !owner) return
    let stale = false
    solanaAccount(to, owner)
      .then(accountExists)
      .then((exists) => !stale && (needsSetup = !exists), () => {})
    return () => (stale = true)
  })

  const problem = $derived.by(() => {
    if (!amount) return 'Enter an amount'
    if (balance !== undefined && amount > balance) return 'Not enough USDC'
    if (!fees) return feesError ? 'Fees unavailable' : 'Loading fees…'
    if (mustForward && !useForward) return `Circle can't deliver to ${destination.name} from here`
    if (maxFee >= amount) return 'Amount is below the fee'
    if (!recipient) return recipientValue ? 'Enter a valid recipient' : 'Add a recipient'
  })

  // ---- Bridge -------------------------------------------------------------------------------------

  function setAmount(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.replace(',', '.')
    if (/^\d*\.?\d{0,6}$/.test(value)) amountText = value
    else event.currentTarget.value = amountText
  }

  // Burns on an EVM chain and returns the tx hash once it's sent.
  async function burnOnEvm(from: EvmChain, burn: Burn, hookData?: Hex) {
    const { tokenMessenger } = app.config!
    const padGas = from.domain === INJECTIVE
    busy = `Switching to ${from.name}…`
    await switchChain(from)
    const allowance = BigInt(await call(from.usdc, encode.allowance(wallet.address!, tokenMessenger)))
    if (allowance < burn.amount) {
      busy = 'Approve USDC in your wallet…'
      const approval = await sendTx(from, { to: from.usdc, data: encode.approve(tokenMessenger, burn.amount) }, { padGas })
      busy = 'Approving…'
      if (!(await waitForReceipt(approval))) throw new Error('The approval failed.')
    }
    busy = 'Confirm the transfer in your wallet…'
    const data = hookData ? encode.depositForBurnWithHook(burn, hookData) : encode.depositForBurn(burn)
    return sendTx(from, { to: tokenMessenger, data }, { padGas })
  }

  async function submit() {
    if (!sender) return connectFor(source)
    const [from, to, value] = [source, destination, amount!]
    error = ''
    try {
      // CCTP mints to a Solana wallet's USDC account, not the wallet itself.
      const mintRecipient = to.kind === 'solana' ? await solanaMintRecipient(recipient!, to) : (recipient as Hex)
      if (to.kind === 'solana' && !needsSetup && !(await accountExists(await solanaAccount(to, recipient!)))) {
        needsSetup = true
        error = "The recipient has no USDC account on Solana yet. Circle can create it, which raises the fee: check it and send again."
        return
      }
      const burn = { amount: value, destinationDomain: to.domain, mintRecipient, burnToken: from.usdc as Hex, maxFee, minFinalityThreshold: useFast ? 1000 : 2000 }
      const hookData = useForward ? forwardHook(to.kind === 'solana' && needsSetup ? solanaKeyHex(recipient!) : undefined) : undefined
      if (from.kind === 'solana') {
        const sign = (tx: Uint8Array) => signSolanaTransaction(tx, app.config!.network === 'testnet')
        const signature = await burnOnSolana(from, sender, { ...burn, hookData }, sign, (step) => (busy = step))
        const item = addRecent({ txHash: signature, sourceDomain: from.domain, destinationDomain: to.domain, amount: usdcString(value), createdAt: Date.now(), status: 'pending' })
        amountText = ''
        balanceAttempt++
        navigate('bridge', signature)
        void refresh(item)
        return
      }
      const hash = await burnOnEvm(from, burn, hookData)
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
  <p class="text-muted-foreground mt-1">Between {app.chains.length} chains with Circle CCTP.</p>

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
        <ChainSelect value={source} chains={app.chains} label="From" disabled={!!busy} onchange={(chain) => pick('from', chain)} />
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
      {#if sender}
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
        onclick={flip}
      >
        <ArrowDownUpIcon class="size-3.5" />
      </button>
    </div>

    <div class="bg-card rounded-lg border p-4 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground text-xs">To</span>
        <ChainSelect value={destination} chains={app.chains} label="To" disabled={!!busy} onchange={(chain) => pick('to', chain)} />
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
            placeholder={destination.kind === 'solana' ? 'Recipient Solana address' : toInjective ? 'Recipient 0x… or inj1… address' : 'Recipient 0x… address'}
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
            onclick={resetRecipient}
          >
            <XIcon class="size-3.5" />
          </button>
        {:else}
          To <span class={['text-foreground/80', recipientValue && 'font-mono']}>{recipientValue ? short(recipientValue) : 'your wallet'}</span>
          <button type="button" class="hover:text-foreground p-0.5" aria-label="Change recipient" disabled={!!busy} onclick={() => (editingRecipient = true)}>
            <PencilIcon class="size-3" />
          </button>
          {#if !recipientValue && sender}
            <!-- The source wallet can't receive here (EVM ↔ Solana): connect one that can, or type an address. -->
            <button type="button" class="text-foreground/80 hover:text-foreground ml-auto font-medium" disabled={!!busy} onclick={() => connectFor(destination)}>
              Connect {destination.kind === 'solana' ? 'Solana' : 'EVM'} wallet
            </button>
          {/if}
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
      {#if canForward && !mustForward}
        {@render choice('Delivery', [
          { title: 'Automatic', on: forward, pick: () => (forward = true) },
          { title: 'Claim myself', on: !forward, pick: () => (forward = false) },
        ])}
      {:else if fees}
        <div class="flex items-center justify-between gap-3">
          <span class="text-muted-foreground">Delivery</span>
          <span>{selfClaim ? `Claim on ${destination.name}` : needsSetup ? 'Automatic, opens a USDC account' : 'Automatic'}</span>
        </div>
      {/if}
      {#if source.kind === 'solana'}
        <div class="flex items-center justify-between gap-3">
          <span class="text-muted-foreground">Network fee</span>
          <span title="Mostly rent for the account the burn writes its message to">≈ 0.003 SOL</span>
        </div>
      {/if}
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground">Fee</span>
        {#if feesError}
          <button type="button" class="text-destructive hover:underline" onclick={() => feesAttempt++}>Couldn't load, retry</button>
        {:else if !fees}
          <span class="text-muted-foreground">…</span>
        {:else if useFast && !amount}
          <span class="tabular-nums">
            {(fees.fastBps! / 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%{#if forwardFee}&nbsp;+ {formatUsdc(forwardFee)} USDC{/if}
          </span>
        {:else}
          <span class="tabular-nums">{fee ? `${formatUsdc(fee)} USDC` : 'Free'}</span>
        {/if}
      </div>
    </div>

    {#if toInjective && app.config!.autoRedeem}
      <p class="bg-muted/60 mt-4 flex items-start gap-2 rounded-md px-3 py-2.5 text-xs leading-relaxed">
        <FuelIcon class="text-muted-foreground mt-px size-3.5 shrink-0" />
        <span>No INJ needed: we deliver your USDC on Injective and pay the gas. You can also swap some of it to INJ there, gas free.</span>
      </p>
    {/if}

    <Button type="submit" class="mt-5 h-11 w-full text-[13px]" disabled={!!busy || (!!sender && !!problem)}>
      {#if busy}<Spinner class="size-4" />{busy}{:else if !sender}Connect {source.kind === 'solana' ? 'Solana wallet' : 'wallet'}{:else}{problem ?? `Bridge to ${destination.name}`}{/if}
    </Button>
    {#if error}
      <p class="text-destructive mt-3 text-center text-xs">{error}</p>
    {/if}
  </form>
{/if}
