# Lahn Bridge

A bridge between **170+ networks**, built around **Injective**. It moves native USDC with Circle CCTP between 26 chains, and any token through LI.FI, Skip Go, deBridge, Relay, Across, USDT0 and LayerZero, to every chain they reach: EVM chains, Solana, ~85 Cosmos chains, Hyperliquid, and as destinations Bitcoin, Tron, Sui, TON, XRP, Zcash, Eclipse and Lighter. Users sign with their own wallets: EVM wallets (EIP-6963, which also sign Hyperliquid's transfers), Solana wallets (Wallet Standard) and Cosmos wallets (Keplr, Leap, Cosmostation). For USDC to Injective, the backend finishes transfers itself: its relayer wallet mints the USDC on Injective and pays the gas, so users need no INJ, and they can then swap some of it to INJ, gas free too. Anyone can paste a wallet address or burn tx hash to find a CCTP transfer, pending or completed, and redeem it.

The app is provided as is, without warranty. Its [Terms of Use](frontend/src/lib/components/Terms.svelte) are at `/terms`, and each browser accepts them once before its first transfer or swap.

- `backend/`: Bun + Elysia + viem API. Built to be called by any app.
- `frontend/`: Svelte 5 single page: bridge, get INJ, track, recent transfers, terms.

## How it works

1. A CCTP transfer burns USDC on the source chain (`depositForBurn` on TokenMessengerV2), Circle attests it, and someone calls `receiveMessage` on the destination chain to mint.
2. **Bridging to Injective** (the default route): the UI burns from the user's wallet, then hands the tx to the backend (`POST /redeem`). The backend queues it and mints on Injective as soon as Circle attests (**auto-redeem**), so users need no INJ. Where Circle offers it, users choose Fast (under a minute, a small Circle fee) or Standard (free, ~20 minutes on most chains, longer on Linea).
3. **Bridging anywhere else** (from Injective, or between any two other chains): the burn asks Circle's [Forwarding Service](https://developers.circle.com/cctp/concepts/forwarding-service) to mint on the destination for a fee, so users need no gas there. To EVM chains users can skip forwarding and claim with their wallet instead. To Solana it's always forwarded; when the recipient has no USDC account yet, the burn asks Circle to create it (`includeRecipientSetup`) and the fee covers that too.
4. **Solana** works without a Solana SDK: the UI builds the `deposit_for_burn` transaction itself, a Wallet Standard wallet (Phantom, Solflare, Backpack…) signs it, and the backend relays only a few read/send RPC methods (`POST /solana`). Recipients on Solana get the USDC in their associated token account. A burn costs about 0.003 SOL, mostly rent for the event account CCTP creates.
5. **Tx hash lookups** find the source chain automatically (by fetching the receipt from every supported EVM chain, then Solana), then ask Circle's attestation API for the message, and check on the destination chain whether it was already minted. They work for any route.
6. **Address lookups** (Track) use a small SQLite index: the backend watches `DepositForBurn` events on every EVM chain, keyed by sender and recipient, with each burn's block time. Burns to or from Injective are kept for good; burns between two other chains for 30 days. It works with `0x…`, `inj1…` and Solana addresses, and shows completed transfers as well as pending ones.
7. **Wallet history** (the UI's Recent list, once a wallet is connected) comes from Injective, which sees both sides of every transfer: burns leaving it, and `MessageReceived` for every mint arriving. Both are indexed back to CCTP's deployment on Injective (block 158,605,712, March 2026). The first start backfills that in the background, which takes 20–30 minutes on the public RPC; `GET /health` shows how far it got (`historyFromBlock`). Circle supplies a mint's source tx by nonce when it's first shown, and finished transfers are stored, so history pages don't ask Circle again.
8. **Redeems** are simulated before sending (no gas wasted on reverts), sent one at a time from the relayer key, and deduplicated per message. Expired fast-transfer attestations are re-attested automatically. Queued transfers are retried for 72 hours.
9. **Get INJ** swaps USDC on Injective to INJ without the user paying gas. The wallet signs an EIP-3009 `ReceiveWithAuthorization` (a message, not a transaction) that lets only the relayer pull that much USDC. The relayer then pulls it, buys INJ with a market order on Injective's [INJ/USDC orderbook](https://injscan.com/market/0xa8c14f892f7f7d2516442220a05b652d5afee3f57a5495981dfad7c99ef78e84) through the exchange precompile, sends the INJ to the user, and sends back any USDC the order didn't use. Before pulling anything, the backend checks the book again against the user's minimum (quote − 0.5%); the order then pays at most 0.2% above that book, and whatever doesn't fill comes back as USDC. Each swap is stored, so after a restart the backend finishes it or refunds the USDC.
10. **Other bridges and tokens:** the Bridge tab takes any token, and asks every other bridge for a quote at once (`POST /quotes`). The routes are listed next to CCTP, best first: the most delivered, less 0.01% of the amount for each minute of waiting, so a route a few cents better but twenty minutes slower doesn't win. Injective is served by LI.FI, Skip Go, deBridge and LayerZero; Relay, Across and USDT0 don't reach it, so they only show up between other chains. Before sending, the chosen route is quoted again with the real addresses and refused if it got more than 0.5% worse. The user's wallet signs the bridge's transactions (an exact-amount approval first when the allowance is short), the bridge delivers, and the UI follows it with `POST /quotes/status`. This service adds no fee of its own. Tokens come from the bridges' lists (LI.FI's where LI.FI reaches the chain, less the tokens it flags; Skip's on Cosmos chains; else Relay's, LayerZero's, Skip's or deBridge's), refreshed every 6 hours, with each chain's popular ones first; any other EVM or Solana token is found by pasting its contract address or mint, read on-chain and marked unverified.
11. **Every chain the bridges reach:** the backend builds its chain list from the bridges' own lists, plus [cosmos.directory](https://cosmos.directory) for Cosmos chains' endpoints, gas prices and explorers, and refreshes it every 6 hours (`networks` in `GET /chains`). Each chain has an id (`osmosis`, `bitcoin`…) and keeps every bridge's own id for it. The app sends from EVM chains, Solana, Cosmos chains and Hyperliquid (through Relay: the EVM wallet signs two messages, at whatever chain it's on, and no gas is needed); the others are destinations only. Lighter is one: sending from it needs a Lighter API key and Lighter's own signer. Before asking for quotes, the UI checks that some bridge reaches both chains and says *Route not available* when none does. When the bridges have no route for the tokens or amount, it says so too, with their reasons (an amount too small for the fees, say).
12. **Cosmos chains** go through Skip Go, which returns the messages to sign (IBC transfers, CosmWasm calls, CCTP burns). The backend encodes them as protobuf, looks up the account, simulates the transaction for its gas (plus 50%), and sets the fee from the chain's gas price (`POST /cosmos/prepare`). The wallet signs it (`SIGN_MODE_DIRECT`), and the backend broadcasts it (`POST /cosmos/broadcast`) and follows it (`GET /cosmos/tx/:chain/:hash`). A route through other chains needs the user's address on each, in case the transfer stops there. The backend derives it where one key gives the same account (EVM chains; Cosmos chains of one key type; `inj1…` from `0x…`), and otherwise the UI asks the Cosmos wallet for it. Ledger accounts in Keplr only sign Amino JSON, which the app doesn't build, so they can't send from Cosmos chains here.

## Run it

Needs [Bun](https://bun.sh) 1.3+.

```sh
# API
cd backend
bun install
cp .env.example .env      # set RELAYER_PRIVATE_KEY (an Injective EVM key with some INJ)
bun dev                   # http://localhost:3000

# UI
cd frontend
bun install
bun dev                   # http://localhost:5173, expects the API at http://localhost:3000
```

For production, see [Deploy to a VPS](#deploy-to-a-vps) below. Anywhere else: `bun start` in `backend/`, and `VITE_API_URL=https://your-api bun run build` in `frontend/`, then serve `frontend/dist` as static files. Set `NETWORK=testnet` to run against Injective testnet and the testnet source chains.

All settings are documented in [`backend/.env.example`](backend/.env.example). The defaults use free public RPCs, which are slow and rate limited; set `RPC_<CHAIN>` variables for anything serious (and `REST_<CHAIN>` for Cosmos chains you expect traffic on). Set `LIFI_API_KEY` and `SKIP_API_KEY` in production: without them, all users share those bridges' small anonymous rate limits.

## Deploy to a VPS

A Cloudflare Tunnel connects the server to Cloudflare from the inside, so your domain points at Cloudflare, never at the server's IP, and no web ports are open. On the server, Caddy (listening on localhost only) serves the UI and proxies `/api/*` to the backend, and systemd keeps everything running. On every push to `main`, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) SSHes into the VPS and runs [`deploy/deploy.sh`](deploy/deploy.sh): pull, install, build the UI, restart, health check.

You need a VPS running Ubuntu 24.04 (or Debian 12), and a domain on Cloudflare (free plan).

**1. Push the repo to GitHub.** Create an empty repo on github.com, then:

```sh
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:<you>/bridge.git
git push -u origin main
```

Pushing over HTTPS with a personal access token? It needs the `workflow` scope, or GitHub rejects `.github/workflows/deploy.yml`.

**2. Set up the VPS once.** As root:

```sh
apt update && apt install -y git curl unzip ufw gpg sudo debian-keyring debian-archive-keyring apt-transport-https
# Caddy from its own repo (the Ubuntu/Debian package is too old for deploy/Caddyfile)
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

useradd -m -s /bin/bash deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart bridge' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy
install -d -o deploy -g deploy /opt/bridge
ufw allow OpenSSH && ufw --force enable    # SSH only: web traffic comes in through the tunnel
sudo -iu deploy bash -c 'curl -fsSL https://bun.sh/install | bash'
```

Give the server read access to the repo. This prints a public key: add it in the repo under Settings → Deploy keys, with write access off.

```sh
sudo -iu deploy bash -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C vps && ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null && cat ~/.ssh/id_ed25519.pub'
```

Clone, configure and start:

```sh
sudo -iu deploy git clone git@github.com:<you>/bridge.git /opt/bridge
cd /opt/bridge/backend && cp .env.example .env && chown deploy:deploy .env && chmod 600 .env
nano .env    # set RELAYER_PRIVATE_KEY, HOST=127.0.0.1, TRUST_PROXY=true and your RPC_* URLs

cp /opt/bridge/deploy/bridge.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable bridge
cp /opt/bridge/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
sudo -iu deploy /opt/bridge/deploy/deploy.sh    # first build + start, ends with "Deployed <commit>"
```

**3. Connect the domain with a Cloudflare Tunnel.** In the Cloudflare dashboard:

1. **Networking → Tunnels → Create a tunnel** (Cloudflared). Name it, pick Debian/Ubuntu, and run the install command it shows on the VPS. The tunnel then shows as *Healthy*.
2. In the tunnel, **Routes → Add route → Published application**: subdomain `redeem`, your domain, service URL `http://127.0.0.1:8080`. Delete any existing DNS record for that name first; Cloudflare creates the tunnel's record itself.

The site is now live at `https://redeem.yourdomain.com`, with the API at `https://redeem.yourdomain.com/api`.

**4. Deploy on every push.** On your computer, make a key that GitHub Actions uses to log in as `deploy`, and install it on the VPS:

```sh
ssh-keygen -t ed25519 -N "" -C github-actions -f gh-deploy
cat gh-deploy.pub | ssh root@<vps-ip> 'install -d -m 700 -o deploy -g deploy /home/deploy/.ssh && cat >> /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys'
ssh-keyscan <vps-ip> > gh-known-hosts
```

Then in the GitHub repo, go to Settings → Secrets and variables → Actions and add:

| Secret | Value |
| - | - |
| `SSH_HOST` | the VPS IP (SSH doesn't go through the tunnel) |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | contents of `gh-deploy` (the private key) |
| `SSH_KNOWN_HOSTS` | contents of `gh-known-hosts` |

From then on, each push to `main` deploys, and you can follow it in the Actions tab. You can also deploy by hand with `sudo -iu deploy /opt/bridge/deploy/deploy.sh`.

- **Logs:** `journalctl -u bridge -f` (API) and `journalctl -u cloudflared -f` (tunnel). The address index (`backend/cctp.sqlite`) and `.env` are gitignored, so they survive deploys.
- **IP history:** if the domain ever pointed straight at the server with a plain `A` record, DNS-history sites may still list the IP. Moving the server to a new IP (Hetzner: *Primary IPs*) cuts that link.
- **Bots:** leave *Bot Fight Mode* off if other apps call your API from their servers, because it challenges every non-browser client. A WAF rate-limiting rule on `/api/redeem` is the gentler option.

## API

All responses are JSON. Errors look like `{ "error": "message" }`.

| Method | Path | Description |
| - | - | - |
| `GET` | `/chains` | What a bridge UI needs: network, whether auto-redeem and swaps are on, the CCTP contracts, every CCTP chain's domain, chain ID, USDC address, public RPC and explorer, and Solana's programs and USDC mint. `networks` lists every chain the bridges reach: `id`, `kind` (`evm`, `solana`, `cosmos`, `bitcoin`…), `name`, `logo`, `explorer` (a tx link with `{tx}` for the hash), `native` (the gas token), `via` (the bridges that reach it) and `send` (whether the app sends from it), plus `domain` and `usdc` where CCTP reaches it, `chainId` and a public `rpc` on EVM chains, and on Cosmos chains `cosmosId`, `bech32`, `slip44`, public `rest` and `rpc`, and `gas`. Gzipped when the client accepts it. |
| `GET` | `/fees/:from/:to?recipientSetup=` | Route quote by CCTP domain, for any two supported chains: `{ fastBps, forwardFee, standardTime }`. `fastBps` is the Fast Transfer fee in bps of the amount, `forwardFee` the USDC Circle takes to deliver it (never to Injective, where this service mints), `standardTime` the usual wait for a standard transfer. Each is `null` when it doesn't apply. `recipientSetup=true` (to Solana) includes creating the recipient's USDC account. |
| `GET` | `/balance/:chain/:address?token=` | USDC balance of an address on a CCTP chain (by id or domain): `{ "balance": "125.5" }`. With `token` (a contract, a Solana mint, a Cosmos denom, or the gas token, below), that token's balance in base units on any EVM, Solana or Cosmos chain: `{ "raw": "1250000" }`. On Hyperliquid that's the USDC the account can send: free spot USDC for unified accounts, otherwise what perps can withdraw. |
| `GET` | `/tokens/:chain?q=` | Tokens to bridge on a chain (by id): `{ popular, tokens }`, each `{ chain, address, symbol, name, decimals, logo?, priceUsd?, verified }`. `q` searches symbols and names, or looks up an address, mint or denom (EVM contracts and Solana mints that aren't listed are read on-chain, then `verified: false`). |
| `POST` | `/quotes` | Routes from the other bridges, best (most delivered) first. Body: `{ from, to, fromToken, toToken, amount, sender?, recipient?, addresses?, slippageBps?, providers? }`: chain ids (or CCTP domains), token addresses in each chain's terms (`0x0000…0000` for an EVM chain's gas token, `1111…1111` for SOL, denoms like `uosmo` or `ibc/…` on Cosmos chains), `amount` in base units, `slippageBps` (how far below its quote a route may deliver) from 1 to 500, 50 by default, `providers` to ask only some. `addresses` maps chain ids to the user's addresses there, for routes that pass through those chains. Without `sender` it's a price preview with no transactions. Returns `{ quotes, errors }`; each quote has `provider`, `via` (the bridge underneath, if any), `amountOut`, `minAmountOut`, `seconds`, `feeUsd` (taken from the amount), `costUsd`/`costNative` (paid on top), `usdIn`/`usdOut` (the amounts sent and delivered in USD, as the bridge prices them; Across doesn't), the `steps` to sign in order (`approve`, `evm`, `solana` or `cosmos`; from Hyperliquid, `signature`, typed data to sign and POST to the bridge, then `hyperliquid`, an action to sign and POST to Hyperliquid's `/exchange`), `needs` (chain ids where the route needs one of the user's addresses before it has steps: ask again with them in `addresses`), and `track`, the ids `/quotes/status` needs. Sending from a chain the app can't sign on is a `400`. |
| `POST` | `/quotes/status` | Body `{ provider, txHash, from, to, track }` (chain ids) for a transfer sent with a quote's steps: `{ status, destinationTx?, amountOut?, note? }`, with `status` one of `pending`, `done`, `failed`, `refunded`. |
| `POST` | `/cosmos/prepare` | Body `{ chain, signer, pubKey, algo?, messages, memo? }`: a quote's `cosmos` step plus the wallet's public key (base64). Returns the transaction to sign, `{ chainId, accountNumber, bodyBytes, authInfoBytes, fee }`, its gas simulated and its fee set at the chain's gas price. |
| `POST` | `/cosmos/broadcast` | Body `{ chain, bodyBytes, authInfoBytes, signature }` (base64, as the wallet signed them): broadcasts it and returns `{ txHash }`, or `400` with the chain's reason when it refuses it. |
| `GET` | `/cosmos/tx/:chain/:hash` | A Cosmos transaction's outcome: `{ status }`, one of `pending`, `success` or `failed` (with `error`). |
| `GET` | `/address/:address` | Pending (unredeemed) transfers sent from or to a `0x…`, `inj1…` or Solana address. |
| `GET` | `/history/:address?offset=` | Every transfer from or to an address, newest first, 20 per page: `{ transfers, next }`. Pass `next` as `offset` for the following page; it's `null` on the last one. A mint whose source tx Circle couldn't name yet has an empty `txHash`. |
| `GET` | `/tx/:hash?domain=` | Every transfer in a burn tx (EVM tx hash or Solana signature). `domain` (CCTP source domain) is optional for EVM chains and Solana; pass it for other non-EVM sources. |
| `POST` | `/redeem` | Body `{ "txHash": "0x…", "domain"?: 6 }`. Mints the tx's transfers to Injective that are ready, and queues the ones still waiting for Circle to be minted automatically. |
| `GET` | `/swap/quote?amount=` | USDC → INJ quote from the live orderbook: `{ amount, inj, minInj, price, to, domain }`. `to` is the relayer (the authorization's recipient), `domain` the EIP-712 domain of USDC on Injective. |
| `POST` | `/swap` | Body: the signed `ReceiveWithAuthorization` (`from`, `to`, `value`, `validAfter`, `validBefore`, `nonce`, `signature`) plus `minInj` from the quote. Returns `{ status, inj, refund, txHash, txUrl }`: `200` with `status: "done"`, or `202` with `"pending"` when the fill takes longer (the backend still finishes it). `409` when the price moved below `minInj`; nothing is pulled then. |
| `POST` | `/solana` | JSON-RPC to Solana for the UI, limited to `getLatestBlockhash`, `sendTransaction`, `getSignatureStatuses` and `getAccountInfo`. |
| `GET` | `/health` | Network, relayer address and INJ balance, queued transfers, last indexed block per chain, and how far back Injective's history is indexed. |

Lookups and redeems return `{ "transfers": Transfer[] }`:

```jsonc
{
  "sourceDomain": 6,
  "sourceChain": "Base",
  "destinationDomain": 29,
  "destinationChain": "Injective",
  "txHash": "0x…",
  "txUrl": "https://basescan.org/tx/0x…",
  "nonce": "0x…",               // CCTP message nonce (missing until Circle sees the burn)
  "amount": "125.5",            // USDC burned
  "fee": "0.016",               // USDC Circle kept (fast transfer or forwarding fee), once attested
  "sender": "0x…",
  "recipient": "0x…",           // who receives the USDC on the destination chain
  "status": "ready",            // pending | ready | redeemed | restricted
  "note": "…",                  // human readable detail for pending / restricted / failed redeems
  "redeemTx": "0x…",            // mint tx on the destination chain, when known
  "redeemTxUrl": "https://blockscout.injective.network/tx/0x…",
  "message": "0x…",             // with attestation: lets anyone mint it with receiveMessage (ready only)
  "attestation": "0x…",
  "time": 1790000000            // when it was sent, or minted for transfers to Injective (unix seconds), once indexed
}
```

- `pending`: Circle hasn't attested the burn yet (or, from Injective, is still delivering it).
- `ready`: can be minted now. This service mints transfers to Injective; others are claimed on the destination chain with `message` and `attestation`.
- `redeemed`: already minted on the destination chain.
- `restricted`: can't be redeemed by this service. The burn named a different `destinationCaller`, or it's below `MIN_REDEEM_USDC` (then `message` and `attestation` are included, so the recipient can claim it).

`POST /redeem` returns `409` when nothing in the tx is redeemable (already minted, restricted, or not headed to Injective). It returns `202` when everything left is queued for auto-redeem, and `200` otherwise; each transfer's `status` and `note` say how its attempt went.

Status codes: `400` invalid input, `404` no USDC transfer found, `409` nothing to redeem, `429` rate limited, `502`/`503` upstream (Circle, RPC) or relayer issues.

**Rate limits:** per IP, fixed one-minute windows: `RATE_LIMIT_PER_MINUTE` (default 120) for all requests, and a separate `REDEEM_LIMIT_PER_MINUTE` (default 5) for `POST /redeem` and `POST /swap`. Every response includes `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Calls to Circle are also paced globally so the server never trips Circle's own limit.

The UI also accepts deep links: `https://your-ui/?q=<address or tx hash>` opens Track. The Bridge tab keeps its route in the address bar, so it can be shared: `https://your-ui/bridge?from=arbitrum&to=injective&fromToken=ETH&toToken=INJ`. Chains go by id (`ethereum`, `solana`, `osmosis`, `injective`…, as in `/chains` `networks`). Tokens go by symbol for USDC and the gas token, and by contract address, mint or denom for anything else. A side without a token gets USDC where CCTP reaches the chain, else its gas token.

## Notes

- History covers every transfer that left or reached Injective. Transfers to Injective that were never minted, and Track's address search, only cover what the indexer has seen on the other chains: `INDEX_LOOKBACK_HOURS` before the first start, then everything going forward (for 30 days on routes that don't touch Injective). Tx hash lookups work for any transfer, any age.
- CCTP chains: Injective, Solana, and the EVM chains Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Unichain, Linea, Codex, Sonic, World Chain, Monad, Sei, XDC, HyperEVM, Ink, Plume, Arc, EDGE, Morph, Pharos, Cronos, Plasma and X Layer. Starknet and Stellar's CCTP is left out (they need their own wallets; transfers from them can still be looked up and redeemed through the API by passing their CCTP `domain`), and so are Sui and Aptos (CCTP V1 only) and BNB Smart Chain (CCTP moves USYC there, not USDC). The other bridges reach about 145 more networks, some of these among them (`GET /chains`). Aptos, Stellar, Starknet and IOTA come with LayerZero, so only with `LAYERZERO_API_KEY`.
- Cosmos chains need a REST endpoint to send from: cosmos.directory's proxy by default, which is shared and rate limited (Injective's especially). Set `REST_<CHAIN>` (e.g. `REST_OSMOSIS`, `REST_INJECTIVE_COSMOS`) for the ones you expect traffic on. EVM chains outside CCTP take `RPC_<CHAIN>` the same way (e.g. `RPC_BNB`), for balances and token lookups.
- Circle's Forwarding Service delivers to every chain but Injective: transfers to Injective rely on this service's relayer (or the recipient claiming with their own wallet when `RELAYER_PRIVATE_KEY` is unset).
- Keep the relayer wallet funded with a small amount of INJ, for gas only. A standard mint costs about 350k gas (~0.00006 INJ at current prices), a swap about the same for its (up to) four transactions. The INJ users get comes from their own order, not from the relayer. `GET /health` shows the balance.
- On EVM chains the UI reads balances both from `GET /balance` and straight from the chain's public RPC (listed in `/chains`), and shows whichever answers first. Where the server uses the public RPCs too, its indexer uses up much of their rate limit. Solana balances come from the server only, because Solana's public RPC refuses requests from browsers.
- Other bridges run on mainnet only. Transfers sent through them show in the UI's Recent list on that browser, which follows them to the end; Track's address and tx searches cover CCTP only. LI.FI allows 200 requests per 2 hours without a key, shared by the whole server, so set `LIFI_API_KEY` in production. Skip carries every Cosmos route, and without `SKIP_API_KEY` shares Skip's anonymous rate limit, so set that too. LayerZero needs `LAYERZERO_API_KEY` and is off without it. The other keys raise rate limits (see `backend/.env.example`). A bridge that answers `429` sits out for a minute.
- Swaps run on mainnet only, need `RELAYER_PRIVATE_KEY`, and are capped by `SWAP_MAX_USDC` (default 10,000). The minimum is 1.10 USDC (the market's minimum order is 1 USDC). They go through the orderbook because Injective's swap precompile doesn't accept this USDC yet.
