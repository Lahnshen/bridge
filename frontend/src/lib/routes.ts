import cctpLogo from '../assets/providers/cctp.svg'
import { broadcastCosmosTx, cosmosTxStatus, INJECTIVE, prepareCosmosTx, type Chain, type CosmosChain, type EvmChain, type Hex, type Step, type TypedData } from './api'
import { cosmosKey, signCosmos } from './cosmos-wallet.svelte'
import { encode } from './evm'
import { sendSigned } from './solana'
import { signSolanaTransaction } from './solana-wallet.svelte'
import { call, currentChain, sendTx, signTypedData, switchChain, waitForReceipt, wallet } from './wallet.svelte'

// Bridges other than CCTP: their logos, and running the steps of one of their quotes with the connected wallet.

const files = import.meta.glob<string>('../assets/providers/*.{svg,png,jpg}', { eager: true, query: '?url', import: 'default' })
export const providerLogo = (id: string) => (id === 'cctp' ? cctpLogo : Object.entries(files).find(([path]) => path.split('/').pop()!.split('.')[0] === id)?.[1])

// USDT on Ethereum refuses to change an allowance that isn't zero.
const RESET_FIRST = new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7'])

const base64Bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// eth_signTypedData_v4 wants the domain's own type spelled out, field by field.
const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']]
const withDomainType = (data: TypedData) => ({
  ...data,
  types: { EIP712Domain: DOMAIN_FIELDS.filter(([name]) => name! in data.domain).map(([name, type]) => ({ name, type })), ...data.types },
})

async function postJson<T>(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => undefined)) as T | undefined
  if (!res.ok || !json) throw new Error((json as { message?: string } | undefined)?.message ?? `${new URL(url).host} answered ${res.status}.`)
  return json
}

// A Hyperliquid transfer's hash: its API doesn't return one, but the sender's ledger lists the transfer by its nonce.
async function hyperliquidHash(api: string, user: string, nonce: number) {
  type Update = { hash: string; delta: { nonce?: number } }
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    const updates = await postJson<Update[]>(`${api}/info`, { type: 'userNonFundingLedgerUpdates', user, startTime: Date.now() - 300_000 }).catch(() => [])
    const found = updates.find((u) => u.delta.nonce === nonce)
    if (found) return found.hash
  }
}

// Returns the hash (or Solana signature) of the last transaction: the transfer itself.
export async function runSteps(chain: Chain, steps: Step[], progress: (label: string) => void, devnet = false): Promise<string> {
  let hash: string | undefined
  for (const [i, step] of steps.entries()) {
    const last = i === steps.length - 1
    if (step.kind === 'solana') {
      progress('Confirm the transfer in your wallet…')
      const signed = await signSolanaTransaction(base64Bytes(step.transaction), devnet)
      progress('Sending…')
      hash = await sendSigned(signed)
      continue
    }
    if (step.kind === 'signature' || step.kind === 'hyperliquid') {
      // Hyperliquid isn't an EVM chain: the wallet signs these messages at whatever chain it's on, and says which in them.
      const chainId = await currentChain()
      if (step.kind === 'signature') {
        progress('Sign the authorization in your wallet…')
        const signature = await signTypedData(withDomainType({ ...step.typedData, domain: { ...step.typedData.domain, chainId } }))
        await postJson(`${step.post.url}?signature=${signature}`, { ...step.post.body, signatureChainId: chainId })
        continue
      }
      progress('Confirm the transfer in your wallet…')
      const action = { ...step.action, signatureChainId: `0x${chainId.toString(16)}` }
      const domain = { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' }
      const signature = await signTypedData(withDomainType({ domain, types: step.types, primaryType: step.primaryType, message: action }))
      progress('Sending…')
      const [r, s, v] = [signature.slice(0, 66), `0x${signature.slice(66, 130)}`, parseInt(signature.slice(130, 132), 16)]
      const sent = await postJson<{ status: string; response?: unknown }>(`${step.api}/exchange`, { action, nonce: step.nonce, signature: { r, s, v: v < 27 ? v + 27 : v } })
      if (sent.status !== 'ok') throw new Error(`Hyperliquid refused the transfer: ${typeof sent.response === 'string' ? sent.response : 'try again.'}`)
      progress('Waiting for Hyperliquid…')
      hash = (await hyperliquidHash(step.api, wallet.address!, step.nonce)) ?? step.order
      continue
    }
    if (step.kind === 'cosmos') {
      // The server builds the transaction (and simulates it for the gas), the wallet signs it, the server broadcasts it.
      // From Injective that's on its Cosmos side.
      const cosmos = chain.kind === 'evm' && chain.cosmos ? chain.cosmos : (chain as CosmosChain)
      if (step.chainId !== cosmos.cosmosId) throw new Error('This route sends from another chain, pick it again.')
      progress('Preparing the transaction…')
      const key = await cosmosKey(cosmos)
      if (key.address !== step.signer) throw new Error('Your wallet changed accounts: pick the route again.')
      const tx = await prepareCosmosTx({ chain: cosmos.id, signer: step.signer, pubKey: key.pubKey, algo: key.algo, messages: step.messages, memo: step.memo })
      progress(last ? 'Confirm the transfer in your wallet…' : 'Confirm in your wallet…')
      const signed = await signCosmos(cosmos, step.signer, tx)
      progress('Sending…')
      hash = (await broadcastCosmosTx({ chain: cosmos.id, ...signed })).txHash
      if (!last && !(await cosmosConfirmed(cosmos, hash))) throw new Error('The transaction failed.')
      continue
    }
    const evm = chain as EvmChain
    if (step.chainId !== evm.chainId) throw new Error('This route sends from another chain, pick it again.')
    progress(`Switching to ${evm.name}…`)
    await switchChain(evm)
    const padGas = evm.domain === INJECTIVE
    if (step.kind === 'approve') {
      const allowance = BigInt(await call(step.token, encode.allowance(wallet.address!, step.spender)))
      const amount = BigInt(step.amount)
      if (allowance >= amount) continue
      for (const value of allowance > 0n && RESET_FIRST.has(step.token.toLowerCase()) ? [0n, amount] : [amount]) {
        progress('Approve the token in your wallet…')
        const approval = await sendTx(evm, { to: step.token, data: encode.approve(step.spender, value) }, { padGas })
        progress('Approving…')
        if (!(await waitForReceipt(approval))) throw new Error('The approval failed.')
      }
      continue
    }
    progress(last ? 'Confirm the transfer in your wallet…' : 'Confirm in your wallet…')
    hash = await sendTx(evm, { to: step.to, data: step.data as Hex, value: BigInt(step.value), gas: step.gas ? BigInt(step.gas) : undefined }, { padGas })
    // A route with several transactions sends each once the one before it went through.
    if (!last) {
      progress('Waiting for the transaction…')
      if (!(await waitForReceipt(hash as Hex))) throw new Error('The transaction failed.')
    }
  }
  if (!hash) throw new Error('This route has nothing to send.')
  return hash
}

// Resolves to whether a Cosmos transaction succeeded, once a block has it (blocks take a few seconds).
export async function cosmosConfirmed(chain: CosmosChain, hash: string, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const { status } = await cosmosTxStatus(chain.id, hash).catch(() => ({ status: 'pending' as const }))
    if (status !== 'pending') return status === 'success'
  }
  throw new Error('The transaction is taking a while to confirm, check your wallet.')
}

// "~6 s", "~20 min", "~1.5 h"
export function duration(seconds: number) {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`
  return `~${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} h`
}

export const usd = (value: number) => (value < 0.01 ? '< $0.01' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
