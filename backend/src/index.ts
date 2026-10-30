import { Elysia, t } from 'elysia'
import { formatEther } from 'viem'
import { autoRedeem, balance, fees, history, HttpError, lookupAddress, lookupTx, redeem } from './cctp'
import { chains, corsOrigins, host, injective, MESSAGE_TRANSMITTER, network, port, redeemsPerMinute, relayer, requestsPerMinute, TOKEN_MESSENGER, trustProxy } from './config'
import { indexedBlocks, queuedTxs, startIndexer } from './indexer'

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
}
const domainId = t.Integer({ minimum: 0 })

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
    const isRedeem = request.method === 'POST' && new URL(request.url).pathname === '/redeem'
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
  }))
  .get('/chains', () => chainInfo)
  .get('/fees/:from/:to', ({ params }) => fees(params.from, params.to), {
    params: t.Object({ from: domainId, to: domainId }),
  })
  .get('/balance/:domain/:address', ({ params }) => balance(params.domain, params.address), {
    params: t.Object({ domain: domainId, address: t.String() }),
  })
  .get('/address/:address', ({ params }) => lookupAddress(params.address))
  .get('/history/:address', ({ params, query }) => history(params.address, query.offset), {
    query: t.Object({ offset: t.Optional(t.Integer({ minimum: 0 })) }),
  })
  .get('/tx/:hash', ({ params, query }) => lookupTx(params.hash, query.domain), {
    query: t.Object({ domain: t.Optional(domainId) }),
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
console.log(`Injective CCTP bridge API (${network}) on http://localhost:${app.server?.port}`)
console.log(`Relayer: ${relayer?.account.address ?? 'disabled (set RELAYER_PRIVATE_KEY)'} · indexing ${chains.length} chains`)
