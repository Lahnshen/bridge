# Injective CCTP Bridge

A Circle CCTP bridge for native USDC **to and from Injective**. Users bridge with their browser wallet, and the backend finishes transfers to Injective for them: its relayer wallet mints the USDC on Injective and pays the gas. Anyone can also paste a wallet address or burn tx hash to find a transfer and redeem it.

- `backend/`: Bun + Elysia + viem API. Built to be called by any app.
- `frontend/`: Svelte 5 single page: bridge, track, recent transfers.

## How it works

1. A CCTP transfer burns USDC on the source chain (`depositForBurn` on TokenMessengerV2), Circle attests it, and someone calls `receiveMessage` on the destination chain to mint.
2. **Bridging to Injective:** the UI burns from the user's wallet, then hands the tx to the backend (`POST /redeem`). The backend queues it and mints on Injective as soon as Circle attests (**auto-redeem**), so users need no INJ. From Ethereum and the L2s, users choose Fast (under a minute, a small Circle fee) or Standard (free, ~20 minutes, longer on Linea).
3. **Bridging from Injective:** the burn asks Circle's [Forwarding Service](https://developers.circle.com/cctp/concepts/forwarding-service) to mint on the destination for a fee, so users need no gas there. Users can skip forwarding (or the route may not support it) and claim on the destination with their wallet instead.
4. **Tx hash lookups** find the source chain automatically (by fetching the receipt from every supported EVM chain), then ask Circle's attestation API for the message, and check on the destination chain whether it was already minted.
5. **Address lookups** use a small SQLite index: the backend watches `DepositForBurn` events on every EVM chain and stores the ones to or from Injective (domain 29), keyed by sender and recipient, with each burn's block time. It works with `0x…` and `inj1…` addresses. Once every transfer in a tx is minted, its result is stored too, so a wallet's **history** loads without asking Circle again.
6. **Redeems** are simulated before sending (no gas wasted on reverts), sent one at a time from the relayer key, and deduplicated per message. Expired fast-transfer attestations are re-attested automatically. Queued transfers are retried for 72 hours.

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

All settings are documented in [`backend/.env.example`](backend/.env.example). The defaults use free public RPCs, which are slow and rate limited; set `RPC_<CHAIN>` variables for anything serious.

## Deploy to a VPS

A Cloudflare Tunnel connects the server to Cloudflare from the inside, so your domain points at Cloudflare, never at the server's IP, and no web ports are open. On the server, Caddy (listening on localhost only) serves the UI and proxies `/api/*` to the backend, and systemd keeps everything running. On every push to `main`, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) SSHes into the VPS and runs [`deploy/deploy.sh`](deploy/deploy.sh): pull, install, build the UI, restart, health check.

You need a VPS running Ubuntu 24.04 (or Debian 12), and a domain on Cloudflare (free plan).

**1. Push the repo to GitHub.** Create an empty repo on github.com, then:

```sh
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:<you>/inj-cctp-redeemer.git
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
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart inj-cctp-redeemer' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy
install -d -o deploy -g deploy /opt/inj-cctp-redeemer
ufw allow OpenSSH && ufw --force enable    # SSH only: web traffic comes in through the tunnel
sudo -iu deploy bash -c 'curl -fsSL https://bun.sh/install | bash'
```

Give the server read access to the repo. This prints a public key: add it in the repo under Settings → Deploy keys, with write access off.

```sh
sudo -iu deploy bash -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C vps && ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null && cat ~/.ssh/id_ed25519.pub'
```

Clone, configure and start:

```sh
sudo -iu deploy git clone git@github.com:<you>/inj-cctp-redeemer.git /opt/inj-cctp-redeemer
cd /opt/inj-cctp-redeemer/backend && cp .env.example .env && chown deploy:deploy .env && chmod 600 .env
nano .env    # set RELAYER_PRIVATE_KEY, HOST=127.0.0.1, TRUST_PROXY=true and your RPC_* URLs

cp /opt/inj-cctp-redeemer/deploy/inj-cctp-redeemer.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable inj-cctp-redeemer
cp /opt/inj-cctp-redeemer/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
sudo -iu deploy /opt/inj-cctp-redeemer/deploy/deploy.sh    # first build + start, ends with "Deployed <commit>"
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

From then on, each push to `main` deploys, and you can follow it in the Actions tab. You can also deploy by hand with `sudo -iu deploy /opt/inj-cctp-redeemer/deploy/deploy.sh`.

- **Logs:** `journalctl -u inj-cctp-redeemer -f` (API) and `journalctl -u cloudflared -f` (tunnel). The address index (`backend/cctp.sqlite`) and `.env` are gitignored, so they survive deploys.
- **IP history:** if the domain ever pointed straight at the server with a plain `A` record, DNS-history sites may still list the IP. Moving the server to a new IP (Hetzner: *Primary IPs*) cuts that link.
- **Bots:** leave *Bot Fight Mode* off if other apps call your API from their servers, because it challenges every non-browser client. A WAF rate-limiting rule on `/api/redeem` is the gentler option.

## API

All responses are JSON. Errors look like `{ "error": "message" }`.

| Method | Path | Description |
| - | - | - |
| `GET` | `/chains` | What a bridge UI needs: network, whether auto-redeem is on, the CCTP contracts, and every chain's domain, chain ID, USDC address, public RPC and explorer. |
| `GET` | `/fees/:from/:to` | Route quote by CCTP domain, one side must be Injective: `{ fastBps, forwardFee, standardTime }`. `fastBps` is the Fast Transfer fee in bps of the amount, `forwardFee` the USDC Circle takes to deliver a transfer from Injective, `standardTime` the usual wait for a standard transfer. Each is `null` when it doesn't apply. |
| `GET` | `/balance/:domain/:address` | USDC balance of an address on a chain: `{ "balance": "125.5" }`. |
| `GET` | `/address/:address` | Pending (unredeemed) transfers sent from or to a `0x…` / `inj1…` address. |
| `GET` | `/history/:address?offset=` | Every indexed transfer from or to an address, newest first, 20 txs per page: `{ transfers, next }`. Pass `next` as `offset` for the following page; it's `null` on the last one. |
| `GET` | `/tx/:hash?domain=` | Every transfer to or from Injective in a burn tx. `domain` (CCTP source domain) is optional for EVM chains and Solana; pass it for other non-EVM sources. |
| `POST` | `/redeem` | Body `{ "txHash": "0x…", "domain"?: 6 }`. Mints the tx's transfers to Injective that are ready, and queues the ones still waiting for Circle to be minted automatically. |
| `GET` | `/health` | Network, relayer address and INJ balance, queued transfers, last indexed block per chain. |

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
  "time": 1790000000            // when it was sent (unix seconds), for indexed transfers once the block time is known
}
```

- `pending`: Circle hasn't attested the burn yet (or, from Injective, is still delivering it).
- `ready`: can be minted now. This service mints transfers to Injective; transfers from Injective are claimed on the destination chain with `message` and `attestation`.
- `redeemed`: already minted on the destination chain.
- `restricted`: can't be redeemed by this service. The burn named a different `destinationCaller`, or it's below `MIN_REDEEM_USDC` (then `message` and `attestation` are included, so the recipient can claim it).

`POST /redeem` returns `409` when nothing in the tx is redeemable (already minted, restricted, or a transfer from Injective). It returns `202` when everything left is queued for auto-redeem, and `200` otherwise; each transfer's `status` and `note` say how its attempt went.

Status codes: `400` invalid input, `404` not found / not a transfer to or from Injective, `409` nothing to redeem, `429` rate limited, `502`/`503` upstream (Circle, RPC) or relayer issues.

**Rate limits:** per IP, fixed one-minute windows: `RATE_LIMIT_PER_MINUTE` (default 120) for all requests, and a separate `REDEEM_LIMIT_PER_MINUTE` (default 5) for `POST /redeem`. Every response includes `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Calls to Circle are also paced globally so the server never trips Circle's own limit.

The UI also accepts deep links: `https://your-ui/?q=<address or tx hash>`.

## Notes

- Address search and history only cover what the indexer has seen: history from `INDEX_LOOKBACK_HOURS` before the first start, then everything going forward. Tx hash lookups work for any transfer, any age.
- Bridge and indexed EVM chains: Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Unichain, Linea, Codex, Sonic, World Chain, Monad, Sei, XDC, HyperEVM, Ink, Plume, Arc, Morph, Cronos, Plasma, X Layer. Solana burns to Injective work by tx signature. Other sources (Sui, Aptos, Starknet, Stellar, EDGE, Pharos) can be looked up and redeemed through the API by passing their CCTP `domain`.
- Circle's Forwarding Service delivers from Injective, not to it: transfers to Injective rely on this service's relayer (or the recipient claiming with their own wallet when `RELAYER_PRIVATE_KEY` is unset).
- Keep the relayer wallet funded with a small amount of INJ. A standard mint costs about 350k gas (~0.00006 INJ at current prices). `GET /health` shows the balance.
