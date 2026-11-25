# LimeSwap web app

Single-page dApp for our LimeSwap AMM (`../lime-amm`): browse pools, swap with best-route search,
and add/remove liquidity, on **Testnet** or the **local** network. Vite + vanilla JS,
`@stellar/stellar-sdk` 17.4.0, `@stellar/freighter-api` 6.0.1 (same stack as `watchtower-app`).
Wallets: **Varial** (formerly Freighter) and **MetaMask** (through the community Stellar Snap, Testnet only).

**Design: "Fresh Squeeze"** (Nov 6, 2026). A DEX/AMM layout from Uniswap-style patterns (stacked swap
panels, route, price impact, minimum received, pools table) with its own identity: a lime-slice motif
(logo, spinner, citrus account avatars, success burst), pressable lime buttons, Bricolage Grotesque for
titles and amounts (self-hosted), and warm-then-plain copy ("Freshly squeezed! +11.2 LUSD"). Dark (rind
green) and light (pulp cream) modes, phones down to 320 px with a bottom tab bar, loading skeletons,
reduced-motion support. Design system, Mobbin references and UI rules: [DESIGN.md](DESIGN.md); the two
directions Dimitar chose between: `design-mocks/`; screenshots of every round: `screenshots/` (index there).
The app opens on **Swap** (`#swap`); `#pools` and `#liquidity` link straight to the other tabs.

| Tab | What it shows / does |
|---|---|
| Pools | Fee APR per pool and fees to LPs (last 7 days). LimeFX featured card (oracle price, age with a freshness meter vs the 6-min limit, dynamic fee vs base/max, amp, safety band, circuit breaker) and every factory pool as an expandable row (reserves, price now, 10-min TWAP, compliance / paused / "moving" tags, contract ID, Trade and Add liquidity shortcuts). Refreshes every 10 s. |
| Swap | Token picker (balances, plain notes), slippage in the gear popover. Quotes every route (every direct pool incl. LimeFX, and every multi-hop route of up to 4 pools that never revisits a token, mixing LimeSwap and LimeFX hops, e.g. LIME → XLM → LUSD → LEUR), picks the best, explains fee, price impact and minimum received, shows the best route as a path plus a "Compare routes" list, and a button that names what's missing ("Insufficient LEUR", "Add a LUSD trustline first"), then swaps (router `swap_exact_in` or v2 `swap_route` for mixed routes, deadline now + 5 min, or LimeFX `swap`). |
| Liquidity | Your LP shares and what they're worth, with fees earned, price moves and the result vs holding, owed amounts + Claim, deposit at the pool ratio through the router's `add_liquidity_to` (you sign exactly the amounts you typed; the pool refunds what doesn't fit its ratio; mins 1% below), withdraw by percentage. For a compliance pool it checks your authorization with the regulated token's issuer and explains why a deposit would be blocked before you try. |

## Run

```bash
npm install
npm run dev          # Testnet  → http://localhost:5210  (connect Varial/Freighter on Testnet)
npm run dev:local    # local    → http://localhost:5210  (dev signer, see below)
npm run build        # production build for Testnet (dist/)
npm run smoke        # Node smoke test on local (quotes + small swaps); NETWORK=testnet npm run smoke = quotes only
npm run test:wallet  # MetaMask (Stellar Snap) adapter unit tests, mocked provider, no browser
npm run test:fees    # LP fee earnings maths (src/fees.js), simulated pools, no network
```
In Claude's Browser pane: launch configuration `limeswap-app` (runs `dev:local`).

Addresses come from `../deployed.<net>.json` (RPC, passphrase, explorer) and
`../lime-amm/deployed.<net>.json` (factory, router, tokens, LimeFX), written by `setup.sh` / `deploy.sh`.
After a Testnet reset, re-run those and the app follows.

### Local network checklist
1. `stellar container start local` and `projects/setup.sh local` (if it isn't set up yet).
2. **Start the oracle keeper** (LimeFX refuses prices older than 6 minutes):
   `node ../lime-amm/oracle-keeper.mjs` — every 60 s it posts EUR/USD to the mock oracle
   (`fx.oracle` in `deployed.local.json`) as `lime-owner`, with a ±2 bps random walk, and logs each
   update. `--once` posts one price; `--interval 30` changes the period. It refuses any network but local.
3. `npm run dev:local`.

### Public Testnet demo
**https://limeswap-t2l.pages.dev**: Cloudflare Pages project `limeswap` on Dimitar's Cloudflare
account, branded "LimeSwap" only. Visitors connect Varial (Freighter) on Testnet. The "Get test tokens"
panel funds a new account with Friendbot, adds the LEUR/LUSD/LIME trustlines in one signature and
claims from the demo faucet (`lime-amm/faucet.sh`: 100 of each per address per day, no secret in
the site).
- `npm run deploy` builds, refuses to publish if a dev-signer key is in the bundle, and deploys
  (`deploy.sh`; Wrangler login once with scopes `account:read user:read pages:write`).
- `public/_headers`: CSP (connects only to the Testnet RPCs + Friendbot), no framing, nosniff.
- After the Dec 16 Testnet reset: `../setup.sh testnet` (recreates the contracts + faucet), then
  `npm run deploy` (contract IDs are baked in at build time).

### Dev signer and Testnet QA (no wallet extension)
So Claude can build *and* test like a developer with a dev wallet, the app can sign with a **test key**
from the git-ignored `.env.local` instead of Freighter:

| Mode | Command | Key (CLI identity) | Badge |
|---|---|---|---|
| Local network | `npm run dev:local` (port 5210) | `VITE_DEV_SECRET` (`limeswap-tester`) | yellow DEV SIGNER |
| Testnet QA | `npm run dev:qa` (port 5212, launch config `limeswap-app-qa`) | `VITE_DEV_SECRET_TESTNET` (`limeswap-qa`) | blue DEV SIGNER |
| Testnet with your wallet | `npm run dev` (port 5211) | Freighter (Varial) | — |

Guardrails:
- The signer works only on local and Testnet, and refuses to sign for any other network passphrase.
- The Testnet key exists only on the QA dev server; `vite build` strips both keys (checked: neither
  appears in `dist/`, even when building with `VITE_QA=1`).
- The keys are generated by the CLI and funded from friendbot and our own test issuers; they never hold
  anything real.

```bash
./fund-tester.sh local      # after ../setup.sh local
./fund-tester.sh testnet    # creates/funds limeswap-qa: XLM, trustlines, 5,000 LEUR + LUSD, 2,000 LIME, 50 LFUND (authorized)
npm run e2e                 # Testnet end-to-end: 7 flows (brand-new account onboarding: Friendbot, trustlines, faucet;
                            # swaps incl. LimeFX + mixed route, regulated LFUND output, LimeFX deposit/withdraw,
                            # compliance-pool deposit/withdraw), each checked against balances
NETWORK=local npm run e2e   # same on the local network
NETWORK=testnet node verify-positions.mjs G…   # "Your positions": batched LP shares/owed vs each pool's balance()/owed()
```
Freighter itself only needs a person for an occasional sign-off before a public release.

### LP fee earnings (Pools + Liquidity tabs)
Every swap pays its fee into the pool, so it belongs to the LPs (LimeSwap takes no cut). The app shows:
- **Pools tab:** an "≈ 12.4% APR" tag per pool (LimeFX card too), and in the details "Fees to LPs" (over the
  last 7 days, or since the pool started, with the swap count) and "Fee APR" (fees ÷ what the pool holds now,
  annualised; shown only after a full day of history).
- **Liquidity tab, Your positions:** per position, *Fees* (your share of every swap fee), *price moves* (what
  the pool's rebalancing cost you compared with holding the two tokens: impermanent loss) and *vs holding*
  (both together), since the later of 7 days ago and your last deposit, withdrawal or LP transfer. From then
  on your shares were constant, so all three are exact rather than estimated. Values use today's prices.
  The design session's profit/loss line also uses the **entry value**: what the position held at its start,
  at that moment's prices (`positionNumbers()` in `src/ui/earnings.js`: `entryUsd`, `entryAt`, `entryKnown`;
  `entryKnown` = false when the deposit is older than the ~7-day history). Those past prices come from every
  pool rebuilt to that moment (`poolsAt` in `src/fees.js`), each LimeSwap pool at its **10-minute TWAP**,
  LimeFX at the oracle price in its swap events. A spot price would let one trade set the entry. On Nov 6 a
  1,000 XLM swap moved LIME/XLM 0.3% 4× just before a deposit: $1,022 at spot vs $660 at the TWAP.

How it works: `src/fees.js` (no DOM) reads the pools' own events from Stellar RPC (`swap`, `deposit`,
`withdraw`, `sync`, LP `mint`/`burn`/`transfer`, `force_redeem`) and rebuilds each pool's reserves and LP supply
backwards from the state on screen. LimeSwap pools publish `sync` (exact reserves after each change), which
the rebuild treats as the truth. Fees per swap use the contracts' own rounding (fee taken from the input;
LimeFX's dynamic fee comes with each event). `src/ui/earnings.js` loads it in the background, only on the Pools
and Liquidity tabs:
- **First visit:** the whole retention window in ~13 parallel `getEvents` ranges (≈ 5–7 s).
- **Later:** cached in `localStorage` (`limeswap:events:<network>`); then at most every 20 s one request for
  the new ledgers, up to exactly the ledger the pool data on screen was read at.

Checks:
- `npm run test:fees`: 19 tests with a simulated pool.
- `NETWORK=testnet node verify-fees.mjs [G…]`, read-only, against the chain:
  - our reserves agree with every `sync` event;
  - every swap pays exactly the x·y=k amount for the rebuilt reserves and fee;
  - each pool, LimeFX included, rebuilds back to exactly 0 / 0 / 0 at its creation;
  - fee totals match a direct sum over the raw events;
  - the account's position matches the Liquidity tab.

  Nov 6, 2026: all passed on all 7 Testnet pools (≈ 530 events), for `lime-owner` and the QA account.
  Screenshots: `screenshots/3-fee-earnings/`.

Limits:
- **About 7 days of history:** RPC keeps ~7 days of events (default 120,960 ledgers; `getHealth` gives the
  real window). Older history isn't available without an indexer.
- **Testnet APRs jump around:** they come from recent volume, which on Testnet is mostly our bots and tests
  (e.g. 700%+ on the 1% LIME/XLM pool the arbitrage bot trades).
- **LimeFX clawback blind spot:** LimeFX's `reconcile` (after an issuer clawback) lowers reserves without an
  event; the rebuild can't see that.
- **Positions only:** a pool's own numbers need no wallet, but the per-position line needs a connected account.

**"Earned since you deposited" (not built): options.**
1. *Pool contract checkpoint* (pool v6 via the timelock): store each LP's entry amounts at mint/transfer.
   On-chain, works from any app or device, but it costs rent and gas on every deposit and transfer. LP-token
   transfers need weighted checkpoints, and it means 6 pool upgrades plus LimeFX, all behind the 1-hour timelock.
2. *An indexer* (Watchtower ingesting the pools' events, or a hosted one such as Mercury, which the Stellar
   docs suggest for history past the RPC window). It serves full history to the app, but the site is static
   today, so this needs a small API (e.g. a Cloudflare Worker + D1).
3. *Browser storage*: remember each deposit when you make it here. Trivial, but it only works in this browser
   and misses deposits made elsewhere (CLI, another app, another device).

Recommendation: **2**, the industry norm (DEX interfaces read LP history from an indexer). It also feeds
volume charts and the maturity report, and keeps the contracts lean. Use 3 meanwhile only if people ask
before an indexer exists.

### MetaMask (Stellar Snap)
MetaMask has no Stellar Testnet support of its own for dApps yet: its built-in Stellar account (Oct 30, 2026)
and the official `@metamask/connect-stellar` adapter (also inside Stellar Wallets Kit) are **Mainnet only**.
So the Connect sheet offers MetaMask through the community **Stellar Snap** (`npm:stellar-snap` by Paul
Fears: listed in MetaMask's Snaps Directory, Cure53-audited at 1.0.6, last release Jul 2025). Dimitar chose
this on Nov 6, 2026; research in `notes/27-amm-devx-log.md` (phase 8).

- First connect asks MetaMask to add the Snap ("Add Stellar"), pinned to **1.0.9**, then reads its address.
  The Snap's account is a *separate* Stellar account derived inside MetaMask (not MetaMask's own Stellar
  account); new users fund it with **Get test tokens** like any new account.
- Code: `src/metamask.js` (re-exported by `src/wallet.js`, same `{ kind, address, prompt, sign }` shape).
  MetaMask is found by EIP-6963 discovery (`rdns` `io.metamask`), not `window.ethereum`, because Brave
  Wallet and others pretend to be MetaMask there but can't run Snaps.
- Network guard: the Snap has no "current network" (each call passes `testnet: true`), so the app refuses
  to connect or sign on anything but Testnet, and checks every returned transaction: same hash as sent,
  signed by the connected account for the Testnet passphrase (a Mainnet signature or another account fails).
- Plain-language errors: MetaMask/Snap missing, declined, another MetaMask request already open, account
  not funded, Snap timed out, no signature back.
- Tests: `npm run test:wallet` (24 Node tests with a mocked MetaMask provider; no browser or extension).
  Nov 6, 2026: a mock MetaMask injected into the real page drove a brand-new account through Friendbot →
  trustlines → faucet → LimeFX swap on Testnet, plus a rejected signature. Dimitar's real MetaMask
  sign-off on Testnet passed the same day (connect + add Snap, Get test tokens, swap).
- To move to MetaMask's own Stellar account once it supports Testnet: replace the Snap calls in
  `src/metamask.js` with `@metamask/connect-stellar` (SEP-43: `requestAccess`, `signTransaction(xdr,
  { networkPassphrase, address })`), keep the signature check.

**Sign-off with a real MetaMask (Testnet):** MetaMask extension in Chrome/Brave (Brave Wallet off or set
not to be the default) → open the Testnet app → Connect wallet → MetaMask → approve "Add Stellar" and the
connection → Get test tokens (Friendbot, trustlines, claim: approve each in the Snap) → swap 10 LEUR → LUSD.

### Get test tokens (onboarding)
A first-time visitor connects Varial (formerly Freighter, https://varialwallet.com/) on Testnet and the
**Get test tokens** panel opens by itself while anything is missing: 1 Friendbot funds the new account,
2 one signature adds every missing trustline (LEUR, LUSD, LIME; 0.5 XLM reserve each), 3 the LimeSwap
faucet pays 100 LEUR + 100 LUSD + 100 LIME once per 24 h (the panel then shows when the next claim is
possible). The header button and the "Get test tokens" links on Swap warnings reopen it; without a
wallet it shows the install hint. Code: `src/ui/onboarding.js` (logic in `chain.fundWithFriendbot`,
`chain.addTrustlines`, `onboardingState`, `faucetClaimCall`). To test it with a brand-new account
without Freighter: launch config `limeswap-app-qa-fresh` (port 5213, CLI identity `limeswap-qa-fresh`;
generate a new identity, or use `--overwrite`, for another fresh run).

## Code layout
| File | |
|---|---|
| `src/chain.js` | RPC, read = simulate, write = simulate → assemble → sign → send → poll; dev signer (local + Testnet only, network-checked) |
| `src/dex.js` | Pools, LimeFX, routing, positions, compliance/trustline checks (no DOM; shared with `smoke.mjs`) |
| `src/errors.js` | Contract error codes → plain sentences (finds *which* contract failed from the diagnostic log) |
| `src/wallet.js` | Varial/Freighter connect + sign, refuses if the wallet is on another network; re-exports MetaMask |
| `src/metamask.js` | MetaMask via the Stellar Snap: discovery, pinned install, Testnet-only signing + signature check (`test-metamask.mjs`) |
| `src/fees.js`, `src/ui/earnings.js` | LP fee earnings from pool events: fetch + cache, rebuild, fees, APR, vs holding (`test-fees.mjs`, `verify-fees.mjs`) |
| `src/ui/dom.js` | Shared UI pieces: token avatars, tooltips, callouts, picker sheet, toasts, `runTx` progress steps |
| `src/ui/{pools,swap,liquidity}.js`, `main.js` | The three tabs; wiring, wallet modal, theme, tabs |
| `src/ui/onboarding.js` | Get test tokens panel (Friendbot → trustlines → faucet claim) |
| `style.css`, `DESIGN.md` | Design tokens and components; the design system and Mobbin references |

## Notes
- Tested with Freighter (Varial) on Testnet on Nov 5, 2026: swap, mixed LimeSwap → LimeFX route,
  and router deposit all pass (notes/33). That was the original UI. The current "Fresh Squeeze" UI is verified
  on Testnet with the QA test key (Nov 6: brand-new account onboarding, swap, LimeFX deposit; `npm run e2e`
  7/7); a Freighter (Varial) pass with the new UI is still to do. Testnet dev server: `.claude/launch.json`
  name `limeswap-app-testnet` (port 5211).
- Reads are simulations: free and need no wallet. Testnet reads go to Gateway.fm's public RPC first (usually
  under 0.3 s) with SDF's as the fallback (1–9 s on busy days); see `FAST_RPC` in `src/chain.js`, and add any
  new endpoint to the CSP in `public/_headers`. After our own transaction, reads wait for a node that has it.
  Refreshes never overlap.
- Feels instant: last-known balances (localStorage, per network + address) show at once and are replaced by fresh
  reads; a swap updates the balances from its result; Varial reconnects without a popup after a reload if it
  still allows the site (MetaMask needs a click).
- Price impact is shown *excluding* the fee (fee is listed separately). For LimeFX the reference price is
  the oracle; for LimeSwap it is the pool's current reserve ratio along the route.
- Deposits sign token transfers with exact amounts. If reserves move between quote and inclusion the
  transaction fails safely (re-enter and retry).
- Not audited, test tokens only.
