# Finestra 🪟

A simple, **read-only Handshake (HNS) block explorer** that runs as an
[umbrelOS](https://umbrel.com) app and reads all of its data from **your own
node** — the [Bob DNS](https://github.com/galetaire/bob-dns) app — over your
Umbrel's internal network. Nothing leaves your machine, and there is no second
blockchain to sync.

What it shows:

- **Dashboard** — time since the last block, mempool, hashrate, difficulty, next
  tree update, supply and burned coins, peers, latest blocks and recent name
  activity. It refreshes by itself.
- **Names & auctions** — auction state (OPENING / BIDDING / REVEAL / CLOSED),
  owner, highest bid, price paid, renewal and expiry countdowns, and the DNS
  records published on a name.
- **Blocks** — every block, with transactions, inputs, outputs, size, fees,
  miner reward and name activity.
- **Auction list** — every running auction, by stage (opening, bidding, reveal),
  with bids, lockups and time left. Sort by any column, or filter by ASCII or IDN.
- **Mempool** — pending transactions, their size and fees.
- **Transactions** — inputs, outputs, values, fees, and Handshake covenants
  (OPEN / BID / REVEAL / REGISTER / UPDATE / TRANSFER …) with their names.
- **Addresses** — balance, coins locked in names, names held, and transaction
  history (Bob runs its node with the address and transaction indexes enabled,
  so this works out of the box).

Some figures other explorers show need an index of the whole chain, so Finestra
doesn't have them: total names, total addresses, locked coins, and a list of
closed auctions. Prices would mean calling an outside service, so there are none.

Running auctions are different: one can't be older than about 15 days, so
Finestra reads that many blocks when the Names page is first opened, then only
new ones. This list is kept in memory, so it's read again after a restart.

## How it works

```
┌─────────────────────────┐        Docker network         ┌──────────────────────┐
│  Bob DNS app            │                                │  Finestra app         │
│  (bob-wallet)          │  read-only node proxy :3100    │  (finestra-explorer) │
│                        │ ◀───────────────────────────── │                      │
│  hsd full node         │   whitelisted, read-only,      │  server.js → /api/*  │
│  (indexed, 127.0.0.1)  │   source-restricted to Finestra│  static explorer UI  │
│  wallet API (private)  │                                │                      │
└─────────────────────────┘                                └──────────────────────┘
```

Bob runs `hsd` embedded, with its node and wallet HTTP APIs bound to
`127.0.0.1` inside its container. For Finestra, Bob opens **one** extra door on
the Docker network (`bob-wallet_server_1:3100`) that is:

- **read-only** — only non-mutating node methods/paths are forwarded;
- **node-only** — it never exposes the wallet API or the Umbrel-login-protected UI;
- **source-restricted** — only the `finestra-explorer_server_1` container may connect;
- **key-free for Finestra** — Bob injects its own node API key, so Finestra never sees it.

See `docker/web/node-proxy.js` in the
[bob-dns](https://github.com/galetaire/bob-dns) repo for that side.

## Requirements

- The **Bob DNS** app, version `2.3.19-web.4` or later. Finestra declares it as
  a dependency.
- Bob in full-node mode, which is not its default. In SPV mode only name lookups
  work, and only once Bob has finished syncing. Finestra says so.

## Install

1. In umbrelOS, add both community app stores (Settings → App store → the `…`
   menu → *Add app store*):
   - `https://github.com/galetaire/bob-dns`
   - `https://github.com/galetaire/finestra`
2. Install **Bob DNS** and let it sync (full-node mode).
3. Install **Finestra** and open it.

## Project layout

```
umbrel-app-store.yml              # community app store manifest (id: finestra)
finestra-explorer/
  umbrel-app.yml                  # the app manifest (depends on bob-wallet)
  docker-compose.yml              # app_proxy + the server container
  icon.png, gallery/              # store artwork  (add your own)
docker/
  Dockerfile                      # tiny Node image, no third-party deps
  app/
    server.js                     # serves the UI, forwards /api/* to Bob's proxy,
                                  # and gathers and caches dashboard data
    public/                       # the explorer UI (vanilla JS, no build step)
.github/workflows/build-image.yml # builds ghcr.io/galetaire/finestra on push to main
```

## Develop / run locally

The server is plain Node (needs Node 20+ for global `fetch`) and has no
dependencies. Point it at any hsd-compatible read endpoint:

```bash
cd docker/app
# BOB_NODE_PROXY_URL defaults to http://bob-wallet_server_1:3100 (only resolvable on Umbrel).
BOB_NODE_PROXY_URL=http://localhost:3100 PORT=3000 node server.js
# open http://localhost:3000
```

`GET /api/health` reports whether the node is reachable. The UI degrades
gracefully (a red "node unreachable" chip) when it is not.

## Releasing

The image tag follows `finestra-explorer/umbrel-app.yml`'s `version`. Bump that
version, commit, and push to `main`; the workflow builds and pushes
`ghcr.io/galetaire/finestra:<version>` (amd64 + arm64 + `latest`). Keep the
`image:` tag in `finestra-explorer/docker-compose.yml` in step with it.

## Still to add

- `finestra-explorer/icon.png` and `gallery/1.png … 3.png` (store artwork).
- Make the GHCR package public after the first build so Umbrel can pull it.

## License

MIT — see [LICENSE](LICENSE).
