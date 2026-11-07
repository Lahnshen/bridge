<script lang="ts">
  import ArrowDownUpIcon from '@lucide/svelte/icons/arrow-down-up'
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import InfoIcon from '@lucide/svelte/icons/info'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import XIcon from '@lucide/svelte/icons/x'
  import { tick } from 'svelte'
  import { fade, slide } from 'svelte/transition'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { addressHint, parseAddress, walletKind } from '$lib/address'
  import { getFees, getQuotes, getTokens, INJECTIVE, isNative, sameToken, tokenBalance, type CctpChain, type Chain, type Fees, type Hex, type Quote, type QuoteBody, type Token } from '$lib/api'
  import { app, chainById, chainOf, injective, listedChain, navigate, setBridgeQuery } from '$lib/app.svelte'
  import { addressFromWallet, connectCosmosWallet, cosmosWallet } from '$lib/cosmos-wallet.svelte'
  import { burnOnEvm, cctpFees } from '$lib/cctp'
  import { amountString, formatToken, formatUsdc, forwardHook, parseAmount, short } from '$lib/evm'
  import { history, historyKey, updateHistory } from '$lib/history.svelte'
  import { ms } from '$lib/motion'
  import { bridgesBetween } from '$lib/reach'
  import { addressesFor, addressOn, addRouteRecent, cosmosConfirmed, cosmosSigner, duration, runSteps, sideOf, usd } from '$lib/routes'
  import { accountExists, burnOnSolana, publicKey, solanaKeyHex, solanaMintRecipient, usdcAccount } from '$lib/solana'
  import { connectSolanaWallet, signSolanaTransaction } from '$lib/solana-wallet.svelte'
  import { acceptTerms } from '$lib/terms.svelte'
  import { addRecent, failRecent, recent, refresh, sentRecent, setTransfer, type Recent } from '$lib/transfers.svelte'
  import { connectWallet, waitForReceipt, wallet, walletError } from '$lib/wallet.svelte'
  import AssetSelect from './AssetSelect.svelte'
  import ChainIcon from './ChainIcon.svelte'
  import RouteCard from './RouteCard.svelte'
  import RouteList, { type RouteOption } from './RouteList.svelte'
  import TransferCard from './TransferCard.svelte'

  // USDC where CCTP reaches; a chain's gas token as the bridges list it.
  const usdcOf = (chain: Chain): Token | undefined =>
    chain.domain !== undefined && 'usdc' in chain && chain.usdc ? { chain: chain.id, address: chain.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true } : undefined
  const nativeOf = (chain: Chain): Token | undefined => chain.native && { chain: chain.id, ...chain.native, verified: true }
  // A chain's token when none is named: USDC where CCTP reaches it, else its gas token.
  const defaultToken = (chain: Chain): Token => usdcOf(chain) ?? nativeOf(chain) ?? { chain: chain.id, address: '', symbol: 'Token', name: '', decimals: 0, verified: false }
  const isUsdc = (token: Token) => {
    const chain = chainById(token.chain)
    const usdc = chain && usdcOf(chain)
    return !!usdc && sameToken(token, usdc)
  }
  const restore = (token: Token | undefined, chain: Chain) => (token?.chain === chain.id ? token : defaultToken(chain))

  // ---- Route ----------------------------------------------------------------------------------------

  // Where the form starts: the route in a shared link, else the last one picked here, else USDC from Ethereum to Injective.
  // Routes saved by earlier versions name chains by CCTP domain (or one side, the other being Injective).
  type SavedToken = Token & { domain?: number }
  type Saved = { from?: string | number; to?: string | number; remote?: number; outbound?: boolean; fromToken?: SavedToken; toToken?: SavedToken }
  const saved = ((): Saved | undefined => {
    try {
      const route = JSON.parse(localStorage.getItem('route') ?? 'null') as Saved | null
      if (!route || route.remote === undefined) return route ?? undefined
      return route.outbound ? { from: INJECTIVE, to: route.remote } : { from: route.remote, to: INJECTIVE }
    } catch {
      return undefined
    }
  })()
  const savedChain = (ref?: string | number) => (typeof ref === 'number' ? chainOf(ref) : listedChain(chainById(ref)))
  const savedToken = (saved?: SavedToken): Token | undefined => {
    if (!saved) return
    const { priceUsd, ...token } = saved // a saved price is out of date
    if (token.chain) return token
    const chain = chainOf(token.domain)
    return chain && { ...token, chain: chain.id }
  }
  const link = new URLSearchParams(location.search)
  const [linkFrom, linkTo] = [listedChain(chainById(link.get('from'))), listedChain(chainById(link.get('to')))]
  const linked = !!(linkFrom || linkTo)
  const start = linked ? { from: linkFrom, to: linkTo } : { from: savedChain(saved?.from), to: savedChain(saved?.to) }
  const ethereum = chainById('ethereum') ?? app.chains[0]!
  const to = start.to ?? (start.from?.id === 'injective' ? ethereum : injective())
  const from = (start.from && start.from.id !== to.id ? start.from : undefined) ?? (to.id === ethereum.id ? injective() : ethereum)

  // A link names USDC and the gas token by symbol, other tokens by address (or symbol). Those are looked up, unless it's
  // the one last used here (coming back to the form from another tab, say).
  function named(chain: Chain, value: string, last?: Token) {
    const [usdc, native, v] = [usdcOf(chain), nativeOf(chain), value.toLowerCase()]
    if (usdc && v === 'usdc') return usdc
    if (native && v === native.symbol.toLowerCase()) return native
    if (last?.chain === chain.id && last.address.toLowerCase() === v) return last
  }
  async function lookUp(chain: Chain, value: string) {
    const { tokens } = await getTokens(chain.id, value)
    const v = value.toLowerCase()
    return tokens.find((t) => t.address.toLowerCase() === v) ?? tokens.find((t) => t.verified && t.symbol.toLowerCase() === v)
  }
  const [fromParam, toParam] = [link.get('fromToken') ?? '', link.get('toToken') ?? '']
  const [fromNamed, toNamed] = [fromParam && named(from, fromParam, savedToken(saved?.fromToken)), toParam && named(to, toParam, savedToken(saved?.toToken))]

  let source = $state<Chain>(from)
  let destination = $state<Chain>(to)
  let fromToken = $state<Token>(linked ? fromNamed || defaultToken(from) : restore(savedToken(saved?.fromToken), from))
  let toToken = $state<Token>(linked ? toNamed || defaultToken(to) : restore(savedToken(saved?.toToken), to))

  // Until a linked token is found, the chain's default token stands in for it and the link stays as it is. A change made
  // meanwhile wins.
  let edits = 0
  let looking = $state(false)
  if (linked) {
    const lookups = [
      fromParam && !fromNamed && lookUp(from, fromParam).then((t) => t && !edits && (fromToken = t)),
      toParam && !toNamed && lookUp(to, toParam).then((t) => t && !edits && (toToken = t)),
    ].filter((lookup) => lookup instanceof Promise)
    looking = lookups.length > 0
    void Promise.allSettled(lookups).then(() => (looking = false))
  }

  // First-time visitors get suggestions until they pick a route. From then on it's saved, and in the URL to share:
  // /bridge?from=arbitrum&to=injective&fromToken=ETH&toToken=INJ. A chain's default token goes without saying.
  let chosen = $state(linked || !!saved)
  const tokenParam = (chain: Chain, token: Token) => {
    const native = nativeOf(chain)
    return sameToken(token, defaultToken(chain)) ? '' : native && sameToken(token, native) ? token.symbol : token.address
  }
  $effect(() => {
    const route = { from: source.id, to: destination.id, fromToken: $state.snapshot(fromToken), toToken: $state.snapshot(toToken) }
    if (looking) return
    if (!chosen) return setBridgeQuery('')
    localStorage.setItem('route', JSON.stringify(route))
    const params = new URLSearchParams({ from: source.id, to: destination.id })
    if (tokenParam(source, fromToken)) params.set('fromToken', tokenParam(source, fromToken))
    if (tokenParam(destination, toToken)) params.set('toToken', tokenParam(destination, toToken))
    setBridgeQuery(`?${params}`)
  })

  let amountText = $state('')
  let recipientText = $state('')
  let editingRecipient = $state(false)
  let fast = $state(true)
  let forward = $state(true)
  // How far below its quote another bridge's route may deliver (in bps), kept for next time.
  const SLIPPAGES = [50, 100, 300]
  let slippage = $state(SLIPPAGES.find((bps) => bps === Number(localStorage.getItem('slippage'))) ?? 50)
  function setSlippage(bps: number) {
    slippage = bps
    localStorage.setItem('slippage', String(bps))
  }
  let busy = $state('')
  let error = $state('')
  let turns = $state(0) // half turns of the swap button

  // Picking the other side's chain swaps the two sides.
  function choose(side: 'from' | 'to', chain: Chain, token: Token) {
    const symbol = fromToken.symbol
    if (chain.id === (side === 'from' ? destination : source).id) {
      if (side === 'from') [source, fromToken, destination, toToken] = [chain, token, source, fromToken]
      else [destination, toToken, source, fromToken] = [chain, token, destination, toToken]
      turns++
    } else if (side === 'from') [source, fromToken] = [chain, token]
    else [destination, toToken] = [chain, token]
    changed(symbol)
  }
  function flip() {
    const symbol = fromToken.symbol
    ;[source, destination] = [destination, source]
    ;[fromToken, toToken] = [toToken, fromToken]
    turns++
    changed(symbol)
  }
  // An amount of another token means something else, and an address for another chain goes.
  function changed(symbolBefore: string) {
    edits++
    chosen = true
    error = ''
    if (fromToken.symbol !== symbolBefore) amountText = ''
    if (recipientText.trim() && !parseAddress(destination, recipientText)) resetRecipient()
  }
  function resetRecipient() {
    recipientText = ''
    editingRecipient = false
  }
  // Opens the recipient field with the cursor in it. Browsers skip autofocus once something on the page has focus.
  let recipientInput = $state<HTMLInputElement>()
  async function editRecipient() {
    editingRecipient = true
    await tick()
    recipientInput?.focus()
  }

  // Routes to Injective for first-time visitors, gone once they pick a route.
  const SUGGESTED: { from: string; gas?: true }[] = [
    { from: 'ethereum' }, // USDC
    { from: 'solana' },
    { from: 'base' },
    { from: 'arbitrum', gas: true }, // ETH to INJ, through the other bridges
  ]
  const suggestions = $derived(
    chosen
      ? []
      : SUGGESTED.flatMap(({ from, gas }) => {
          const [a, b] = [chainById(from), chainById('injective')]
          const [tokenIn, tokenOut] = a && b ? (gas ? [nativeOf(a), nativeOf(b)] : [usdcOf(a), usdcOf(b)]) : []
          if (!a || !b || !tokenIn || !tokenOut || (gas && !app.config?.providers.length)) return []
          const on = source.id === a.id && destination.id === b.id && sameToken(fromToken, tokenIn) && sameToken(toToken, tokenOut)
          return [{ from: a, to: b, tokenIn, tokenOut, on }]
        }),
  )
  function suggest({ from, to, tokenIn, tokenOut }: (typeof suggestions)[number]) {
    const symbol = fromToken.symbol
    ;[source, destination, fromToken, toToken] = [from, to, tokenIn, tokenOut]
    changed(symbol)
  }

  // ---- Wallets ------------------------------------------------------------------------------------

  // Injective's Cosmos side, where the Cosmos wallet is connected and the EVM wallet isn't: that wallet signs there.
  const cosmosOnly = (chain: Chain) => (chain.kind === 'evm' && chain.cosmos && cosmosWallet.connected && !wallet.address ? chain.cosmos : undefined)
  const sender = $derived(addressOn(source))

  async function connectFor(picked: Chain) {
    const chain = cosmosOnly(picked) ?? picked
    const kind = walletKind(chain)
    if (kind === 'evm') return connectWallet()
    if (kind === 'solana') return connectSolanaWallet()
    if (chain.kind !== 'cosmos') return
    if (!cosmosWallet.connected) return connectCosmosWallet(chain)
    error = ''
    try {
      await addressFromWallet(chain) // the wallet asks to allow the chain the first time
    } catch (err) {
      error = walletError(err) ?? ''
    }
  }
  const connectLabel = (chain: Chain) => {
    if (cosmosOnly(chain)) return `Use ${cosmosWallet.connected!.name} on ${chain.name}`
    const kind = walletKind(chain)
    if (kind === 'solana') return 'Connect Solana wallet'
    if (kind !== 'cosmos') return 'Connect wallet'
    return cosmosWallet.connected ? `Use ${cosmosWallet.connected.name} on ${chain.name}` : 'Connect Cosmos wallet'
  }

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
    if (!cctp || from === undefined || to === undefined) return
    let stale = false
    loadFees(from, to, setup).then(
      (result) => !stale && (fees = result),
      (err) => !stale && (feesError = (err as Error).message),
    )
    return () => (stale = true)
  })

  let balance = $state<bigint>()
  let balanceFailed = $state(false)
  let balanceAttempt = $state(0)
  $effect(() => {
    const [chain, address, token] = [source, sender, fromToken.address]
    void balanceAttempt
    balance = undefined
    balanceFailed = false
    if (!address || !token || !chain.send) return
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout>
    // Public RPCs have hiccups: two more tries, a few seconds apart, before giving up.
    const load = (tries: number) =>
      tokenBalance(chain, address, token, controller.signal).then(
        (value) => !controller.signal.aborted && (balance = value),
        () => {
          if (controller.signal.aborted) return
          if (tries > 1) retry = setTimeout(() => load(tries - 1), 3000)
          else balanceFailed = true
        },
      )
    void load(3)
    return () => {
      controller.abort()
      clearTimeout(retry)
    }
  })

  // ---- What can take this transfer -----------------------------------------------------------------

  const bridges = $derived(bridgesBetween(source, destination))
  // Injective's EVM and Cosmos sides are one chain: one account, and one balance for INJ, USDC and the rest.
  const sameInjective = $derived([source.id, destination.id].sort().join() === 'injective,injective-cosmos')
  // Why no route can be found, before asking the bridges.
  const blocked = $derived.by(() => {
    if (!source.send) return { title: `Can't send from ${source.name}`, detail: `${source.name} is a destination only: the app can't sign transactions there. Send from another network.` }
    if (sameInjective)
      return { title: 'Nothing to bridge', detail: 'Injective EVM and Injective (Cosmos) are one chain: your 0x… and inj1… addresses are the same account, and INJ and USDC have one balance on both.' }
    if (!bridges.length) return { title: 'Route not available', detail: `None of the bridges here connects ${source.name} and ${destination.name}.` }
    if (!fromToken.address || !toToken.address) return { title: 'Pick a token', detail: undefined }
  })

  // ---- CCTP quote ---------------------------------------------------------------------------------

  const amount = $derived(parseAmount(amountText, fromToken.decimals))
  // USDC to USDC can go through CCTP itself; any other pair only through the other bridges.
  const cctp = $derived(isUsdc(fromToken) && isUsdc(toToken))
  const toInjective = $derived(destination.id === 'injective')
  // Fast only pays off where a standard transfer is slow (sources that wait for Ethereum finality).
  const canFast = $derived(fees?.fastBps != null && !!fees.standardTime)
  // To Injective our server mints it. Elsewhere Circle can deliver it for a fee, or the recipient claims it,
  // which this app can only do on EVM chains.
  const canForward = $derived(!toInjective && fees?.forwardFee != null)
  const mustForward = $derived(destination.kind === 'solana')
  const useFast = $derived(canFast && fast)
  const useForward = $derived(canForward && (forward || mustForward))
  // Fast fees get headroom, forwarding fees are kept whole (see cctpFees).
  const cctpFee = $derived(cctpFees(amount ?? 0n, fees, useFast, useForward))
  const forwardFee = $derived(cctpFee.forwardFee)
  const maxFee = $derived(cctpFee.maxFee)
  const fee = $derived(cctpFee.fee)
  const receive = $derived(amount && amount > fee ? amount - fee : 0n)
  // Nobody mints it for the recipient: they claim it on the destination chain.
  const selfClaim = $derived(toInjective ? !app.config!.autoRedeem : !useForward)

  const recipientValue = $derived(recipientText.trim() || addressOn(destination, true) || '')
  const recipient = $derived(recipientValue ? parseAddress(destination, recipientValue) : undefined)

  // CCTP mints into a Solana wallet's USDC account. When it has none yet, Circle's forwarder creates it, for a higher fee.
  let needsSetup = $state(false)
  const solanaAccount = (chain: CctpChain, owner: string) => usdcAccount(publicKey(owner)!, chain as Extract<CctpChain, { kind: 'solana' }>)
  $effect(() => {
    const [to, owner] = [destination, recipient]
    needsSetup = false
    if (to.kind !== 'solana' || !owner) return
    let stale = false
    solanaAccount(to as CctpChain, owner)
      .then(accountExists)
      .then((exists) => !stale && (needsSetup = !exists), () => {})
    return () => (stale = true)
  })

  // ---- Other bridges' quotes ------------------------------------------------------------------------

  // A bridge can have two routes to or from Injective, one on each side.
  const routeKey = (q: Quote) => (q.side ? `${q.provider}:${q.side}` : q.provider)

  // The user's Cosmos accounts the wallet gave, for routes that pass through those chains.
  const known = $derived(Object.keys(cosmosWallet.addresses).length ? { ...cosmosWallet.addresses } : undefined)
  let quotes = $state<Quote[]>([])
  let quoteErrors = $state<string[]>([])
  let quoting = $state(false)
  $effect(() => {
    const body: QuoteBody | undefined = amount
      ? {
          from: source.id,
          to: destination.id,
          fromToken: fromToken.address,
          toToken: toToken.address,
          amount: String(amount),
          sender,
          recipient: recipient && recipient !== sender ? recipient : undefined,
          addresses: known,
          slippageBps: slippage,
        }
      : undefined
    quotes = []
    quoteErrors = []
    quoting = false
    if (!body || blocked || !bridges.some((b) => b !== 'cctp') || !app.config?.providers.length) return
    quoting = true
    const controller = new AbortController()
    const name = (id: string) => app.config?.providers.find((p) => p.id === id)?.name ?? id
    // While a transfer is being sent, the routes on screen stay put.
    const load = () =>
      !busy &&
      getQuotes(body, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return
          quotes = result.quotes
          quoteErrors = result.errors.map((e) => `${name(e.provider)}: ${e.message}`)
          quoting = false
        },
        (err) => !controller.signal.aborted && ((quoteErrors = [(err as Error).message]), (quoting = false)),
      )
    const delay = setTimeout(load, 400)
    const refresh = setInterval(load, 30_000)
    return () => {
      controller.abort()
      clearTimeout(delay)
      clearInterval(refresh)
    }
  })

  // What a route charges on top of the amount, in the source chain's gas token: in USD when the bridge priced it.
  const cost = (q: Quote) => {
    if (q.costUsd) return usd(q.costUsd)
    const gas = nativeOf(source)
    if (!q.costNative || !gas) return
    return `${formatToken(BigInt(q.costNative), gas.decimals)} ${gas.symbol}`
  }

  // CCTP with the speed and delivery picked below, and every other bridge's quote. Best first (see score); on a tie, CCTP.
  const options = $derived.by((): RouteOption[] => {
    const list: RouteOption[] = quotes.map((q) => ({
      id: routeKey(q),
      provider: q.provider,
      name: q.name,
      // Out of Injective, a route from its Cosmos side is signed by Keplr where it's connected, else by the EVM wallet (as
      // EIP-712 typed data, see lib/injective-eip712.ts).
      tag: q.side && source.kind === 'evm' && source.cosmos?.id === q.side ? (cosmosWallet.connected ? cosmosWallet.connected.name : 'Cosmos side') : undefined,
      via: q.via?.replace(/\s*\(.*\)$/, ''), // "StargateV2 (Fast mode)" is too long for the row
      out: BigInt(q.amountOut),
      min: BigInt(q.minAmountOut),
      seconds: q.seconds,
      time: duration(q.seconds),
      // Relay's fee can be negative: it pays for transfers in a direction it needs. Costs under a cent only show below.
      fee: [q.feeUsd && q.feeUsd > 0 ? `${usd(q.feeUsd)} fee` : 'No fee', !(q.costUsd! < 0.01) && cost(q) && `+ ${cost(q)}`].filter(Boolean).join(' '),
    }))
    if (cctp && fees && amount && receive && maxFee < amount && !(mustForward && !useForward)) {
      const time = useFast || !fees.standardTime ? '< 1 min' : fees.standardTime
      list.unshift({ id: 'cctp', provider: 'cctp', name: 'Circle CCTP', out: receive, min: receive, seconds: useFast || !fees.standardTime ? 30 : 1200, time, fee: fee ? `${formatUsdc(fee)} USDC fee` : 'No fee' })
    }
    // Waiting counts as 0.01% of the amount a minute, so a route a few cents better but twenty minutes slower doesn't win.
    const score = (o: RouteOption) => o.out * (1_000_000n - BigInt(Math.min(Math.round((o.seconds / 60) * 100), 500_000)))
    return list.sort((a, b) => {
      const [x, y] = [score(a), score(b)]
      return y > x ? 1 : y < x ? -1 : a.id === 'cctp' ? -1 : b.id === 'cctp' ? 1 : a.seconds - b.seconds
    })
  })
  // The user's pick holds until the chains or tokens change.
  let picked = $state<string>()
  $effect(() => {
    void [source, destination, fromToken, toToken]
    picked = undefined
  })
  const selected = $derived(options.find((o) => o.id === picked) ?? options[0])
  const selectedQuote = $derived(quotes.find((q) => routeKey(q) === selected?.id))
  // Chains the selected route passes through, where it needs one of the user's addresses.
  const needs = $derived((selectedQuote?.needs ?? []).map((id) => chainById(id)?.name ?? id))

  // Both amounts in USD, and what the transfer loses (or gains) in value on the way, fees included. Between USDC at a dollar
  // each; else as the selected bridge prices them; for a route its bridge didn't price (Across), at the prices another
  // bridge quoted for the same tokens; else at the token lists' prices, which can be hours old: too rough for a change.
  const worth = (value: bigint, token: Token) => {
    const price = isUsdc(token) ? 1 : token.priceUsd
    return price === undefined ? undefined : (Number(value) / 10 ** token.decimals) * price
  }
  type Worth = { in?: number; out?: number; change?: number }
  // Under a cent, prices and pools round too much for a change to mean anything (dust can "gain" 500%).
  const meaningful = (w: Worth): Worth => (w.in! >= 0.01 && w.out! >= 0.01 ? w : { ...w, change: undefined })
  const usdValue = $derived(meaningful(priced()))
  function priced(): Worth {
    const [sent, out] = [amount ? worth(amount, fromToken) : undefined, selected ? worth(selected.out, toToken) : undefined]
    if (isUsdc(fromToken) && isUsdc(toToken)) return { in: sent, out, change: sent && out ? out / sent - 1 : undefined }
    const q = selectedQuote
    if (q?.usdIn && q.usdOut) return { in: q.usdIn, out: q.usdOut, change: q.usdOut / q.usdIn - 1 }
    const other = quotes.find((o) => o.usdIn && o.usdOut)
    if (other && selected) {
      const scaled = (other.usdOut! * Number(selected.out)) / Number(other.amountOut)
      return { in: other.usdIn, out: scaled, change: scaled / other.usdIn! - 1 }
    }
    return { in: sent, out }
  }
  const percent = (change: number) => `${change < 0 ? '−' : '+'}${Math.abs(change * 100).toFixed(2)}%`

  const problem = $derived.by(() => {
    if (blocked) return blocked.title
    if (!amount) return 'Enter an amount'
    // Without a route the balance doesn't matter yet.
    if (!selected) {
      if (quoting) return 'Finding routes…'
      if (cctp && !fees) return feesError ? 'Fees unavailable' : 'Loading fees…'
      if (cctp && mustForward && !useForward) return `Circle can't deliver to ${destination.name} from here`
      if (cctp && fees && maxFee >= amount) return 'Amount is below the fee'
      return 'Route not available'
    }
    if (balance !== undefined && amount > balance) return `Not enough ${fromToken.symbol}`
    if (!recipient) return recipientValue ? 'Enter a valid recipient' : `Add a ${destination.name} address`
  })
  // The button then opens the address field.
  const askRecipient = $derived(!!selected && !recipientValue && problem === `Add a ${destination.name} address`)
  // More on why, under the button.
  const hint = $derived.by(() => {
    if (blocked) return blocked.detail
    if (problem !== 'Route not available') return
    const pair = `${fromToken.symbol} on ${source.name} to ${toToken.symbol} on ${destination.name}`
    return `No bridge has a route from ${pair} right now${quoteErrors.length ? ` (${quoteErrors[0]})` : ''}. Try another token or amount.`
  })

  // ---- Bridge -------------------------------------------------------------------------------------

  function setAmount(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.replace(',', '.')
    if (/^\d*\.?\d*$/.test(value) && (value.split('.')[1]?.length ?? 0) <= fromToken.decimals) amountText = value
    else event.currentTarget.value = amountText
  }

  async function submit() {
    if (!sender) return connectFor(source)
    if (askRecipient) return editRecipient()
    if (!(await acceptTerms())) return
    chosen = true // sending with the suggested route picks it too
    return selected?.id === 'cctp' ? submitCctp() : submitRoute(selected!)
  }

  async function submitCctp() {
    const [from, to, value] = [source as CctpChain, destination as CctpChain, amount!]
    error = ''
    try {
      // CCTP mints to a Solana wallet's USDC account, not the wallet itself.
      const mintRecipient = to.kind === 'solana' ? await solanaMintRecipient(recipient!, to) : (recipient as Hex)
      if (to.kind === 'solana' && !needsSetup && !(await accountExists(await solanaAccount(to, recipient!)))) {
        needsSetup = true
        error = 'The recipient has no USDC account on Solana yet. Circle can create it, which raises the fee: check it and send again.'
        return
      }
      const burn = { amount: value, destinationDomain: to.domain, mintRecipient, burnToken: from.usdc as Hex, maxFee, minFinalityThreshold: useFast ? 1000 : 2000 }
      const hookData = useForward ? forwardHook(to.kind === 'solana' && needsSetup ? solanaKeyHex(recipient!) : undefined) : undefined
      const sides = { from: from.id, to: to.id, sourceDomain: from.domain, destinationDomain: to.domain, amount: amountString(value, 6), createdAt: Date.now() }
      if (from.kind === 'solana') {
        const sign = (tx: Uint8Array) => signSolanaTransaction(tx, app.config!.network === 'testnet')
        const signature = await burnOnSolana(from, sender!, { ...burn, hookData }, sign, (step) => (busy = step))
        const item = addRecent({ txHash: signature, ...sides, status: 'pending' })
        amountText = ''
        balanceAttempt++
        navigate('bridge', signature)
        void refresh(item)
        return
      }
      const hash = await burnOnEvm(from, burn, hookData, (step) => (busy = step))
      const item = addRecent({ txHash: hash, ...sides, status: 'confirming' })
      amountText = ''
      navigate('bridge', hash)
      follow(from, hash, item)
    } catch (err) {
      error = walletError(err) ?? ''
    } finally {
      busy = ''
    }
  }

  // Waits for the source chain to take the transaction, then for the transfer to land.
  function follow(from: Chain, hash: string, item: Recent) {
    const confirmed = from.kind === 'cosmos' ? cosmosConfirmed(from, hash) : waitForReceipt(hash as Hex, from.kind === 'evm' ? from : undefined)
    confirmed.then(
      (ok) => {
        if (ok) {
          if (item.route) sentRecent(item)
          void refresh(item)
        } else failRecent(item, `The transaction failed on ${from.name}.`)
        balanceAttempt++
      },
      () => {},
    )
  }

  // Through another bridge: a fresh quote with the real addresses, then its transactions.
  async function submitRoute(option: RouteOption) {
    const [from, to, value, tokenIn, tokenOut] = [source, destination, amount!, fromToken, toToken]
    const side = quotes.find((q) => routeKey(q) === option.id)?.side
    const [fromSide, toSide] = [sideOf(from, side), sideOf(to, side)]
    error = ''
    try {
      const progress = (label: string) => (busy = label)
      const addresses = fromSide ? { ...known, [fromSide.id]: await cosmosSigner(fromSide, progress) } : known
      busy = 'Getting a fresh quote…'
      const body: QuoteBody = {
        from: from.id,
        to: to.id,
        fromToken: tokenIn.address,
        toToken: tokenOut.address,
        amount: String(value),
        sender,
        recipient,
        addresses,
        slippageBps: slippage,
        providers: [option.provider],
      }
      const pick = ({ quotes }: { quotes: Quote[] }) => quotes.find((q) => routeKey(q) === option.id)
      let fresh = pick(await getQuotes(body))
      if (fresh?.needs?.length) {
        body.addresses = { ...body.addresses, ...(await addressesFor(fresh.needs, progress)) }
        busy = 'Getting a fresh quote…'
        fresh = pick(await getQuotes(body))
      }
      if (!fresh?.steps.length) throw new Error(`${option.name} can't do this transfer right now, pick another route.`)
      // Half a percent of slack; beyond that, show the new price first.
      if (BigInt(fresh.amountOut) * 1000n < option.out * 995n) {
        quotes = quotes.map((q) => (routeKey(q) === option.id ? fresh! : q))
        throw new Error('The price moved: check the new amount and send again.')
      }
      const hash = await runSteps(from, fresh.steps, progress, app.config!.network === 'testnet')
      const item = addRouteRecent({ hash, from, to, fromSide, toSide, amount: value, fromToken: tokenIn, toToken: tokenOut, quote: fresh })
      amountText = ''
      navigate('bridge', hash)
      if (item.status === 'pending') {
        balanceAttempt++
        void refresh(item)
      } else follow(fromSide ?? from, hash, item)
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
  const bridgeCount = $derived((app.config?.providers.length ?? 0) + 1)
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

<!-- An amount in USD, under it: a placeholder before there's an amount, a shimmer while the bridges price it. -->
{#snippet usdLine(dollars: number | undefined, change?: number)}
  <span class="text-muted-foreground flex h-4 items-center gap-1 text-xs tabular-nums">
    {#if dollars !== undefined}
      {#key dollars}<span class="settle">{usd(dollars)}</span>{/key}
      {#if change !== undefined && Math.abs(change) >= 0.0001}
        <span
          class={change <= -0.05 ? 'text-destructive' : change <= -0.01 ? 'text-warning' : 'text-muted-foreground/70'}
          title="Value lost (or gained) on the way, fees and price impact included">({percent(change)})</span
        >
      {/if}
    {:else if amount && quoting}
      <span class="skeleton h-3 w-12 rounded"></span>
    {:else if !amount}
      <span class="text-muted-foreground/40">$0.00</span>
    {/if}
  </span>
{/snippet}

{#snippet row(label: string, value: string, title?: string)}
  <div class="flex items-center justify-between gap-3">
    <span class="text-muted-foreground">{label}</span>
    <span class="truncate text-right tabular-nums" {title}>{value}</span>
  </div>
{/snippet}

{#if opened}
  <button class="text-muted-foreground hover:text-foreground -ml-0.5 inline-flex items-center gap-1 text-xs transition-colors" onclick={() => navigate('bridge')}>
    <ArrowLeftIcon class="size-3.5" /> New transfer
  </button>
  <h1 class="mt-3 mb-4 font-serif text-2xl leading-tight tracking-tight">{heading}</h1>
  {#if 'route' in opened && opened.route}
    <RouteCard item={{ ...opened, route: opened.route }} />
  {:else}
    <TransferCard item={opened} onupdate={(transfer) => ('createdAt' in opened ? setTransfer(opened, transfer) : updateHistory(transfer))} />
  {/if}
{:else}
  <div class="flex items-baseline justify-between gap-3">
    <h1 class="font-serif text-2xl leading-tight tracking-tight">Bridge</h1>
    <p class="text-muted-foreground text-xs tabular-nums">{app.chains.length} networks · {bridgeCount} bridges</p>
  </div>

  {#if suggestions.length}
    <div class="mt-4" role="group" aria-label="Suggested routes to Injective" out:slide={{ duration: ms(180) }}>
      <p class="text-muted-foreground mb-1.5 text-xs">Suggested routes to Injective</p>
      <div class="grid grid-cols-2 gap-1.5">
        {#each suggestions as s (`${s.from.id}:${s.tokenIn.symbol}`)}
          <button
            type="button"
            aria-pressed={s.on}
            disabled={!!busy}
            class={[
              'bg-card flex min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-[background-color,border-color,scale] active:scale-[0.98]',
              s.on ? 'border-foreground/30' : 'hover:bg-muted/50',
            ]}
            onclick={() => suggest(s)}
          >
            <span class="flex shrink-0 -space-x-1.5">
              <ChainIcon chain={s.from} class="ring-card size-5 text-[9px] ring-2" />
              <ChainIcon chain={s.to} class="ring-card size-5 text-[9px] ring-2" />
            </span>
            <span class="min-w-0">
              <span class="block truncate text-xs font-medium">From {s.from.name}</span>
              <span class="text-muted-foreground block truncate text-[11px]">{s.tokenIn.symbol === s.tokenOut.symbol ? s.tokenIn.symbol : `${s.tokenIn.symbol} → ${s.tokenOut.symbol}`}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <form
    class="mt-4"
    onsubmit={(event) => {
      event.preventDefault()
      void submit()
    }}
  >
    <div class="bg-card rounded-lg border p-3.5 shadow-xs">
      <span class="text-muted-foreground text-xs">From</span>
      <div class="mt-1.5 flex items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <input
            class="placeholder:text-muted-foreground/40 w-full bg-transparent text-[26px] leading-none font-medium tracking-tight tabular-nums outline-none"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0"
            aria-label="Amount"
            value={amountText}
            oninput={setAmount}
            disabled={!!busy}
          />
          {@render usdLine(usdValue.in)}
        </div>
        <AssetSelect
          chain={source}
          token={fromToken}
          chains={app.chains}
          other={destination}
          side="from"
          title="Pick what to send"
          disabled={!!busy}
          onchange={(chain, token) => choose('from', chain, token)}
        />
      </div>
      {#if sender && source.send}
        <div class="text-muted-foreground mt-2 flex h-4 items-center gap-1.5 text-xs" in:fade={{ duration: ms(150) }}>
          Balance
          {#if balance !== undefined}
            <span class="settle tabular-nums">{formatToken(balance, fromToken.decimals)}</span>
          {:else if balanceFailed}
            <button type="button" class="text-destructive hover:underline" onclick={() => balanceAttempt++}>Couldn't load, retry</button>
          {:else}
            <span class="skeleton h-3 w-12 rounded"></span>
          {/if}
          <!-- Not for the gas token: the transaction itself needs some of it (Hyperliquid's transfers need no gas). -->
          {#if balance && (!isNative(source, fromToken.address) || source.kind === 'hypercore')}
            <button
              type="button"
              class="text-foreground/80 hover:text-foreground font-medium transition-[color,scale] active:scale-95"
              disabled={!!busy}
              onclick={() => (amountText = amountString(balance!, fromToken.decimals))}>Max</button
            >
          {/if}
        </div>
      {/if}
    </div>

    <div class="relative z-10 flex h-1 items-center justify-center">
      <button
        type="button"
        class="bg-card hover:bg-muted flex size-8 items-center justify-center rounded-md border shadow-xs transition-[background-color,scale] active:scale-90"
        aria-label="Swap direction"
        disabled={!!busy}
        onclick={flip}
      >
        <ArrowDownUpIcon class="size-3.5 transition-transform duration-300 ease-out" style="rotate: {turns * 180}deg" />
      </button>
    </div>

    <div class="bg-card rounded-lg border p-3.5 shadow-xs">
      <span class="text-muted-foreground text-xs">To</span>
      <div class="mt-1.5 flex items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          {#key selected?.out}
            <span class={['settle block truncate text-[26px] leading-none font-medium tracking-tight tabular-nums', !selected && 'text-muted-foreground/40']}>
              {selected ? formatToken(selected.out, toToken.decimals) : '0'}
            </span>
          {/key}
          {@render usdLine(usdValue.out, usdValue.change)}
        </div>
        <AssetSelect
          chain={destination}
          token={toToken}
          chains={app.chains}
          other={source}
          side="to"
          title="Pick what to receive"
          disabled={!!busy}
          onchange={(chain, token) => choose('to', chain, token)}
        />
      </div>
      <div class="text-muted-foreground mt-2 flex h-4 items-center gap-1.5 text-xs">
        {#if editingRecipient}
          <input
            bind:this={recipientInput}
            class={['min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans', recipientText.trim() && !recipient ? 'text-destructive' : 'text-foreground']}
            placeholder="Recipient {addressHint(destination)} address"
            aria-label="Recipient address"
            autocomplete="off"
            spellcheck="false"
            disabled={!!busy}
            bind:value={recipientText}
          />
          <button type="button" class="hover:text-foreground transition-colors" aria-label="Send to my wallet" onclick={resetRecipient}>
            <XIcon class="size-3.5" />
          </button>
        {:else}
          To
          {#if recipientValue}
            <span class="text-foreground/80 font-mono">{short(recipientValue)}</span>
          {:else if walletKind(destination) && walletKind(destination) === walletKind(source) && !sender}
            <span class="text-foreground/80">your wallet</span>
          {:else}
            <button type="button" class="text-foreground/80 hover:text-foreground underline-offset-2 hover:underline" disabled={!!busy} onclick={editRecipient}>
              add a {destination.name} address
            </button>
          {/if}
          <button type="button" class="hover:text-foreground p-0.5 transition-colors" aria-label="Change recipient" disabled={!!busy} onclick={editRecipient}>
            <PencilIcon class="size-3" />
          </button>
          {#if !recipientValue && walletKind(destination) && (sender || walletKind(destination) !== walletKind(source))}
            <!-- The source wallet can't receive here (EVM ↔ Solana ↔ Cosmos): connect one that can, or type an address. -->
            <button type="button" class="text-foreground/80 hover:text-foreground ml-auto truncate font-medium transition-colors" disabled={!!busy} onclick={() => connectFor(destination)}>
              {connectLabel(destination)}
            </button>
          {/if}
        {/if}
      </div>
    </div>

    {#if options.length}
      <div class="mt-3"><RouteList {options} selected={selected!.id} token={toToken} disabled={!!busy} onselect={(id) => (picked = id)} /></div>
    {:else if amount && quoting}
      <!-- Placeholder for the route the bridges are being asked for. -->
      <div class="bg-card mt-3 flex items-center gap-3 rounded-md border px-3 py-2" aria-label="Finding routes" in:fade={{ duration: ms(120) }}>
        <span class="skeleton size-6 shrink-0 rounded-full"></span>
        <span class="flex flex-1 flex-col gap-1.5"><span class="skeleton h-3 w-20 rounded"></span><span class="skeleton h-2.5 w-36 rounded"></span></span>
        <span class="skeleton h-3.5 w-16 rounded"></span>
      </div>
    {/if}

    {#if cctp && (!selected || selected.id === 'cctp') && !blocked}
      <div class="mt-3 flex flex-col gap-2 px-1 text-xs" transition:slide={{ duration: ms(150) }}>
        {#if canFast}
          {@render choice('Speed', [
            { title: 'Fast', hint: '< 1 min', on: fast, pick: () => (fast = true) },
            { title: 'Standard', hint: fees!.standardTime!, on: !fast, pick: () => (fast = false) },
          ])}
        {:else if fees}
          <!-- Chains with instant finality (Injective, Avalanche, Polygon…) have no faster option: standard already takes seconds. -->
          {@render row('Speed', fees.standardTime ?? 'Under a minute')}
        {/if}
        {#if canForward && !mustForward}
          {@render choice('Delivery', [
            { title: 'Automatic', on: forward, pick: () => (forward = true) },
            { title: 'Claim myself', on: !forward, pick: () => (forward = false) },
          ])}
        {:else if fees}
          {@render row('Delivery', selfClaim ? `Claim on ${destination.name}` : needsSetup ? 'Automatic, opens a USDC account' : 'Automatic')}
        {/if}
        {@render row('Slippage', 'None', 'CCTP burns and mints the exact amount: only the fee comes out of it')}
        {#if source.kind === 'solana'}
          {@render row('Network fee', '≈ 0.003 SOL', 'Mostly rent for the account the burn writes its message to')}
        {/if}
        <div class="flex items-center justify-between gap-3">
          <span class="text-muted-foreground">Fee</span>
          {#if feesError}
            <button type="button" class="text-destructive hover:underline" onclick={() => feesAttempt++}>Couldn't load, retry</button>
          {:else if !fees}
            <span class="skeleton h-3 w-14 rounded"></span>
          {:else if useFast && !amount}
            <span class="tabular-nums">
              {(fees.fastBps! / 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%{#if forwardFee}&nbsp;+ {formatUsdc(forwardFee)} USDC{/if}
            </span>
          {:else}
            <span class="tabular-nums">{fee ? `${formatUsdc(fee)} USDC` : 'Free'}</span>
          {/if}
        </div>
      </div>
    {:else if !blocked && amount && (selectedQuote || !cctp)}
      <!-- The other bridges' routes: slippage can be set while they're found too, or when none has one. -->
      <div class="mt-3 flex flex-col gap-2 px-1 text-xs" transition:slide={{ duration: ms(150) }}>
        {@render choice(
          'Max slippage',
          SLIPPAGES.map((bps) => ({ title: `${bps / 100}%`, on: slippage === bps, pick: () => setSlippage(bps) })),
        )}
        {#if selected && selectedQuote}
          {@render row('Minimum received', `${formatToken(selected.min, toToken.decimals)} ${toToken.symbol}`)}
          {#if cost(selectedQuote)}{@render row('Network fee', cost(selectedQuote)!, `Paid on ${source.name} on top of the amount`)}{/if}
          {#if needs.length}
            {@render row('Also needs', `Your ${needs.join(', ')} address`, 'The route passes through it: your wallet gives the address, in case the transfer stops there')}
          {/if}
          {@render row('Delivery', `Automatic, by ${selected.name}`)}
        {/if}
      </div>
    {/if}

    {#if toInjective && !blocked && ((selected ? selected.id !== 'cctp' : !cctp) || app.config!.autoRedeem)}
      <p class="bg-muted/60 mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed">
        <FuelIcon class="text-muted-foreground mt-px size-3.5 shrink-0" />
        <span>
          {#if !selected || selected.id === 'cctp'}No INJ needed: we deliver your USDC on Injective and pay the gas.{:else}No INJ needed: {selected.name} delivers straight to your Injective wallet.{/if}
          {#if app.config!.swap}You can also swap USDC to INJ there, gas free.{/if}
        </span>
      </p>
    {/if}

    <Button type="submit" class="mt-4 h-11 w-full text-[13px] transition-[background-color,scale] active:scale-[0.99]" disabled={!!busy || !!blocked || (!!sender && !!problem && !askRecipient)}>
      {#if busy}<Spinner class="size-4" />{busy}{:else if blocked}{blocked.title}{:else if !sender}{connectLabel(source)}{:else}{problem ?? `Bridge to ${destination.name}`}{/if}
    </Button>
    {#if hint && !busy}
      <p class="text-muted-foreground mt-2.5 flex items-start gap-1.5 px-1 text-xs leading-relaxed" transition:slide={{ duration: ms(150) }}>
        <InfoIcon class="mt-px size-3.5 shrink-0" />{hint}
      </p>
    {/if}
    {#if error}
      <p class="text-destructive mt-2.5 text-center text-xs" transition:slide={{ duration: ms(150) }}>{error}</p>
    {/if}
  </form>
{/if}
