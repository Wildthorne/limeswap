# LimeSwap — constant-product AMM on Soroban

Our own AMM, built on OpenZeppelin Stellar 0.8.0 building blocks, using the Uniswap V2 / Soroswap
design. Phase 1 of the AMM project (plan and research: `notes/28`, tooling log: `notes/27`).

| Contract | What it does |
|---|---|
| `contracts/pool` | One pair. x·y=k, fee in bps; the LP share is a SEP-41 token (`LSLP`) in the pool itself; `swap` (pulls the input), `swap_raw` (router style, input sent first); `deposit` and `deposit_raw` (router style: tokens sent first, excess refunded); `reconcile` (clamp reserves after a clawback); built-in TWAP (`twap(window)` → prices + actual window); `sync`/`skim`; admin pause (withdrawals still work) and upgrade; `owed`/`claim` when an issuer freezes one side. v5: two-step admin transfer (`propose_admin` → `accept_admin`, `pending_admin`), pause-only `guardian` (`set_guardian`) |
| `contracts/factory` | Deploys one pool per (pair, fee tier 5/30/100 bps) at a deterministic address; registry (`get_pool`, `pools`); a new pool's admin = the factory's admin at creation time. v2: two-step admin transfer |
| `contracts/pool` v3 compliance mode | Opt-in by a regulated asset's issuer (`set_compliance`): LP holders/depositors must be `authorized` on its SAC; a frozen holder's withdrawal is held (both sides) until unfrozen; issuer `force_redeem(token, holder, to, release_other)` (notes/31 Part A) |
| `contracts/fx-pool` | **LimeFX**: two-stablecoin pool centred on a SEP-40 oracle price (Reflector FX on Testnet): virtual-liquidity curve (`amp`), hard price band, staleness limit, circuit breaker, volatility + age fee; proportional liquidity only (notes/31 Part B). v2: `swap_in` / `deposit_raw` / `reconcile` / `tokens` so the router can use it. v3: per-window **outflow cap** (`set_outflow_cap`, `outflow_cap`, `flow`; default 20%/h net per token), optional **depeg guard** (`set_peg_guard`, `peg_guard`: a token-price SEP-40 feed vs the fiat reference), two-step admin + pause-only guardian |
| `contracts/timelock` | Governance timelock (OpenZeppelin `stellar-governance` 0.8 + `stellar-access` roles, after OZ's timelock-controller example): `schedule` (proposer) → wait ≥ `get_min_delay` ledgers → `execute` (open) / `cancel` (canceller); self-administered (`update_delay`, `grant_role` via a scheduled op + `__check_auth`). Becomes admin of factory, pools and LimeFX via `governance.sh` |
| `contracts/mock-oracle` | SEP-40 subset with admin `set_price`, for tests and the local network |
| `contracts/arb` | Cross-protocol atomic arbitrage executor (LimeSwap ↔ Soroswap), Phase 2 |
| `contracts/router` | `add_liquidity` (creates the pool if missing) and `add_liquidity_to(pool, …)` (any pool incl. LimeFX) — both sign **fixed** amounts and let the pool refund the excess; `remove_liquidity`; `quote` / `swap_exact_in` over LimeSwap paths; v2 `quote_route` / `swap_route` over hops `{"Pool": fee}` or `{"Fx": address}`, output checked on the recipient's balance. A path that starts and ends with the same token is an **atomic arbitrage cycle** |

## Deployed (admin = `lime-owner` until `governance.sh` hands it to the timelock)
IDs in `deployed.<net>.json`; CLI aliases `limeswap-factory`, `limeswap-router`, `limeswap-lime-xlm-30`,
`limeswap-lime-xlm-100`, `limeswap-lime-lime-5`, `limeswap-lfund-xlm-30` (compliance on),
`limeswap-leur-lusd-5` (comparison pool), `limeswap-lusd-xlm-30` (links LimeFX to XLM routes), `limefx-eur-usd` (LimeFX).

| Pool | Seed | Why |
|---|---|---|
| classic LIME / XLM 0.3% | 10,000 LIME + 1,000 XLM | same price as the SDEX offer (0.10 XLM) |
| classic LIME / XLM 1% | 5,000 LIME + 550 XLM | deliberately off (0.11) → on-chain arbitrage target |
| contract LIME / classic LIME 0.05% | 5,000 + 5,000 | stable pair |
| LFUND / XLM 0.3% | 200 LFUND + 200 XLM | regulated asset, compliance mode on (`compliance-pool.sh`) |
| LimeFX LEUR / LUSD | 10,000 LEUR + EUR/USD-equivalent LUSD | oracle-anchored (`fx-pool.sh`) |
| LEUR / LUSD 0.05% | same as LimeFX | plain x·y=k, for comparison |
| LUSD / XLM 0.3% | 1,000 XLM + 300 LUSD | connects LimeFX to the rest: XLM → LUSD → LEUR is one `swap_route` |

## Commands
```bash
stellar contract build && cargo test          # 113 tests incl. property tests, upgrades, clawback regressions, governance e2e
./deploy.sh testnet|local                      # factory, router, seeded pools, LFUND + LimeFX pools (setup.sh calls it)
./upgrade-pools.sh testnet|local               # bring a network to releases/: pools + factory, LimeFX, router (redeployed)
./demo-compliance.sh testnet|local             # Maria's freeze story (bypass without compliance, blocked with it, force_redeem)
./kyc.sh testnet|local                         # LFUND demo KYC desk: deploy, make it LFUND's SAC admin, sync existing trustlines (deploy.sh calls it)
node fx-experiment.mjs 10,30,50,100 100        # local only: LP loss to arbitrage, LimeFX vs x·y=k, when EUR/USD jumps
./governance.sh testnet|local setup|accept|status   # 2-of-3 multisig lime-gov + timelock become admin (setup, wait, accept)
./gov-op.sh testnet|local schedule|execute|state|cancel|list …   # one timelocked admin call (see header)
```
Governance (after `governance.sh`): admin of factory, pools and LimeFX = `limeswap-timelock` (delay 720 ledgers
≈ 1 h on Testnet, 12 on local). Proposer = `lime-gov`, a classic account with signers lime-owner, lime-friend,
lime-issuer (weight 1, thresholds 2, master key off). Canceller = lime-gov only (2 of 3 keys to veto). lime-owner is the guardian: pause only, no veto (review M1).
Guardian = lime-owner: can `pause` pools/LimeFX instantly (withdrawals keep working); `unpause`, params and
upgrades need the timelock. `upgrade-pools.sh` then skips those contracts and prints the `gov-op.sh` command.
Release flow: bump `VERSION` → build → copy wasm to `releases/lime_amm_pool_vN.wasm` → `cargo test` → `./upgrade-pools.sh`.

Demo KYC desk (`contracts/kyc`, alias `lfund-kyc`, Testnet only): LFUND's SAC admin is a contract, so
anyone can call `verify(user)` to get an approved LFUND trustline plus a 20 LFUND starter grant in one
signature (the SAC's `trust` creates the trustline). The issuer (`lime-fund`) keeps control through the
desk: `set_status` (approve / freeze; frozen = Revoked, can't self-verify), `mint`, `clawback`,
`set_grant`, `pool_set_compliance`, `pool_force_redeem` (pools check the SAC admin, which is now the
desk) and `set_sac_admin` to take the role back. Scripts use `lfund-admin.sh`, which works before and
after the handover. Freeze through the desk, not a classic SetTrustLineFlags: the desk only knows the
statuses it recorded.

## Versions
- **pool v1** (Nov 5, 2026): first release.
- **pool v2** (Nov 5, 2026): fixes from the security review: withdraw/deposit use real balances after a
  clawback (loss shared pro rata), the first deposit can't be price-set by a donation, one frozen side
  no longer locks the other (`owed`/`claim`), TWAP saturates instead of reading 0 and returns the
  actual window, observations moved to per-slot persistent storage. Live pools upgraded in place.
- **pool v3** (Nov 5, 2026): compliance mode for regulated assets, SEP-41 `burn` event on withdraw,
  LP shares can't be sent to the pool itself, `balances` clamped at 0. Review fixes before release
  (frozen holder's withdrawal held on both sides; only a real SAC has an issuer). Live pools upgraded.
- **fx-pool v1** (Nov 5, 2026): LimeFX, after one review round (price band, amp ramp, age fee, oracle checks).
- **pool v4, fx-pool v2, router v2** (Nov 5, 2026): LimeFX routable through the router (`swap_in`,
  `Hop::Fx`), deposits sign fixed amounts (`deposit_raw` refunds the excess), `reconcile` before any
  router transfer (review Medium: an unsynced clawback was charged to the user). Live pools and LimeFX
  upgraded in place; router redeployed (it has no admin).
- **fx-pool v3, pool v5, factory v2, timelock v1** (Nov 5, 2026; deployed on Testnet the same day, then handed to the timelock): LimeFX outflow cap
  (error 24 `OutflowCapExceeded`) and depeg guard (error 25 `Depegged`); two-step admin transfer and a
  pause-only guardian on pools and LimeFX, two-step admin on the factory; OZ-based timelock. Storage is
  backward compatible (new keys with defaults), upgrade tests from the frozen v2 / v4 / v1 binaries.
- **fx-pool v4** (Nov 6, 2026): `withdraw` emits the SEP-41 `burn` event for the LP shares it burns
  (v1–v3 lowered the supply silently; the cp pool has emitted it since v3). Found by the dApp's LP fee
  rebuild. No storage change; upgrade test from the frozen v3 binary with timelock admin, guardian and a
  custom cap. Rehearsed on a throwaway Testnet LimeFX (v3 → v4, RPC returns the `burn` event), then
  upgraded on Testnet through the timelock the same day (op `94e5d678…`: scheduled by `lime-gov`, executed
  after the 720-ledger delay); `npm run e2e` 7/7 afterwards, its LimeFX withdraw now emits `burn`.

- **kyc v1** (Nov 6, 2026): demo KYC desk for LFUND (7 tests, incl. force-redeem through a real pool).
  Rehearsed on a throwaway asset on Testnet (fresh account verified in one tx with trustline creation,
  second verify #1, frozen account #2, clawback, freeze, admin handed back), then made LFUND's SAC admin
  on Testnet (`CAU3PGNX…`); Maria synced as Revoked, lime-owner and limeswap-qa as Verified.

## Known limitations (not audited — Testnet only)
- Until `governance.sh` runs, one admin key can upgrade every pool instantly. After it: 2-of-3 keys and
  a 1-hour delay; still Testnet keys held on one machine, and the timelock itself is not upgradable.
- Governance (review of pool v5 / LimeFX v3 / timelock): the outflow cap can be griefed. Anyone can
  spend ~20% of a reserve one way and block that direction until the window ends (cost: about two
  fees on that amount). A dominant LP can also shrink the window's base. A pool created between
  `governance.sh setup` and `accept` keeps lime-owner as admin (re-run `setup`). Ready timelock
  operations never expire: cancel the ones you abandon. Upgrades via the timelock don't run
  `migrate`; schedule it as a second operation with the upgrade as predecessor.
- Pools created after the hand-over get the timelock as admin but no guardian (set it via `gov-op.sh`).
- LimeFX: the outflow window is fixed, not rolling (up to 2× the cap across a boundary); the cap limits a
  wrong-but-in-band feed to ~20% of a side per hour, it doesn't stop it. The depeg guard is off until
  configured, needs a token-price feed quoted in the FX feed's base unit, and is only as good as that feed.
  No emergency single-token withdraw. See notes/31 Part B.
- Large swaps on LimeFX v3 (> 20% of a side per hour, net) revert with #24: raise it for experiments with
  `set_outflow_cap` (via the timelock once governed).
- The router routes through LimeFX; the cross-protocol arb executor (`contracts/arb`, Soroswap) and the
  arbitrage bot don't include LimeFX yet.
- `Hop::Fx` and `add_liquidity_to` accept any pool address: a malicious one can only hurt the caller who
  passes it (the dApp only passes our own). `quote_route` prices a pool used twice in one route on its
  starting state (too high); `swap_route` is exact.
- Tokens sent to a pool outside an atomic router call can be taken by anyone (`skim`/`swap_raw`), as in Uniswap V2.
- Direct `pool.deposit` still signs reserve-dependent amounts (fails if reserves move before it lands);
  use the router's `add_liquidity` / `add_liquidity_to`, which sign fixed amounts.
