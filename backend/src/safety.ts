import { formatUnits, type Hex } from 'viem'
import { sameAddress, USDT0_MESH, type ChainInfo } from './chains'
import { chains as cctpChains } from './config'
import { nativePrice } from './prices'
import { defaultSubaccount, EXCHANGE, orderOf } from './providers/orderbook'
import { isNative, type ProviderId, type Quote, type QuoteRequest, type Step } from './providers/shared'
import { base58Encode, hexKey, publicKey, tokenAccount, TOKEN_PROGRAMS, usdcAccount } from './solana'

// Which contracts each provider's transactions may call, pinned here rather than read from the providers: their metadata
// comes from the same API as the quote, so a compromised API could vouch for itself. Every quote is checked before it's
// shown (valid() in ./providers/index.ts), and a chain without an entry for a provider gets none of its routes there.
// Pinned on 2026-11-05 from the providers' docs and deployments and from live quotes; every address has code on its chain.
// Providers do move contracts (Relay went from v3 to v3.2 in October 2026): their routes then stop showing up, with the
// new address in the quote errors and the server log, until it's checked and added here.

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' // a signature away from moving any approved token: never

// LI.FI: its diamond, at one address on most chains and its own on these (LI.FI's /chains and lifinance/contracts deployments).
const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const LIFI_DIAMONDS: Record<number, string> = {
  14: '0x198fc70dfe05e755c81e54bd67bff3f729344b9b',
  40: '0xa7cd44521903c65915648385e3fe881e49171582',
  50: '0x055d4612ec74ad799c6cb4df72c0ab8dbdbcbafa',
  88: '0x198fc70dfe05e755c81e54bd67bff3f729344b9b',
  130: '0x864b314d4c5a0399368609581d3e8933a63b9232',
  143: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  324: '0x341e94069f53234fe6dabef707ad424830525715',
  747: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  988: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  999: '0x0a0758d937d1059c356d4714e57f5df0239bce1a',
  1088: '0x24ca98fb6972f5ee05f0db00595c7f68d9fafd68',
  1480: '0x198fc70dfe05e755c81e54bd67bff3f729344b9b',
  1672: '0xff70f4a1d11995621854f3692acf286d8acd04b2',
  1776: '0xecec3970ca674278da8d9b1c484acaf6b20181f5',
  1868: '0x864b314d4c5a0399368609581d3e8933a63b9232',
  2020: '0x452cf1b8597e6319cd21abd847312bf17e26d8d1',
  2741: '0x4f8c9056bb8a3616693a76922fa35d53c056e5b3',
  2818: '0xf7ab42d00d2399f8a4fba2f15466be40709fe307',
  4217: '0x2cacae8e22418e65dcf7651c67aebe6288eb8243',
  4326: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  4663: '0xb477751b76cf82d00a686a1232f5fcd772414af3',
  5031: '0x0bc413cae89c5b3ba3aa87fb98dca23425e1828f',
  5042: '0xa4072583658fae592a3506a42431cb6316a8d40b',
  8217: '0x1255d17c1bc2f764d087536410879f2d0d8772fd',
  9745: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  16661: '0x213a83c67e1fc0334ef684571abcb820708a6536',
  33139: '0x2dea447e7dc6cd2f10b31bf10dcb30f87e838417',
  42170: '0xff70f4a1d11995621854f3692acf286d8acd04b2',
  42793: '0x977474593c982cfa8b197cae302e6d01f789435b',
  43111: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37',
  57073: '0x864b314d4c5a0399368609581d3e8933a63b9232',
  59144: '0xde1e598b81620773454588b85d6b5d4eec32573e',
  80094: '0xf909c4ae16622898b885b89d7f839e0244851c66',
  98866: '0x6f5c8bb0c5fe4eceac40ee1c238eab6bbb29761c',
  747474: '0xc59fe32c9549e3e8b5dccdabc45bd287bd5ba2bc',
}

// Relay: its v3 and v3.2 router and approval proxy and its depository, which Relay says to allow side by side, at one set
// of addresses on chains with Cancun's opcodes and another on the rest. https://docs.relay.link/references/api/api_resources/contract-addresses
const RELAY_LONDON = new Set([25, 1088, 5000, 59144])
const RELAY = {
  cancun: [
    '0x0729e2a4716d9f7dd17858d5d504426d228697f7',
    '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    '0x5567954cd026cebfe486062cb75848e0f1c12e58',
    '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
    '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
  ],
  london: [
    '0x59916da825d2d2ec1bf878d71c88826f6633ecca',
    '0x6328ea02d28131e58b28e55c6258258a30d90e05',
    '0x8754bc615047de01228a7527b712806a71a8dc9a',
    '0x9ef6d3c2f60d7b9008d74cab1fc0f899c957c819',
    '0xe4dfbd5e6784db1058124e2c87554c0591f0fb7b',
  ],
}

// deBridge: DlnSource and the router in front of it (when the input is swapped first), the same on each of its EVM chains.
const DEBRIDGE = ['0xef4fb24ad0916217251f553c0596f8edc630eb66', '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251']
const DEBRIDGE_CHAINS = new Set([1, 10, 25, 56, 137, 143, 999, 1514, 1776, 4326, 4663, 5042, 8453, 42161, 43114, 59144])

// Across: each chain's SpokePool, SpokePoolPeriphery and the other entry points its routes use (across-protocol/contracts
// deployed-addresses.json). USDC to Solana goes through Circle's TokenMessenger instead (see acrossBurn).
const ACROSS: Record<number, string[]> = {
  1: ['0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x6769155b16f25d317819efef011e0a50a48e83c5', '0xc80b267469d509ae45df65845b291cbbe1945cb9'],
  10: ['0x6f26bf09b1c792e3228e5467807a900a503c0281', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x4d11a23e4408ef08ae1216b3917560e0001cd000'],
  56: ['0x4e8e101924ede233c13e2d8622dc8aed2872d505', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'],
  130: ['0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xce9cf0c8f8121b573f6212344f53bc7746846e71', '0xc920dabe5f40d0785be9b4acf5b4b8d662a5955a'],
  137: ['0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x6005cd9f10c0dc654445f138350b2fa7370be42d', '0x43e15fb40dadda50e1d2ba300416811f6c28540c'],
  143: ['0xd2ecb3afe598b746f8123cae365a598da831a449', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xc49226858478de8757e425661b1b5297102330d7', '0xb0c6ed64a77a3d8f61b21922b13f39525fbf5fc0'],
  324: ['0xe0b015e54d54fc84a6cb9b666099c46ade9335ff', '0x7c99ced6d8011af8a52488884f7ba2c61b0fa57d'],
  480: ['0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x2c7a3ccd1a8f4f96174c42e0638aab3bda6bc923'],
  999: ['0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xf4e32c4ac479f0b007bc005ec0f481a2c78ba1b4', '0x93e1e5e9d840e758cc016f8b13cdf5dbaeca4b06'],
  1868: ['0x3bad7ad0728f9917d1bf08af5782dcbd516cdd96', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'],
  4217: ['0x2d4710f04da90184255782d3715224a6c776955d', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'],
  4326: ['0x3db06da8f0a24a525f314eec954fc5c6a973d40e', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x02d65fb01d3d88127df19838902ba42c6239c0fd'],
  4663: ['0xd29c85f15df544ba632c9e25829fd29d767d7978', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'],
  5042: ['0x9b4a302a548c7e313c2b74c461db7b84d3074a84', '0xe791a2669bef779ff7a4a9cf789f8ee2ca20a32c'],
  8453: ['0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xa30968d3468316d957b9115eaad3c1c8e450116d'],
  9745: ['0x50039faefebef707cfd94d6d462fe6d10b39207a', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'],
  42161: ['0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xc9c54d789ebc18169d942e781c75bb4e3d19a27b', '0x39e4a5a7ded068831ea8d1c1012cea07a811f624'],
  43114: ['0xfe9d541c92e4e90437c7152a00244886de37a658', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x1037a21a30aeff90c269b01c3933eb9a5285d9b8'],
  57073: ['0xef684c38f94f48775959ecf2012d7e864ffb9dd4', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0x1771c470d41b8c39338450c380bf2c080a2cedd8', '0xfe9d541c92e4e90437c7152a00244886de37a658'],
  59144: ['0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75', '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', '0xe3e88958d181ab43bf3902f8f00af57cf5d44e8c'],
}

// Skip documents none of its EVM contracts. These came from its quotes and were checked on-chain: proxies with one owner
// (0x24a9267c…), whose Go Fast handlers point at the gateways in Skip's solver config and whose CCTP relayer at Circle's
// TokenMessenger. Its Axelar, Eureka, Stargate and LayerZero routes call contracts nobody has verified, so they're left out.
const SKIP_CCTP = '0x400bb58033a7763a834199190b68f66a2661ae73'
const SKIP_CCTP_CHAINS = new Set([1, 10, 137, 1776, 8453, 42161, 43114])
const SKIP_GO_FAST: Record<number, string> = {
  1: '0xa11cc0efb1b3acd95a2b8cd316e8c132e16048b5',
  10: '0x9c540edc86613b22968da784b2d42ac79965af91',
  137: '0x2260f6120b634b94a23ef11fa0d615ecf62db3cd',
  8453: '0x9335c0c0cbc0317291fd48c00b2f71c8b39da6f8',
  42161: '0x4c58ae019e54d10594f1aa26abf385b6fb17a52d',
  43114: '0xb7b287f15e5eddfeff2b05ef1be7f7cc73197aaa',
}
// Its entry point for swaps on one chain (evm_swap): a proxy with the same owner, its implementation SkipGoSwapRouter
// (verified on Sourcify), at its own address on each chain. Found in Skip's /msgs answers on 2026-11-05.
const SKIP_SWAP: Record<number, string> = {
  1: '0xd1ee705d774d59541d3d395e72a16e48389df7c7',
  10: '0xc352fb0e5fc310fcbfd736542d45efa27b9e1cae',
  56: '0xbc4bdeb1e85c62f5da9cb732a5209408db7b4769',
  137: '0x8a68dd4b423ef7568d0cdf3bb8e4863ca1041a9e',
  8453: '0xd57611dd97eacb7ae19ae5d789e943d07f4dfa4f',
  42161: '0xa307099736ff10f6a639d8a00f3c0ac62e10424a',
}

// Its swap entry point on each Cosmos chain it swaps on (labeled Skip Swap Entry Point, without an admin, on each chain's
// REST), and its relayer's fee account on Noble, which CCTP routes from there pay with a MsgSend. From Skip's /msgs
// answers on 2026-11-06; IBC transfers out of the other Cosmos chains call no contract.
const SKIP_ENTRY: Record<string, string> = {
  'bbn-1': 'bbn1g0uuysdqydrmfum8ctn7whlevuwydeqvuw0kumqj8773ru5aglwq6vww30',
  'injective-1': 'inj1l62elesw6lw9w5ctqpwv0apkeghppr5d2mdqwh',
  'osmosis-1': 'osmo10a3k4hvk37cc4hnxctw4p95fhscd2z6h2rmx0aukc6rm8u9qqx9smfsh7u',
  'phoenix-1': 'terra13jfx06k2zpajtxymdgq2r6mrezzx3ngrhzfe24gdh9mqs8x67lmspee8lp',
}
const SKIP_NOBLE_FEES = 'noble1dyw0geqa2cy0ppdjcxfpzusjpwmq85r5a35hqe'

// From Hyperliquid, Relay's transfer sends USDC to its deposit account there (the same in every quote since 2026-11-04),
// after the wallet signs a NonceMapping of that transfer to the order, posted to Relay's own API.
const RELAY_AUTHORIZE = 'https://api.relay.link/authorize'
const RELAY_HYPERLIQUID = '0x66cf0aace1b4e562593bec10ec7868fba9932224'
const HYPERLIQUID_USDC = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054'
const NONCE_MAPPING = 'chainId:string wallet:address depositor:address id:bytes32 nonce:uint256'

// The bridges under Skip's EVM routes that call only the contracts above (the quote's via names them), so that a preview
// without transactions yet is refused like the full quote would be.
const SKIP_VIA = new Set(['CCTP', 'Go Fast', 'IBC'])

// The contracts a provider's transactions may call (and be approved) on an EVM chain, lowercased; none for LayerZero yet.
function contracts(provider: ProviderId, chainId: number): string[] | undefined {
  if (provider === 'lifi') return [LIFI_DIAMONDS[chainId] ?? LIFI_DIAMOND]
  if (provider === 'relay') return RELAY_LONDON.has(chainId) ? RELAY.london : RELAY.cancun
  if (provider === 'debridge') return DEBRIDGE_CHAINS.has(chainId) ? DEBRIDGE : undefined
  if (provider === 'across') return ACROSS[chainId]
  if (provider === 'usdt0') return USDT0_MESH[chainId] && [USDT0_MESH[chainId].oft.toLowerCase()]
  if (provider === 'orderbook') return chainId === 1776 ? [EXCHANGE] : undefined
  if (provider === 'skip') {
    const list = [SKIP_GO_FAST[chainId], SKIP_SWAP[chainId], SKIP_CCTP_CHAINS.has(chainId) ? SKIP_CCTP : undefined].filter((a): a is string => !!a)
    return list.length ? list : undefined
  }
}

// Circle's TokenMessenger on a CCTP chain (EDGE's is its own), lowercased.
const tokenMessenger = (chainId: number) => cctpChains.find((c) => c.chain.id === chainId)?.tokenMessenger.toLowerCase()

// Solana programs any route may call (compute budget, system, both token programs, token accounts, memos), and each
// provider's own, one of which its transactions must call: deBridge's DLN source, Relay's depository and Jupiter (Relay's
// swaps there are Jupiter's), Across's spoke pool and CCTP, Skip's CCTP (V1 and V2). deBridge also swaps SOL on Jupiter
// before an order. LI.FI's routes there mostly pay deposit addresses (NEAR Intents, Layerswap), which can't be checked:
// only its swaps through DFlow's aggregator (its tool 'dflow') are allowed.
const SYSTEM = '11111111111111111111111111111111'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const SOLANA_COMMON = new Set([
  COMPUTE_BUDGET,
  SYSTEM,
  ...TOKEN_PROGRAMS,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
])
const SOLANA_PROGRAMS: Partial<Record<ProviderId, { own: string[]; also?: string[] }>> = {
  debridge: { own: ['src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4'], also: [JUPITER] },
  relay: { own: ['99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', JUPITER] },
  across: { own: ['DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru', 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe', 'FsD4uqAyXiAcQapVTokNvdz1ZC5hMHjY6a93nYmEqZQS'] },
  skip: { own: ['CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3', 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'] },
  lifi: { own: ['DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH'] },
}
// SOL a route may take from the wallet besides the amount: rent for the accounts it opens, tips, the priority fee.
const SOLANA_FEES = 10_000_000n

type SolanaMessage = { payer: string; keys: string[]; instructions: { program: string; data: Uint8Array; accounts: number[]; writes: boolean }[] }

// The parts of a serialized Solana transaction (legacy or v0) the checks need: its listed accounts, the fee payer first,
// and each top-level instruction's program, data, accounts (indexes: the listed ones, then those loaded from lookup
// tables) and whether it gets one it could change (a signer or a writable one). Undefined when it doesn't parse.
// https://solana.com/docs/core/transactions
export function solanaMessage(base64: string): SolanaMessage | undefined {
  const tx = Buffer.from(base64, 'base64')
  let at = 0
  const take = (n: number) => {
    if (at + n > tx.length) throw new RangeError('short transaction')
    return tx.subarray(at, (at += n))
  }
  const byte = () => take(1)[0]!
  // Lengths are compact-u16: 7 bits a byte, low bits first.
  const length = () => {
    let n = 0
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte()
      n |= (b & 0x7f) << shift
      if (!(b & 0x80)) return n
    }
    throw new RangeError('bad length')
  }
  try {
    take(64 * length()) // signatures
    const v0 = !!((tx[at] ?? 0) & 0x80)
    if (v0 && byte() !== 0x80) return // versions after v0
    const [signers, readonlySigners, readonly] = [byte(), byte(), byte()]
    const keys = Array.from({ length: length() }, () => base58Encode(take(32)))
    take(32) // blockhash
    const instructions = Array.from({ length: length() }, () => ({ program: byte(), accounts: [...take(length())], data: take(length()) }))
    // v0: accounts loaded from lookup tables follow the listed ones, all the writable ones first.
    let [loadedWritable, loaded] = [0, 0]
    if (v0) {
      for (let tables = length(); tables > 0; tables--) {
        take(32)
        const writable = length()
        take(writable)
        const others = length()
        take(others)
        loadedWritable += writable
        loaded += writable + others
      }
    }
    // Listed: signers first (the read-only ones last among them), then the others (likewise). An index past them all counts as writable.
    const n = keys.length
    const writes = (i: number) => (i < n ? i < signers - readonlySigners || (i >= signers && i < n - readonly) : i - n < loadedWritable || i - n >= loaded)
    if (!signers || !keys[0]) return
    // A program is always a listed key (v0 can't load one from a lookup table).
    return {
      payer: keys[0],
      keys,
      instructions: instructions.map((ix) => {
        const program = keys[ix.program]
        if (!program) throw new RangeError('program index')
        return { program, data: ix.data, accounts: ix.accounts, writes: ix.accounts.some((i) => i < signers || writes(i)) }
      }),
    }
  } catch {
    return
  }
}

// Little-endian integers in instruction data; 0 when it's too short, which its program would refuse anyway.
const u32 = (data: Uint8Array, at: number) => (data.length >= at + 4 ? new DataView(data.buffer, data.byteOffset).getUint32(at, true) : 0)
const u64 = (data: Uint8Array, at: number) => (data.length >= at + 8 ? new DataView(data.buffer, data.byteOffset).getBigUint64(at, true) : 0n)

// What a Solana transaction takes from the wallet (account 0, the fee payer) through the common programs, or why it's
// refused. Its SOL goes out only in transfers, accounts it pays to open and the priority fee; its tokens only from its own
// account of the given mint (a Transfer doesn't name the mint, and a TransferChecked's has to be its account's); its token
// accounts close only back to it. Any other system or token instruction is refused: approvals, authority changes, burns,
// Assign and Allocate on the wallet. The bridges' own programs get what they're handed: bounding those would take a simulation.
function walletOutflow({ keys, instructions }: SolanaMessage, mint: string): { lamports: bigint; tokens: bigint } | string {
  let [lamports, tokens, units, price] = [0n, 0n, 1_400_000n, 0n]
  const [owner, token] = [publicKey(keys[0]!)!, publicKey(mint)]
  const account = (program: string) => token && base58Encode(tokenAccount(owner, token, publicKey(program)!))
  for (const { program, data, accounts } of instructions) {
    const wallet = (i: number) => accounts[i] === 0
    if (program === COMPUTE_BUDGET) {
      // SetComputeUnitLimit (2) and SetComputeUnitPrice (3, in millionths of a lamport); without a limit, the most.
      if (data[0] === 2) units = BigInt(u32(data, 1))
      if (data[0] === 3) price = u64(data, 1)
    } else if (program === SYSTEM) {
      // CreateAccount (0) and Transfer (2) have the lamports after the tag; AdvanceNonceAccount (4) moves none.
      const tag = u32(data, 0)
      if (tag !== 0 && tag !== 2 && tag !== 4) return `The Solana transaction has a system instruction (${tag}) routes don't use`
      if (tag !== 4 && wallet(0)) lamports += u64(data, 4)
    } else if (TOKEN_PROGRAMS.includes(program)) {
      // Transfer (3) and TransferChecked (12), by their authority: the amount after the tag.
      const tag = data[0] ?? -1
      if ((tag === 3 && wallet(2)) || (tag === 12 && wallet(3))) {
        if (keys[accounts[0]!] !== account(program)) return "The Solana transaction transfers another of the wallet's tokens"
        tokens += u64(data, 1)
      } else if (tag === 9 && wallet(2) && !wallet(1)) return "The Solana transaction closes one of the wallet's token accounts to someone else"
      // Besides those: transfers by other signers, creating accounts (1, 16, 18, 22), Revoke (5) and SyncNative (17).
      else if (![1, 3, 5, 9, 12, 16, 17, 18, 22].includes(tag)) return `The Solana transaction has a token instruction (${tag}) routes don't use`
    }
  }
  return { lamports: lamports + (price * units + 999_999n) / 1_000_000n, tokens }
}

// What a route may send of the source chain's gas token beyond the amount (deBridge's flat fee, LayerZero's fee for
// USDT0, LI.FI's bridges' native fees): about $5 of it at feePrice, else 0.01 of it. Where gas is ETH never more than 0.01
// ETH (~$22). A tx's value is in wei on every EVM chain, whatever decimals the gas token has as a contract (Stable's USDT0
// has 6). A route over the cap is refused, not trimmed.
function feeCap(chain: ChainInfo, usd?: number) {
  const unit = 10n ** 18n
  const hundredth = unit / 100n
  if (!usd || !(usd > 0)) return hundredth
  const cap = (BigInt(Math.floor((5 / usd) * 1e6)) * unit) / 1_000_000n
  return chain.native?.symbol === 'ETH' && cap > hundredth ? hundredth : cap
}

// The gas token's price for the fee cap: the market's (DefiLlama's, see ./prices.ts), or the token list's where that's
// higher. The lists come from the same providers' APIs, so a wrong one may narrow the cap but never widen it, and without a
// market price there's none. Never rejects.
export const feePrice = (chain: ChainInfo): Promise<number | undefined> =>
  chain.kind === 'evm' ? nativePrice(chain.id, (market, list) => (market ? { price: Math.max(market, list ?? 0), source: 'market' } : undefined)).catch(() => undefined) : Promise.resolve(undefined)

// Each refusal is logged once per provider, chain and address.
const logged = new Set<string>()
function refuse(provider: ProviderId, chain: string | number, address: string, reason: string) {
  const key = `${provider}:${chain}:${address.toLowerCase()}`
  if (!logged.has(key)) {
    logged.add(key)
    console.warn(`[safety] ${provider} on ${chain}: ${reason}`)
  }
  return reason
}

const word = (data: string, i: number) => data.slice(10 + 64 * i, 74 + 64 * i)
// approve(spender, 0) exactly, to one of the provider's contracts: the reset USDT needs before a new allowance.
const isReset = (data: Hex, allowed: string[]) => {
  const m = /^0x095ea7b3(0{24}([0-9a-f]{40}))0{64}$/.exec(data.toLowerCase())
  return !!m && allowed.includes(`0x${m[2]}`)
}
// Across's USDC routes to Solana: depositForBurn on Circle's TokenMessenger, burning at most the amount of the token sent,
// to the destination's CCTP domain and the recipient there (on Solana its USDC account, where CCTP mints).
const acrossBurn = (data: Hex, req: QuoteRequest) => {
  const d = data.toLowerCase()
  const key = req.to.kind === 'solana' ? publicKey(req.recipient) : undefined
  const recipient = key ? hexKey(usdcAccount(key)).slice(2) : req.recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  return (
    d.startsWith('0x8e0250ee') &&
    d.length >= 10 + 64 * 7 &&
    BigInt(`0x${word(d, 0)}`) <= req.amount &&
    req.to.domain !== undefined &&
    BigInt(`0x${word(d, 1)}`) === BigInt(req.to.domain) &&
    word(d, 2) === recipient &&
    `0x${word(d, 3).slice(24)}` === req.fromToken.toLowerCase()
  )
}

// Relay's authorization from Hyperliquid: a NonceMapping of the sender's transfer (by its nonce) to Relay's order, which no
// signature for anything else (a permit, a Hyperliquid action) matches.
function nonceMapping(s: Extract<Step, { kind: 'signature' }>, sender: string, nonce?: number) {
  const { domain, types, primaryType, message: m } = s.typedData
  return (
    s.post.url === RELAY_AUTHORIZE &&
    primaryType === 'NonceMapping' &&
    domain.name === 'RelayNonceMapping' &&
    domain.version === '2' &&
    Object.keys(domain).every((k) => ['name', 'version', 'chainId', 'verifyingContract'].includes(k)) &&
    (domain.verifyingContract === undefined || /^0x0{40}$/.test(String(domain.verifyingContract))) &&
    Object.keys(types).join() === 'NonceMapping' &&
    types.NonceMapping!.map((f) => `${f.name}:${f.type}`).join(' ') === NONCE_MAPPING &&
    m.chainId === 'hyperliquid' &&
    sameAddress(String(m.wallet), sender) &&
    sameAddress(String(m.depositor), sender) &&
    nonce !== undefined &&
    String(m.nonce) === String(nonce)
  )
}

// A reason to refuse the quote, or undefined when every step only calls what the provider is known to use there: approvals
// of the token sent, for at most the amount in all, to its contracts; transactions to its contracts (or a reset of such an
// approval), sending no more of the gas token than the amount (if that's what is sent) and its fees; on Solana, its
// programs and the common ones, paid by the sender, taking no more of the wallet's SOL and tokens through the common ones
// than that either, and handing over nothing (see walletOutflow); from Hyperliquid, one transfer to Relay and its
// NonceMapping. Previews have no steps: then only whether the provider is checked on the source chain at all. nativeUsd
// prices the gas token for the fee cap (see feePrice).
export function checkQuote(req: QuoteRequest, quote: Quote, nativeUsd?: number): string | undefined {
  const { provider, steps } = quote
  const from = req.from
  const native = isNative(from, req.fromToken)
  if (from.kind === 'evm') {
    const chainId = from.chainId!
    const allowed = contracts(provider, chainId)
    if (!allowed) return refuse(provider, chainId, '-', `No allowlisted contracts for this bridge on chain ${chainId}`)
    if (provider === 'skip' && quote.via?.split(' + ').some((b) => !SKIP_VIA.has(b))) {
      return refuse(provider, chainId, quote.via, `Skip's ${quote.via} contracts on chain ${chainId} aren't verified`)
    }
    const messenger = provider === 'across' ? tokenMessenger(chainId) : undefined
    const spenders = messenger ? [...allowed, messenger] : allowed
    const token = req.fromToken.toLowerCase()
    let [value, approved] = [0n, 0n]
    for (const s of steps) {
      if (s.kind === 'approve') {
        const spender = s.spender.toLowerCase()
        if (spender === PERMIT2) return refuse(provider, chainId, spender, `Approval to Permit2 on chain ${chainId}`)
        if (native || s.token.toLowerCase() !== token) return refuse(provider, chainId, s.token, `Approval of another token (${s.token}) on chain ${chainId}`)
        if (!spenders.includes(spender)) return refuse(provider, chainId, spender, `Unrecognized contract ${s.spender} on chain ${chainId}`)
        // In all: each spender gets its own allowance, and could use all of it.
        approved += /^\d+$/.test(s.amount) ? BigInt(s.amount) : req.amount + 1n
        if (approved > req.amount) return refuse(provider, chainId, 'approval', `Approvals for more than the amount on chain ${chainId}`)
      } else if (s.kind === 'evm') {
        const to = s.to.toLowerCase()
        if (to === PERMIT2) return refuse(provider, chainId, to, `Call to Permit2 on chain ${chainId}`)
        if (!/^\d+$/.test(s.value)) return refuse(provider, chainId, 'value', `Invalid value on chain ${chainId}`)
        value += BigInt(s.value)
        // Injective's exchange precompile does much else (transfers, grants): only a sell from the sender's own bank balance,
        // whose proceeds stay there, so only for the sender as recipient.
        if (provider === 'orderbook') {
          const call = to === EXCHANGE ? orderOf(s.data) : undefined
          const own = call && sameAddress(req.recipient, req.sender) && sameAddress(call.sender, req.sender) && call.order.subaccountID === defaultSubaccount(req.sender)
          if (!own || call.order.orderType !== 'sell' || BigInt(s.value) !== 0n) return refuse(provider, chainId, to, `Not a sell order from the sender on chain ${chainId}`)
          continue
        }
        if (allowed.includes(to)) continue
        if (messenger && to === messenger && acrossBurn(s.data, req)) continue
        if (to === token && BigInt(s.value) === 0n && isReset(s.data, allowed)) continue
        return refuse(provider, chainId, to, `Unrecognized contract ${s.to} on chain ${chainId}`)
      } else return refuse(provider, chainId, s.kind, `Unexpected ${s.kind} step on chain ${chainId}`)
    }
    const most = (native ? req.amount : 0n) + feeCap(from, nativeUsd)
    if (value > most) {
      const symbol = from.native?.symbol ?? 'gas token'
      return refuse(provider, chainId, 'value', `Sends ${formatUnits(value, 18)} ${symbol} on chain ${chainId}, more than the transfer and its fees`)
    }
    return
  }

  if (from.kind === 'solana') {
    const programs = SOLANA_PROGRAMS[provider]
    if (!programs) return refuse(provider, 'solana', '-', 'No allowlisted programs for this bridge on Solana')
    const { own, also = [] } = programs
    // Previews name the tool, so they're refused like its quote would be.
    if (provider === 'lifi' && quote.track.bridge !== 'dflow') {
      return refuse(provider, 'solana', quote.track.bridge ?? '-', `LI.FI's routes from Solana can't be checked, but for DFlow's swaps (this one: ${quote.via ?? quote.track.bridge ?? 'unnamed'})`)
    }
    let [lamports, tokens] = [0n, 0n]
    for (const s of steps) {
      if (s.kind !== 'solana') return refuse(provider, 'solana', s.kind, `Unexpected ${s.kind} step on Solana`)
      const m = solanaMessage(s.transaction)
      if (!m) return refuse(provider, 'solana', 'unreadable', "Couldn't read the route's Solana transaction")
      if (m.payer !== req.sender) return refuse(provider, 'solana', m.payer, `The Solana transaction is paid by ${m.payer}, not the sender`)
      // Other programs only where they can't change anything: LI.FI adds one that only reads the clock (an expiry check).
      for (const { program, writes } of m.instructions) {
        if (!SOLANA_COMMON.has(program) && !own.includes(program) && !also.includes(program) && writes) {
          return refuse(provider, 'solana', program, `Unrecognized program ${program} on Solana`)
        }
      }
      const out = walletOutflow(m, req.fromToken)
      if (typeof out === 'string') return refuse(provider, 'solana', out, out)
      lamports += out.lamports
      tokens += out.tokens
      // One of only transfers would pay whoever the provider names.
      if (!m.instructions.some((ix) => own.includes(ix.program))) return refuse(provider, 'solana', 'transfer', "The Solana transaction doesn't call the bridge's programs")
    }
    if (lamports > (native ? req.amount : 0n) + SOLANA_FEES) {
      return refuse(provider, 'solana', 'lamports', `Sends ${formatUnits(lamports, 9)} SOL from the wallet, more than the transfer and its fees`)
    }
    if (tokens > req.amount) return refuse(provider, 'solana', 'tokens', 'Transfers more than the amount from the wallet')
    return
  }

  if (from.kind === 'hypercore') {
    if (provider !== 'relay') return refuse(provider, from.id, '-', `Unexpected route from ${from.name}`)
    const sends = steps.filter((s) => s.kind === 'hyperliquid')
    if (sends.length > 1 || steps.filter((s) => s.kind === 'signature').length > 1) return refuse(provider, from.id, 'steps', `More than one transfer from ${from.name}`)
    for (const s of steps) {
      if (s.kind === 'signature') {
        if (nonceMapping(s, req.sender, sends[0]?.nonce)) continue
        return refuse(provider, from.id, 'signature', `Unrecognized signature from ${from.name}`)
      }
      if (s.kind !== 'hyperliquid') return refuse(provider, from.id, s.kind, `Unexpected ${s.kind} step from ${from.name}`)
      const a = s.action as { type: string; destination?: string; token?: string; amount?: string; nonce?: number }
      if (a.type !== 'sendAsset' || s.primaryType !== 'HyperliquidTransaction:SendAsset' || a.destination?.toLowerCase() !== RELAY_HYPERLIQUID || a.token !== HYPERLIQUID_USDC || a.nonce !== s.nonce) {
        return refuse(provider, from.id, a.destination ?? a.type, `Unrecognized ${a.type} transfer from ${from.name}`)
      }
      // A decimal amount of USDC, at most the one sent (6 decimals in the app's terms).
      const [whole, fraction = ''] = (a.amount ?? '').split('.')
      if (!/^\d+$/.test(whole!) || !/^\d{0,6}$/.test(fraction) || BigInt(whole! + fraction.padEnd(6, '0')) > req.amount) {
        return refuse(provider, from.id, 'amount', `Transfers more than the amount from ${from.name}`)
      }
    }
    return
  }
  // Cosmos chains only through Skip, whose messages are checked as its quote is read (checkCosmos): the steps carry them encoded.
  if (from.kind === 'cosmos') return provider === 'skip' ? undefined : refuse(provider, from.id, '-', `Unexpected route from ${from.name}`)
  return refuse(provider, from.id, '-', `Sending from ${from.name} isn't supported`)
}

// A reason to refuse Skip's messages from a Cosmos chain (its JSON, which ./cosmos.ts encodes for the wallet), or undefined
// when they move only the token sent, at most the amount in all: IBC transfers, CCTP burns, calls to Skip's entry point
// there and sends to its relayer's fees. Receivers and memos aren't checked, as calldata recipients aren't on EVM chains.
export function checkCosmos(req: QuoteRequest, denom: string, msgs: { msg_type_url: string; msg: string }[]): string | undefined {
  const chain = req.from.cosmosId ?? req.from.id
  let total = 0n
  for (const { msg_type_url: type, msg } of msgs) {
    const f = JSON.parse(msg) as Record<string, any>
    const coins =
      type === '/ibc.applications.transfer.v1.MsgTransfer'
        ? [f.token]
        : type === '/circle.cctp.v1.MsgDepositForBurn' || type === '/circle.cctp.v1.MsgDepositForBurnWithCaller'
          ? [{ denom: f.burn_token, amount: f.amount }]
          : type === '/cosmwasm.wasm.v1.MsgExecuteContract' && f.contract === SKIP_ENTRY[chain]
            ? (f.funds ?? [])
            : type === '/cosmos.bank.v1beta1.MsgSend' && chain === 'noble-1' && f.to_address === SKIP_NOBLE_FEES
              ? (f.amount ?? [])
              : undefined
    if (!Array.isArray(coins)) {
      const to = f.contract ?? f.to_address
      return refuse('skip', chain, String(to ?? type), `Unrecognized ${type.split('.').pop()}${to ? ` to ${to}` : ''} on ${req.from.name}`)
    }
    for (const c of coins as { denom?: unknown; amount?: unknown }[]) {
      if (c?.denom !== denom) return refuse('skip', chain, String(c?.denom), `Sends another token (${c?.denom}) from ${req.from.name}`)
      if (typeof c.amount !== 'string' || !/^\d+$/.test(c.amount)) return refuse('skip', chain, 'amount', `Invalid amount in the route from ${req.from.name}`)
      total += BigInt(c.amount)
    }
  }
  if (total > req.amount) return refuse('skip', chain, 'amount', `Sends more than the amount from ${req.from.name}`)
}
