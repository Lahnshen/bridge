import { injectiveAddress } from './address'
import { broadcastCosmosTx, prepareEip712Tx, type CosmosChain, type Eip712Tx, type Step } from './api'
import { app, injective } from './app.svelte'
import { currentChain, signTypedData, switchChain, wallet } from './wallet.svelte'

// Injective's Cosmos side signed by the EVM wallet: Injective takes a Cosmos transaction signed as EIP-712 typed data
// (SIGN_MODE_EIP712_V2), so routes that start there (Skip's swaps over Helix, IBC transfers) need no Keplr. The server
// builds the transaction and its typed data, the wallet signs that, and the server broadcasts it with the wallet's key,
// recovered from the signature (see backend/src/cosmos.ts).

type CosmosStep = Extract<Step, { kind: 'cosmos' }>

const WEB3_EXTENSION = '/injective.types.v1beta1.ExtensionOptionsWeb3Tx'
const TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'string' },
  ],
  Tx: [
    { name: 'context', type: 'string' },
    { name: 'msgs', type: 'string' },
  ],
}
const domain = (chainId: number) => ({ name: 'Injective Web3', version: '1.0.0', chainId: `0x${chainId.toString(16)}`, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC', salt: '0' })

// Wallets refuse typed data whose domain is for another chain than the one they're on, and Injective takes Ethereum's
// and Injective EVM's: the wallet signs where it is if that's either, else it's switched to Injective EVM.
async function signingChain(progress: (label: string) => void) {
  const ethereum = app.config?.network === 'testnet' ? 11155111 : 1
  const chainId = await currentChain()
  if (chainId === ethereum || chainId === injective().chainId) return chainId
  progress(`Switching to ${injective().name}…`)
  await switchChain(injective())
  return injective().chainId
}

// The transaction's body as the server must have built it: the step's messages and memo, and the Web3 extension.
const varint = (n: number) => {
  const out: number[] = []
  for (; n > 127; n = Math.floor(n / 128)) out.push((n % 128) | 128)
  return [...out, n]
}
const field = (key: number, bytes: number[]) => [...varint(key), ...varint(bytes.length), ...bytes]
const text = (value: string) => [...new TextEncoder().encode(value)]
const bytes = (value: string) => [...Uint8Array.from(atob(value), (c) => c.charCodeAt(0))]
function bodyOf(step: CosmosStep, chainId: number) {
  const any = (typeUrl: string, value: number[]) => [...field(0x0a, text(typeUrl)), ...field(0x12, value)]
  return [
    ...step.messages.flatMap((m) => field(0x0a, any(m.typeUrl, bytes(m.value)))),
    ...(step.memo ? field(0x12, text(step.memo)) : []),
    ...field((1023 << 3) | 2, any(WEB3_EXTENSION, [0x08, ...varint(chainId)])),
  ]
}

// What the wallet is asked to sign is this step's transaction and nothing else: the Injective domain at the wallet's chain,
// a context for this account on Injective, and the step's messages. The chain checks the signature against typed data it
// rebuilds from the body's protobuf, so a signature only counts for the body it was made for: the body has to be exactly
// the step's messages (checked byte for byte), and the msgs shown to the user name the same messages, from the signer.
function check(tx: Eip712Tx, step: CosmosStep, side: CosmosChain, chainId: number) {
  const fail = () => {
    throw new Error('The transaction to sign does not match this route: pick it again.')
  }
  const td = tx.typedData
  if (td.primaryType !== 'Tx' || JSON.stringify(td.types) !== JSON.stringify(TYPES) || JSON.stringify(td.domain) !== JSON.stringify(domain(chainId))) fail()
  if (Object.keys(td.message).join() !== 'context,msgs' || bytes(tx.bodyBytes).join() !== bodyOf(step, chainId).join()) fail()
  try {
    const context = JSON.parse(td.message.context) as { chain_id?: string; memo?: string; fee?: { amount?: { denom: string }[] } }
    const msgs = JSON.parse(td.message.msgs) as Record<string, unknown>[]
    const signer = (m: Record<string, unknown>) => m.sender ?? m.from_address
    if (context.chain_id !== side.cosmosId || context.memo !== (step.memo ?? '') || context.fee?.amount?.some((c) => c.denom !== side.gas?.denom)) fail()
    if (msgs.length !== step.messages.length || msgs.some((m, i) => m['@type'] !== step.messages[i]!.typeUrl || signer(m) !== step.signer)) fail()
  } catch {
    fail()
  }
}

// Returns the transaction's hash once the chain took it.
export async function sendWithEvmWallet(side: CosmosChain, step: CosmosStep, progress: (label: string) => void, prompt: string) {
  if (!wallet.address || injectiveAddress(wallet.address) !== step.signer) throw new Error('Your wallet changed accounts: pick the route again.')
  const chainId = await signingChain(progress)
  progress('Preparing the transaction…')
  const tx = await prepareEip712Tx({ chain: side.id, signer: step.signer, messages: step.messages, memo: step.memo, evm: chainId })
  check(tx, step, side, chainId)
  progress(prompt)
  const signature = await signTypedData(tx.typedData)
  progress('Sending…')
  return (await broadcastCosmosTx({ chain: side.id, bodyBytes: tx.bodyBytes, typedData: tx.typedData, signature, signer: step.signer })).txHash
}
