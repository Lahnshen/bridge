import { Database } from 'bun:sqlite'
import { BaseError, hexToBigInt, hexToNumber, parseAbiItem, parseEventLogs, size, slice, type Hex, type TransactionReceipt } from 'viem'
import { chains, dbPath, historyFromBlock, INJECTIVE_DOMAIN, lookbackHours, MESSAGE_TRANSMITTER, pollMs, TOKEN_MESSENGER, type EvmChain } from './config'

// Watches every EVM chain for burns to Injective, and Injective for burns leaving it and mints arriving, so transfers can be
// looked up by wallet address. Injective sees both sides of every transfer, so it's indexed all the way back for full history.

const DepositForBurn = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
)
const MessageReceived = parseAbiItem(
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
)
type Burn = { transactionHash: Hex; logIndex: number; blockNumber: bigint; args: { depositor: Hex; mintRecipient: Hex; destinationDomain: number } }
type Mint = { transactionHash: Hex; blockNumber: bigint; args: { sourceDomain: number; nonce: Hex; messageBody: Hex } }

const db = new Database(dbPath, { create: true })
db.run('PRAGMA journal_mode = WAL')
db.run(`CREATE TABLE IF NOT EXISTS burns (
  domain INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, tx_hash, log_index)
)`)
db.run('CREATE INDEX IF NOT EXISTS burns_tx ON burns (tx_hash)')
db.run('CREATE INDEX IF NOT EXISTS burns_sender ON burns (sender)')
db.run('CREATE INDEX IF NOT EXISTS burns_recipient ON burns (recipient)')
db.run('CREATE TABLE IF NOT EXISTS cursors (domain INTEGER PRIMARY KEY, block INTEGER NOT NULL)')
db.run('CREATE TABLE IF NOT EXISTS redeems (nonce TEXT PRIMARY KEY, tx_hash TEXT NOT NULL)')
// Burn txs to mint automatically once Circle attests them (see autoRedeem in cctp.ts).
db.run('CREATE TABLE IF NOT EXISTS queue (domain INTEGER NOT NULL, tx_hash TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (domain, tx_hash))')
// Fully minted txs keep their transfers here, so history and lookups don't ask Circle again.
db.run('CREATE TABLE IF NOT EXISTS done (domain INTEGER NOT NULL, tx_hash TEXT NOT NULL, transfers TEXT NOT NULL, PRIMARY KEY (domain, tx_hash))')
// Added after the first release: the burn's block and timestamp (fillTimes fills them in for older rows).
const columns = db.query<{ name: string }, []>('PRAGMA table_info(burns)').all().map((c) => c.name)
if (!columns.includes('block')) db.run('ALTER TABLE burns ADD COLUMN block INTEGER')
if (!columns.includes('time')) db.run('ALTER TABLE burns ADD COLUMN time INTEGER')
db.run('CREATE INDEX IF NOT EXISTS burns_time ON burns (time)')
// USDC minted on Injective. source_tx (the burn) isn't in the event, so it's looked up from Circle when needed.
db.run(`CREATE TABLE IF NOT EXISTS mints (
  nonce TEXT PRIMARY KEY,
  source_domain INTEGER NOT NULL,
  source_tx TEXT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  time INTEGER NOT NULL
)`)
db.run('CREATE INDEX IF NOT EXISTS mints_sender ON mints (sender)')
db.run('CREATE INDEX IF NOT EXISTS mints_recipient ON mints (recipient)')
db.run('CREATE INDEX IF NOT EXISTS mints_source_tx ON mints (source_tx)')
// Lowest block indexed so far, for chains whose history is filled in backwards.
db.run('CREATE TABLE IF NOT EXISTS backfill (domain INTEGER PRIMARY KEY, block INTEGER NOT NULL)')

const insertBurn = db.query('INSERT OR IGNORE INTO burns (domain, tx_hash, log_index, sender, recipient, block, time) VALUES (?, ?, ?, ?, ?, ?, ?)')
const insertMint = db.query('INSERT OR IGNORE INTO mints (nonce, source_domain, sender, recipient, amount, fee, tx_hash, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
const getCursor = db.query<{ block: number }, [number]>('SELECT block FROM cursors WHERE domain = ?')
const setCursor = db.query('INSERT OR REPLACE INTO cursors (domain, block) VALUES (?, ?)')
const getBackfill = db.query<{ block: number }, [number]>('SELECT block FROM backfill WHERE domain = ?')
const setBackfill = db.query('INSERT OR REPLACE INTO backfill (domain, block) VALUES (?, ?)')

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const touchesInjective = (domain: number, burn: Burn) => domain === INJECTIVE_DOMAIN || burn.args.destinationDomain === INJECTIVE_DOMAIN
// bytes32 → 0x address when it holds an EVM address (Solana & co. keep all 32 bytes)
const word = (b: Hex) => (b.startsWith('0x000000000000000000000000') ? `0x${b.slice(26)}` : b).toLowerCase()

function saveBurns(domain: number, burns: Burn[], times?: Map<bigint, number>) {
  for (const burn of burns) {
    if (!touchesInjective(domain, burn)) continue
    const { transactionHash, logIndex, blockNumber, args } = burn
    insertBurn.run(domain, transactionHash.toLowerCase(), logIndex, args.depositor.toLowerCase(), word(args.mintRecipient), Number(blockNumber), times?.get(blockNumber) ?? null)
  }
}

// The body of a USDC mint is a BurnMessageV2: https://developers.circle.com/cctp/references/technical-guide
function saveMints(mints: Mint[], times: Map<bigint, number>) {
  for (const { transactionHash, blockNumber, args } of mints) {
    const body = args.messageBody
    if (size(body) < 228 || hexToNumber(slice(body, 0, 4)) !== 1) continue // other kinds of CCTP messages
    const field = (offset: number) => slice(body, offset, offset + 32)
    const [recipient, amount, sender, fee] = [word(field(36)), hexToBigInt(field(68)), word(field(100)), hexToBigInt(field(164))]
    insertMint.run(args.nonce, args.sourceDomain, sender, recipient, String(amount), String(fee), transactionHash.toLowerCase(), times.get(blockNumber)!)
  }
}

export const indexReceipt = (domain: number, receipt: TransactionReceipt) =>
  saveBurns(domain, parseEventLogs({ abi: [DepositForBurn], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === TOKEN_MESSENGER.toLowerCase()))

export const domainOf = (txHash: string) =>
  db.query<{ domain: number }, [string]>('SELECT domain FROM burns WHERE tx_hash = ? LIMIT 1').get(txHash.toLowerCase())?.domain

export const unredeemedTxs = (address: string) =>
  db
    .query<{ domain: number; txHash: string }, [string]>(
      `SELECT domain, tx_hash AS txHash FROM burns WHERE (recipient = ?1 OR sender = ?1) AND redeemed = 0
       GROUP BY domain, tx_hash ORDER BY MAX(rowid) DESC LIMIT 25`,
    )
    .all(address)

// A page of everything that moved USDC from or to an address, newest first: mints on Injective, and burn txs (from Injective,
// or to it and not minted yet). Burns without a timestamp yet are brand new.
export type HistoryRow = { kind: 'mint' | 'burn'; domain: number; txHash: string | null; nonce: string | null }
export const historyRows = (address: string, limit: number, offset: number) =>
  db
    .query<HistoryRow, [string, number, number]>(
      `SELECT kind, domain, txHash, nonce FROM (
         SELECT 'mint' AS kind, source_domain AS domain, source_tx AS txHash, nonce, time, rowid AS id FROM mints WHERE sender = ?1 OR recipient = ?1
         UNION ALL
         SELECT 'burn', domain, tx_hash, NULL, MAX(time), MAX(rowid) FROM burns b WHERE (sender = ?1 OR recipient = ?1)
           AND (domain = ${INJECTIVE_DOMAIN} OR NOT EXISTS (SELECT 1 FROM mints m WHERE m.source_tx = b.tx_hash))
         GROUP BY domain, tx_hash
       ) ORDER BY COALESCE(time, unixepoch()) DESC, id DESC LIMIT ?2 OFFSET ?3`,
    )
    .all(address, limit, offset)

export type MintRow = { nonce: Hex; sourceDomain: number; sourceTx: string | null; sender: string; recipient: string; amount: string; fee: string; txHash: Hex; time: number }
export const mintOf = (nonce: string) =>
  db
    .query<MintRow, [string]>(
      'SELECT nonce, source_domain AS sourceDomain, source_tx AS sourceTx, sender, recipient, amount, fee, tx_hash AS txHash, time FROM mints WHERE nonce = ?',
    )
    .get(nonce) ?? undefined

export const linkMint = (nonce: string, sourceTx: string) =>
  db.query('UPDATE mints SET source_tx = ? WHERE nonce = ? AND source_tx IS NULL').run(sourceTx, nonce)

export const burnTime = (domain: number, txHash: string) =>
  db.query<{ time: number | null }, [number, string]>('SELECT MAX(time) AS time FROM burns WHERE domain = ? AND tx_hash = ?').get(domain, txHash.toLowerCase())?.time ?? undefined

export function markRedeemed(domain: number, txHash: string, transfers: object[]) {
  db.query('UPDATE burns SET redeemed = 1 WHERE domain = ? AND tx_hash = ?').run(domain, txHash.toLowerCase())
  db.query('INSERT OR REPLACE INTO done VALUES (?, ?, ?)').run(domain, txHash, JSON.stringify(transfers))
}

export const doneTransfers = <T>(domain: number, txHash: string): T[] | undefined => {
  const row = db.query<{ transfers: string }, [number, string]>('SELECT transfers FROM done WHERE domain = ? AND tx_hash = ?').get(domain, txHash)
  return row && JSON.parse(row.transfers)
}

export const saveRedeem = (nonce: string, txHash: string) => db.query('INSERT OR REPLACE INTO redeems VALUES (?, ?)').run(nonce, txHash)

export const redeemTxOf = (nonce: string) =>
  db.query<{ tx_hash: string }, [string]>('SELECT tx_hash FROM redeems WHERE nonce = ?').get(nonce)?.tx_hash

// Hashes are stored as given: parseTx already lowercases 0x hashes, and Solana signatures are case-sensitive.
export const enqueue = (domain: number, txHash: string) => db.query('INSERT OR IGNORE INTO queue VALUES (?, ?, ?)').run(domain, txHash, Date.now())
export const dequeue = (domain: number, txHash: string) => db.query('DELETE FROM queue WHERE domain = ? AND tx_hash = ?').run(domain, txHash)
export const queuedTxs = () => db.query<{ domain: number; txHash: string; added: number }, []>('SELECT domain, tx_hash AS txHash, added FROM queue').all()

export const indexedBlocks = () =>
  Object.fromEntries(chains.map((chain) => [chain.name, getCursor.get(chain.domain)?.block ?? null]))
export const historyFrom = () => getBackfill.get(INJECTIVE_DOMAIN)?.block ?? null

export function startIndexer() {
  for (const chain of chains) {
    void scan(chain)
    void fillTimes(chain)
  }
  if (historyFromBlock !== undefined) void backfill(chains.find((chain) => chain.domain === INJECTIVE_DOMAIN)!, historyFromBlock)
}

// Looks up the block time of burns indexed without one (before times were stored, or from a lookup's receipt), newest first.
async function fillTimes({ domain, client }: EvmChain) {
  const batch = 50
  const missing = db.query<{ txHash: string; block: number | null }, [number, number]>(
    'SELECT tx_hash AS txHash, MAX(block) AS block FROM burns WHERE domain = ? AND time IS NULL GROUP BY tx_hash ORDER BY MAX(rowid) DESC LIMIT ?',
  )
  const setTime = db.query('UPDATE burns SET time = ?, block = ? WHERE domain = ? AND tx_hash = ?')
  const retryAt = new Map<string, number>()
  while (true) {
    let tried = 0
    for (const { txHash, block } of missing.all(domain, batch + retryAt.size)) {
      if ((retryAt.get(txHash) ?? 0) > Date.now()) continue
      if (tried++ === batch) break
      try {
        const number = block ?? Number((await client.getTransactionReceipt({ hash: txHash as Hex })).blockNumber)
        const { timestamp } = await client.getBlock({ blockNumber: BigInt(number) })
        setTime.run(Number(timestamp), number, domain, txHash)
        retryAt.delete(txHash)
      } catch {
        retryAt.set(txHash, Date.now() + 600_000)
      }
    }
    if (tried <= batch) await Bun.sleep(pollMs)
  }
}

async function scan(chain: EvmChain) {
  const { domain, name, rpcEnv, client } = chain
  let cursor = getCursor.get(domain)?.block
  let step = 1000 // public RPCs cap eth_getLogs ranges differently, so the range adapts on errors
  let failures = 0
  let lastWarning = 0
  while (true) {
    try {
      const head = Number(await client.getBlockNumber())
      cursor ??= head - (await lookbackBlocks(client, head))
      if (cursor >= head) {
        await Bun.sleep(pollMs)
        continue
      }
      const to = Math.min(head, cursor + step)
      await indexRange(chain, cursor + 1, to)
      setCursor.run(domain, to)
      cursor = to
      failures = 0
      step = Math.min(step * 2, 10_000)
      if (to === head) await Bun.sleep(pollMs)
    } catch (err) {
      step = Math.max(1, Math.floor(step / 2))
      if (++failures >= 5 && Date.now() - lastWarning > 600_000) {
        lastWarning = Date.now()
        console.warn(`[indexer] ${name} keeps failing (set ${rpcEnv} to a better RPC):`, err instanceof BaseError ? err.shortMessage.split('\n')[0] : err)
      }
      await Bun.sleep(Math.min(failures, 30) * 1000)
    }
  }
}

// Walks back from where indexing started to the given block, so old transfers show up too. A few ranges at a time:
// it's ~3,000 of them on Injective, each also fetching the time of every block with a transfer.
async function backfill(chain: EvmChain, fromBlock: number) {
  const { domain, name, client } = chain
  let low = getBackfill.get(domain)?.block
  let step = 10_000
  let failures = 0
  while (low === undefined || low > fromBlock) {
    try {
      low ??= getCursor.get(domain)?.block ?? Number(await client.getBlockNumber())
      const from = Math.max(fromBlock, low - step * 8)
      const ranges: [number, number][] = []
      for (let to = low - 1; to >= from; to -= step) ranges.push([Math.max(from, to - step + 1), to])
      await Promise.all(ranges.map(([start, end]) => indexRange(chain, start, end)))
      setBackfill.run(domain, from)
      low = from
      failures = 0
      step = Math.min(step * 2, 10_000)
    } catch {
      step = Math.max(1, Math.floor(step / 2))
      await Bun.sleep(Math.min(++failures, 30) * 1000)
    }
  }
  console.log(`[indexer] ${name} history indexed back to block ${fromBlock}`)
}

async function indexRange({ domain, client }: EvmChain, from: number, to: number) {
  const hub = domain === INJECTIVE_DOMAIN
  const logs = await client.getLogs({
    address: hub ? [TOKEN_MESSENGER, MESSAGE_TRANSMITTER] : TOKEN_MESSENGER,
    events: hub ? [DepositForBurn, MessageReceived] : [DepositForBurn],
    fromBlock: BigInt(from),
    toBlock: BigInt(to),
    strict: true,
  })
  const burns = logs.filter((l) => l.eventName === 'DepositForBurn' && same(l.address, TOKEN_MESSENGER)) as Burn[]
  const mints = logs.filter((l) => l.eventName === 'MessageReceived' && same(l.address, MESSAGE_TRANSMITTER)) as Mint[]
  const times = await blockTimes(client, [...burns.filter((b) => touchesInjective(domain, b)), ...mints].map((l) => l.blockNumber))
  db.transaction(() => {
    saveBurns(domain, burns, times)
    saveMints(mints, times)
  })()
}

async function blockTimes(client: EvmChain['client'], blocks: bigint[]) {
  const times = new Map<bigint, number>()
  const unique = [...new Set(blocks)]
  for (let i = 0; i < unique.length; i += 50) {
    await Promise.all(
      unique.slice(i, i + 50).map(async (blockNumber) => times.set(blockNumber, Number((await client.getBlock({ blockNumber })).timestamp))),
    )
  }
  return times
}

// Converts the lookback window into a block count using the chain's recent block time.
async function lookbackBlocks(client: EvmChain['client'], head: number) {
  if (lookbackHours <= 0) return 0
  const sample = Math.min(head, 1000)
  const [from, to] = await Promise.all([client.getBlock({ blockNumber: BigInt(head - sample) }), client.getBlock({ blockNumber: BigInt(head) })])
  const blockTime = Number(to.timestamp - from.timestamp) / sample || 1
  return Math.min(head, Math.round((lookbackHours * 3600) / blockTime))
}
