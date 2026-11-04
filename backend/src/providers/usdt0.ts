import { encodeFunctionData, isAddress, pad, parseAbi, type Hex } from 'viem'
import { evmClient, USDT0_MESH, type ChainInfo } from '../chains'
import { network } from '../config'
import { getJson, ProviderError, reaches, type Progress, type Provider, type Step } from './shared'

// USDT0: Tether's omnichain USDT, a LayerZero OFT. No quote API: the source chain's OFT contract quotes and sends.
// https://docs.usdt0.to/technical-documentation/developer. Only the native mesh (USDT0_MESH in ../chains.ts), where
// USDT0 is minted and burned (not on Injective); the legacy mesh's pools to Solana, Tron and TON are left out.

const meshOf = (chain: ChainInfo) => (chain.chainId ? USDT0_MESH[chain.chainId] : undefined)

const abi = parseAbi([
  'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }',
  'struct OFTFeeDetail { int256 feeAmountLD; string description; }',
  'struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }',
  'struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }',
  'function approvalRequired() view returns (bool)',
  'function quoteOFT(SendParam sendParam) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)',
  'function quoteSend(SendParam sendParam, bool payInLzToken) view returns (MessagingFee)',
  'function send(SendParam sendParam, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt, OFTReceipt)',
])

const SCAN = 'https://scan.layerzero-api.com/v1'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// Contract reads don't take a signal: stop waiting once the caller gives up.
const until = <T>(promise: Promise<T>, signal: AbortSignal) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.throwIfAborted()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  ])

// Whether the OFT takes the token with an allowance: Ethereum's adapter locks USDT; elsewhere USDT0 is burned without one.
const approvals = new Map<number, Promise<boolean>>()
function approvalRequired(chain: ChainInfo, oft: Hex) {
  let required = approvals.get(chain.chainId!)
  if (!required) {
    required = evmClient(chain)!.readContract({ address: oft, abi, functionName: 'approvalRequired' })
    approvals.set(chain.chainId!, required)
    required.catch(() => approvals.delete(chain.chainId!))
  }
  return required
}

type ScanMessage = {
  pathway: { srcEid: number; dstEid: number }
  source?: { tx?: { txHash: string; payload?: string } }
  destination?: { tx?: { txHash: string } }
  status: { name: string; message?: string }
}
const FAILED = ['FAILED', 'BLOCKED', 'APPLICATION_BURNED', 'APPLICATION_SKIPPED', 'UNRESOLVABLE_COMMAND', 'MALFORMED_COMMAND']

export const usdt0: Provider = {
  id: 'usdt0',
  name: 'USDT0',
  enabled: network === 'mainnet',
  supports: (from, to) => reaches('usdt0', from, to),

  async quote(req, signal) {
    const [src, dst] = [meshOf(req.from), meshOf(req.to)]
    const client = evmClient(req.from)
    if (!src || !dst || !client || !isAddress(req.recipient, { strict: false })) return
    if (!same(req.fromToken, src.token) || !same(req.toToken, dst.token)) return // USDT0 (USDT on Ethereum) both ends
    const param = { dstEid: dst.eid, to: pad(req.recipient), amountLD: req.amount, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' } as const
    const [[limit, , receipt], fee, approve] = await until(
      Promise.all([
        client.readContract({ address: src.oft, abi, functionName: 'quoteOFT', args: [param] }),
        client.readContract({ address: src.oft, abi, functionName: 'quoteSend', args: [param, false] }),
        approvalRequired(req.from, src.oft),
      ]),
      signal,
    )
    if (req.amount < limit.minAmountLD || req.amount > limit.maxAmountLD) return

    // Shared and local decimals are both 6, so nothing is lost to dust and USDT0 takes no fee: received is the amount.
    const received = receipt.amountReceivedLD
    const min = received - (received * BigInt(req.slippageBps)) / 10_000n
    // A tenth more than quoted, in case destination gas rises before it's sent; the endpoint refunds the rest to the sender.
    const value = (fee.nativeFee * 11n) / 10n
    const chainId = req.from.chainId!
    const steps: Step[] = []
    if (approve) steps.push({ kind: 'approve', chainId, token: src.token, spender: src.oft, amount: req.amount.toString() })
    steps.push({
      kind: 'evm',
      chainId,
      to: src.oft,
      data: encodeFunctionData({ abi, functionName: 'send', args: [{ ...param, minAmountLD: min }, { nativeFee: value, lzTokenFee: 0n }, req.sender as Hex] }),
      value: value.toString(),
    })
    return {
      provider: 'usdt0',
      amountOut: received.toString(),
      minAmountOut: min.toString(),
      seconds: src.seconds ?? 1200, // a newer deployment: about 20 minutes, like most
      feeUsd: Number(receipt.amountSentLD - received) / 1e6,
      // USDT, at a dollar (6 decimals on every chain of the mesh).
      usdIn: Number(req.amount) / 1e6,
      usdOut: Number(received) / 1e6,
      costNative: fee.nativeFee.toString(),
      steps: req.preview ? [] : steps,
      track: {},
    }
  },

  // LayerZero Scan, by source tx: https://docs.layerzero.network/openapi/scan-mainnet.json
  async status({ txHash, to }) {
    const { data } = await getJson<{ data: ScanMessage[] }>(`${SCAN}/messages/tx/${txHash}`).catch((err) => {
      // Scan needs a few seconds to see a new tx.
      if (err instanceof ProviderError && err.status === 404) return { data: [] }
      throw err
    })
    const m = data.find((m) => m.pathway.dstEid === meshOf(to)?.eid) ?? data[0]
    if (!m) return { status: 'pending' }
    const result: Progress = { status: 'pending', destinationTx: m.destination?.tx?.txHash, note: m.status.message }
    if (m.status.name === 'DELIVERED') {
      result.status = 'done'
      // The OFT message is the recipient (32 bytes), then the amount in shared decimals, which are USDT0's own (6).
      const payload = m.source?.tx?.payload
      if (payload && payload.length >= 82) result.amountOut = BigInt(`0x${payload.slice(66, 82)}`).toString()
    } else if (FAILED.includes(m.status.name)) result.status = 'failed'
    return result
  },
}
