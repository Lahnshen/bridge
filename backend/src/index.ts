import { Elysia, t } from 'elysia'
import { formatEther } from 'viem'
import { autoRedeem, balance, fees, history, HttpError, lookupAddress, lookupTx, redeem } from './cctp'
import { chains, corsOrigins, host, injective, MESSAGE_TRANSMITTER, network, port, redeemsPerMinute, relayer, requestsPerMinute, solana, TOKEN_MESSENGER, trustProxy } from './config'
import { allChains, canSend, chainById, ready, resolveChain, type ChainInfo } from './chains'
import { broadcast, prepare, txStatus } from './cosmos'
import { historyFrom, indexedBlocks, queuedTxs, startIndexer } from './indexer'
import { SolanaRpcError, solanaRpc } from './solana'
import { resumeSwaps, swap, swapQuote, swapsEnabled } from './swap'
import { providerList, providersOn, quoteRequest, quotes, status as routeStatus } from './providers'
import { ProviderError, type ProviderId } from './providers/shared'
import { tokenBalance, tokens, warmTokens } from './tokens'

// Fixed-window counter per client IP.
function rateLimit(max: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  setInterval(() => {
    const now = Date.now()
    for (const [ip, hit] of hits) if (hit.resetAt <= now) hits.delete(ip)
  }, windowMs).unref()
  return (ip: string) => {
    const now = Date.now()
    let hit = hits.get(ip)
    if (!hit || hit.resetAt <= now) hits.set(ip, (hit = { count: 0, resetAt: now + windowMs }))
    hit.count++
    return { ok: hit.count <= max, limit: max, remaining: Math.max(0, max - hit.count), reset: Math.ceil((hit.resetAt - now) / 1000) }
  }
}
const limits = { requests: rateLimit(requestsPerMinute), redeems: rateLimit(redeemsPerMinute) }

// What a bridge UI needs. rpc is each chain's public RPC, for wallets that have to add the chain; the RPC_* overrides stay private.
const chainInfo = {
  network,
  autoRedeem: !!relayer,
  swap: swapsEnabled, // USDC → INJ on Injective, see /swap
  providers: providerList(), // bridges quoted besides CCTP, see /quotes
  tokenMessenger: TOKEN_MESSENGER,
  messageTransmitter: MESSAGE_TRANSMITTER,
  chains: chains.map(({ domain, name, chain, usdc }) => ({
    domain,
    name,
    chainId: chain.id,
    usdc,
    rpc: chain.rpcUrls.default.http[0],
    explorer: chain.blockExplorers?.default.url,
    nativeCurrency: chain.nativeCurrency,
  })),
  solana: {
    domain: solana.domain,
    name: solana.name,
    usdc: solana.usdc,
    rpc: solana.publicRpc,
    explorer: solana.explorer,
    tokenMessenger: solana.tokenMessenger,
    messageTransmitter: solana.messageTransmitter,
  },
}
const domainId = t.Integer({ minimum: 0 })
const chainRef = t.Union([t.String({ maxLength: 64 }), domainId]) // a chain id, or a CCTP domain

// Every chain the bridges reach, for the chain picker. send: the app can send from it (EVM, Solana, and Cosmos chains
// with a REST endpoint); via: the bridges that reach it. rpc and rest are public, for wallets that have to add the chain.
// A chain's Cosmos side (Injective's) comes inside it, as cosmos: the app signs and confirms that side's transactions there.
let networks: { from: ChainInfo[]; list: unknown[] } | undefined
function networkList() {
  const chains = allChains()
  if (networks?.from === chains) return networks.list
  const list = chains.flatMap((c) => {
    if (c.sideOf) return []
    const side = c.cosmosSide ? chainById(c.cosmosSide) : undefined
    if (!side) return [networkEntry(c)]
    const via = [...new Set([...providersOn(c), ...providersOn(side)])]
    return [{ ...networkEntry(c), via, cosmos: { ...networkEntry(side), name: c.name, logo: c.logo } }]
  })
  networks = { from: chains, list }
  return list
}
function networkEntry(c: ChainInfo) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    logo: c.logo,
    domain: c.domain,
    chainId: c.chainId,
    cosmosId: c.cosmosId,
    bech32: c.bech32,
    slip44: c.slip44,
    rpc: c.rpc,
    rest: c.rest,
    explorer: c.explorer,
    native: c.native,
    gas: c.gas,
    usdc: c.usdc,
    via: providersOn(c),
    send:
      canSend(c) &&
      (c.kind !== 'cosmos' || (!!c.rest && !!c.gas && providersOn(c).includes('skip'))) &&
      (c.kind !== 'hypercore' || providersOn(c).includes('relay')),
  }
}
let chainsBody: { list: unknown[]; text: string; gzip: Uint8Array<ArrayBuffer> } | undefined
function chainsJson() {
  const list = networkList()
  if (chainsBody?.list !== list) {
    const text = JSON.stringify({ ...chainInfo, networks: list })
    chainsBody = { list, text, gzip: Bun.gzipSync(text) as Uint8Array<ArrayBuffer> }
  }
  return chainsBody
}
const knownChain = (id: string | number) => {
  const chain = resolveChain(id)
  if (!chain) throw new HttpError(404, 'Unknown chain.')
  return chain
}
const SOLANA_METHODS = new Set(['getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getAccountInfo'])

const app = new Elysia()
  .onRequest(({ request, server, set, status }) => {
    const origin = request.headers.get('origin')
    set.headers['access-control-allow-origin'] = corsOrigins.includes('*') ? '*' : origin && corsOrigins.includes(origin) ? origin : corsOrigins[0]!
    set.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
    set.headers['access-control-allow-headers'] = 'content-type'
    set.headers['vary'] = 'origin'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: set.headers as Record<string, string> })

    // Behind a proxy, the last X-Forwarded-For entry is the one the proxy added (earlier ones can be forged by the client).
    const ip = (trustProxy && request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()) || server?.requestIP(request)?.address || 'unknown'
    const isRedeem = request.method === 'POST' && ['/redeem', '/swap'].includes(new URL(request.url).pathname) // these send transactions
    const hit = (isRedeem ? limits.redeems : limits.requests)(ip)
    set.headers['ratelimit-limit'] = String(hit.limit)
    set.headers['ratelimit-remaining'] = String(hit.remaining)
    set.headers['ratelimit-reset'] = String(hit.reset)
    if (!hit.ok) {
      set.headers['retry-after'] = String(hit.reset)
      return status(429, { error: `Too many requests, try again in ${hit.reset}s.` })
    }
  })
  .onError(({ code, error, status }) => {
    if (error instanceof HttpError) return status(error.status, { error: error.message })
    if (error instanceof ProviderError) return status(502, { error: error.message }) // a bridge provider's own error
    if (code === 'VALIDATION' || code === 'PARSE') return status(400, { error: 'Invalid request.' })
    if (code === 'NOT_FOUND') return status(404, { error: 'Not found.' })
    console.error(error)
    return status(500, { error: 'Something went wrong, please try again.' })
  })
  .get('/health', async () => ({
    network,
    relayer: relayer?.account.address ?? null,
    balance: relayer ? await injective.client.getBalance({ address: relayer.account.address }).then(formatEther, () => null) : null,
    queued: queuedTxs().length,
    indexedBlocks: indexedBlocks(),
    historyFromBlock: historyFrom(), // how far back Injective's history is indexed so far
  }))
  // Waits (a few seconds at most) for the bridges' chain lists after a restart. Gzipped: the list is ~100 kB of JSON.
  .get('/chains', async ({ request, set }) => {
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 8000))])
    const json = chainsJson()
    if (!request.headers.get('accept-encoding')?.includes('gzip')) return new Response(json.text, { headers: { ...(set.headers as Record<string, string>), 'content-type': 'application/json' } })
    return new Response(json.gzip, { headers: { ...(set.headers as Record<string, string>), 'content-type': 'application/json', 'content-encoding': 'gzip' } })
  })
  .get('/fees/:from/:to', ({ params, query }) => fees(params.from, params.to, query.recipientSetup === 'true'), {
    params: t.Object({ from: domainId, to: domainId }),
    query: t.Object({ recipientSetup: t.Optional(t.String()) }),
  })
  // USDC by default; with ?token= any token, as { raw } base units. async on purpose: Elysia only awaits handlers it can
  // tell are async (from their source), and a rejected promise it didn't await skips onError and crashes the request.
  .get('/balance/:chain/:address', async ({ params, query }) => {
    if (query.token) return tokenBalance(params.chain, params.address, query.token)
    const domain = knownChain(params.chain).domain
    if (domain === undefined) throw new HttpError(400, 'Name a token.')
    return balance(domain, params.address)
  }, {
    params: t.Object({ chain: t.String({ maxLength: 64 }), address: t.String({ maxLength: 120 }) }),
    query: t.Object({ token: t.Optional(t.String({ maxLength: 200 })) }),
  })
  .get('/tokens/:chain', ({ params, query }) => tokens(params.chain, query.q), {
    params: t.Object({ chain: t.String({ maxLength: 64 }) }),
    query: t.Object({ q: t.Optional(t.String({ maxLength: 200 })) }),
  })
  // Routes from the other bridges, best first. CCTP itself is quoted by /fees.
  .post('/quotes', ({ body }) => quotes(quoteRequest(body), body.providers as ProviderId[] | undefined), {
    body: t.Object({
      from: chainRef,
      to: chainRef,
      fromToken: t.String({ maxLength: 200 }),
      toToken: t.String({ maxLength: 200 }),
      amount: t.String({ maxLength: 40 }),
      sender: t.Optional(t.String({ maxLength: 120 })),
      recipient: t.Optional(t.String({ maxLength: 120 })),
      addresses: t.Optional(t.Record(t.String({ maxLength: 64 }), t.String({ maxLength: 120 }))),
      slippageBps: t.Optional(t.Integer()),
      providers: t.Optional(t.Array(t.String(), { maxItems: 10 })),
    }),
  })
  .post('/quotes/status', ({ body }) => routeStatus(body.provider, body), {
    body: t.Object({ provider: t.String(), txHash: t.String({ maxLength: 120 }), from: chainRef, to: chainRef, track: t.Record(t.String(), t.String()) }),
  })
  // Sending from a Cosmos chain: the transaction to sign (see ./cosmos.ts), then the signed one to broadcast.
  .post('/cosmos/prepare', async ({ body }) => prepare({ ...body, chain: knownChain(body.chain) }), {
    body: t.Object({
      chain: t.String({ maxLength: 64 }),
      signer: t.String({ maxLength: 120 }),
      pubKey: t.String({ maxLength: 100 }),
      algo: t.Optional(t.String({ maxLength: 20 })),
      messages: t.Array(t.Object({ typeUrl: t.String({ maxLength: 200 }), value: t.String({ maxLength: 100_000 }) }), { minItems: 1, maxItems: 10 }),
      memo: t.Optional(t.String({ maxLength: 512 })),
    }),
  })
  .post('/cosmos/broadcast', async ({ body }) => broadcast({ ...body, chain: knownChain(body.chain) }), {
    body: t.Object({
      chain: t.String({ maxLength: 64 }),
      bodyBytes: t.String({ maxLength: 200_000 }),
      authInfoBytes: t.String({ maxLength: 10_000 }),
      signature: t.String({ maxLength: 200 }),
    }),
  })
  .get('/cosmos/tx/:chain/:hash', async ({ params }) => txStatus(knownChain(params.chain), params.hash), {
    params: t.Object({ chain: t.String({ maxLength: 64 }), hash: t.String({ pattern: '^[0-9A-Fa-f]{64}$' }) }),
  })
  .get('/address/:address', ({ params }) => lookupAddress(params.address))
  .get('/history/:address', ({ params, query }) => history(params.address, query.offset), {
    query: t.Object({ offset: t.Optional(t.Integer({ minimum: 0 })) }),
  })
  .get('/tx/:hash', ({ params, query }) => lookupTx(params.hash, query.domain), {
    query: t.Object({ domain: t.Optional(domainId) }),
  })
  // The few Solana RPC calls the UI makes to send a transfer from Solana, through this server's RPC.
  .post(
    '/solana',
    async ({ body }) => {
      if (!SOLANA_METHODS.has(body.method)) throw new HttpError(400, 'Unsupported method.')
      const result = await solanaRpc(body.method, body.params).catch((err: Error) => {
        throw new HttpError(err instanceof SolanaRpcError ? 400 : 502, err instanceof SolanaRpcError ? err.message : `Could not reach ${solana.name}, try again.`)
      })
      return { result }
    },
    { body: t.Object({ method: t.String(), params: t.Array(t.Any(), { maxItems: 4 }) }) },
  )
  .get('/swap/quote', ({ query }) => swapQuote(query.amount), { query: t.Object({ amount: t.String() }) })
  .post('/swap', async ({ body, status }) => {
    const result = await swap(body)
    return result.status === 'pending' ? status(202, result) : result
  }, {
    body: t.Object({
      from: t.String(),
      value: t.String(),
      validAfter: t.Integer({ minimum: 0 }),
      validBefore: t.Integer({ minimum: 0 }),
      nonce: t.String(),
      signature: t.String(),
      minInj: t.String(),
    }),
  })
  .post(
    '/redeem',
    async ({ body, status }) => {
      const result = await redeem(body.txHash, body.domain)
      return result.queued ? status(202, { transfers: result.transfers }) : { transfers: result.transfers }
    },
    { body: t.Object({ txHash: t.String(), domain: t.Optional(domainId) }) },
  )
  .listen({ port, hostname: host })

startIndexer()
void autoRedeem()
void resumeSwaps()
// The token lists most people open, loaded ahead: the CCTP chains', then the main Cosmos chains'.
void ready.then(() => warmTokens([...allChains().filter((c) => c.domain !== undefined), ...['osmosis', 'cosmoshub', 'noble'].flatMap((id) => chainById(id) ?? [])]))
console.log(`Lahn Bridge API (${network}) on http://localhost:${app.server?.port}`)
console.log(`Relayer: ${relayer?.account.address ?? 'disabled (set RELAYER_PRIVATE_KEY)'} · indexing ${chains.length} chains`)
