# LimeSwap

An AMM / DEX on Stellar (Soroban), built by [LimeChain](https://limechain.tech) to learn and assess how mature DeFi building on Stellar is.

> **Testnet only. Not audited. Do not deploy to Mainnet or use with real funds.**
> This is a research and teaching project. The contracts have not had a security audit.

Live demo on Testnet: https://limeswap-t2l.pages.dev

## What's inside

| Folder | What it is |
|---|---|
| [`lime-amm/`](lime-amm/) | Soroban contracts (Rust, soroban-sdk 28, OpenZeppelin Stellar 0.8) and the deploy/ops scripts |
| [`limeswap-app/`](limeswap-app/) | The web app (Vite, vanilla JS, @stellar/stellar-sdk 17.4): pools, swap with best-route search, liquidity |
| `deployed.testnet.json`, `deployed.local.json` | Network settings and contract addresses the app and scripts read |

Contracts in `lime-amm/contracts/`:

- `pool`: constant-product pair (x·y=k) with fee tiers, SEP-41 LP token, TWAP, pause, upgrades, and an opt-in **compliance mode** for regulated assets (holders must be authorized on the asset's SAC, issuer can force-redeem)
- `factory`: one pool per pair and fee tier at a deterministic address
- `router`: multi-hop swaps and liquidity, routes can mix LimeSwap pools and LimeFX
- `fx-pool` (**LimeFX**): stablecoin FX pool anchored to a SEP-40 oracle price (Reflector on Testnet), with price band, staleness limit, circuit breaker, outflow cap and depeg guard
- `timelock`: governance timelock (OpenZeppelin), admin of the factory, pools and LimeFX
- `kyc`: demo KYC desk that acts as SAC admin for a regulated test asset
- `faucet`: Testnet faucet for the demo tokens
- `arb`: cross-venue arbitrage executor used in experiments
- `mock-oracle`: SEP-40 mock for the local network

Frozen release binaries are in `lime-amm/releases/`.

## Running it

Build and test the contracts:

```bash
cd lime-amm
stellar contract build
cargo test
```

Run the web app against Testnet (needs a Stellar wallet such as Freighter, with a Testnet account):

```bash
cd limeswap-app
npm install
npm run dev
```

The deploy scripts (`lime-amm/deploy.sh` and friends) assume our Stellar CLI identities and the LIME test token from our wider workspace, so treat them as a reference for the deploy order rather than a one-click setup. Mentions of `notes/NN` in the sub-READMEs point to our internal notes, which are not part of this repo.

## License

Apache-2.0, see [LICENSE](LICENSE).
