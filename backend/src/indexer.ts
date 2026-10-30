import { Database } from 'bun:sqlite'
import { BaseError, parseAbiItem, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'
import { chains, dbPath, INJECTIVE_DOMAIN, lookbackHours, pollMs, TOKEN_MESSENGER, type EvmChain } from './config'

// Watches every EVM chain for burns to Injective, and Injective for burns leaving it, so transfers can be looked up by wallet address.

const DepositForBurn = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
)
type Burn = { transactionHash: Hex; logIndex: number; blockNumber: bigint; args: { depositor: Hex; mintRecipient: Hex; destinationDomain: number } }

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
// Added after the first release: the burn's block, and its timestamp (filled in by fillTimes).
const columns = db.query<{ name: string }, []>('PRAGMA table_info(burns)').all().map((c) => c.name)
if (!columns.includes('block')) db.run('ALTER TABLE burns ADD COLUMN block INTEGER')
if (!columns.includes('time')) db.run('ALTER TABLE burns ADD COLUMN time INTEGER')
db.run('CREATE INDEX IF NOT EXISTS burns_time ON burns (time)')

const insertBurn = db.query('INSERT OR IGNORE INTO burns (domain, tx_hash, log_index, sender, recipient, block) VALUES (?, ?, ?, ?, ?, ?)')
const getCursor = db.query<{ block: number }, [number]>('SELECT block FROM cursors WHERE domain = ?')
const setCursor = db.query('INSERT OR REPLACE INTO cursors (domain, block) VALUES (?, ?)')

function saveBurns(domain: number, burns: Burn[]) {
  for (const { transactionHash, logIndex, blockNumber, args } of burns) {
    if (domain !== INJECTIVE_DOMAIN && args.destinationDomain !== INJECTIVE_DOMAIN) continue
    const recipient = `0x${args.mintRecipient.slice(26)}`.toLowerCase()
    insertBurn.run(domain, transactionHash.toLowerCase(), logIndex, args.depositor.toLowerCase(), recipient, Number(blockNumber))
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

// A page of every tx that moved USDC from or to an address, newest first. Burns without a timestamp yet are brand new.
export const addressTxs = (address: string, limit: number, offset: number) =>
  db
    .query<{ domain: number; txHash: string }, [string, number, number]>(
      `SELECT domain, tx_hash AS txHash FROM burns WHERE recipient = ?1 OR sender = ?1
       GROUP BY domain, tx_hash ORDER BY COALESCE(MAX(time), unixepoch()) DESC, MAX(rowid) DESC LIMIT ?2 OFFSET ?3`,
    )
    .all(address, limit, offset)

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

export function startIndexer() {
  for (const chain of chains) {
    void scan(chain)
    void fillTimes(chain)
  }
}

// Looks up the block time of a chain's burns, newest first. Burns indexed before times were stored need their receipt for the block.
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

async function scan({ domain, name, rpcEnv, client }: EvmChain) {
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
      const logs = await client.getLogs({ address: TOKEN_MESSENGER, event: DepositForBurn, fromBlock: BigInt(cursor + 1), toBlock: BigInt(to), strict: true })
      saveBurns(domain, logs)
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

// Converts the lookback window into a block count using the chain's recent block time.
async function lookbackBlocks(client: EvmChain['client'], head: number) {
  if (lookbackHours <= 0) return 0
  const sample = Math.min(head, 1000)
  const [from, to] = await Promise.all([client.getBlock({ blockNumber: BigInt(head - sample) }), client.getBlock({ blockNumber: BigInt(head) })])
  const blockTime = Number(to.timestamp - from.timestamp) / sample || 1
  return Math.min(head, Math.round((lookbackHours * 3600) / blockTime))
}
