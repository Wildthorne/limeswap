#!/usr/bin/env bash
# Deploy LimeSwap (factory + router) and seed demo pools on a network where setup.sh already ran.
#
# Usage:  ./deploy.sh [testnet|local]      (default: testnet; called at the end of ../setup.sh)
#
# Pools (lime-owner provides liquidity; prices chosen so arbitrage demos have something to find):
#   classic LIME / XLM   0.3%   0.10 XLM per LIME  (same price as the SDEX offer from setup.sh)
#   classic LIME / XLM   1%     0.11 XLM per LIME  (deliberately off → on-chain arbitrage cycle)
#   contract LIME / classic LIME  0.05%  1:1
set -euo pipefail

NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
REL="$HERE/releases"
ONE=10000000
DEADLINE=$(( $(date +%s) + 3600 ))

step() { printf '\n== %s\n' "$*"; }
inv() { stellar contract invoke --source-account lime-owner "${N[@]}" "$@" 2>/dev/null; }
latest() { ls "$REL"/"$1"_v*.wasm | sort -V | tail -1; }

OWNER=$(stellar keys address lime-owner)
XLM=$(stellar contract id asset --asset native "${N[@]}")
# SAC for native XLM must exist before contracts can use it (deploy is a no-op error if it does).
stellar contract asset deploy --asset native --source-account lime-owner "${N[@]}" >/dev/null 2>&1 || true
LIME_C=$(stellar contract alias show lime-token "${N[@]}")
LIME_S=$(stellar contract alias show lime-classic-sac "${N[@]}")

step "1/6 Upload pool code, deploy factory and router"
POOL_HASH=$(stellar contract upload --wasm "$(latest lime_amm_pool)" --source-account lime-owner "${N[@]}" 2>/dev/null | tail -1)
FACTORY=$(stellar contract deploy --wasm "$(latest lime_amm_factory)" --source-account lime-owner "${N[@]}" \
  --alias limeswap-factory -- --admin "$OWNER" --pool_wasm_hash "$POOL_HASH" 2>/dev/null | tail -1)
ROUTER=$(stellar contract deploy --wasm "$(latest lime_amm_router)" --source-account lime-owner "${N[@]}" \
  --alias limeswap-router -- --factory "$FACTORY" 2>/dev/null | tail -1)
echo "   pool code  $POOL_HASH"
echo "   factory    $FACTORY"
ARB=$(stellar contract deploy --wasm "$(latest lime_amm_arb)" --source-account lime-owner "${N[@]}" \
  --alias limeswap-arb 2>/dev/null | tail -1)
echo "   router     $ROUTER"
echo "   arb exec   $ARB  (cross-protocol atomic arbitrage, no admin)"

add() { # token_a token_b fee amount_a amount_b
  inv --id limeswap-router -- add_liquidity --from "$OWNER" --token_a "$1" --token_b "$2" --fee_bps "$3" \
    --desired_a "$4" --desired_b "$5" --min_a 0 --min_b 0 --deadline "$DEADLINE" >/dev/null
  inv --id limeswap-factory -- get_pool --token_a "$1" --token_b "$2" --fee_bps "$3" | tr -d '"'
}

step "2/6 Seed pools"
P_LX30=$(add "$LIME_S" "$XLM" 30 $((10000 * ONE)) $((1000 * ONE)))
echo "   LIME/XLM 0.3%       $P_LX30  (10,000 LIME + 1,000 XLM)"
P_LX100=$(add "$LIME_S" "$XLM" 100 $((5000 * ONE)) $((550 * ONE)))
echo "   LIME/XLM 1%         $P_LX100  (5,000 LIME + 550 XLM)"
P_LL5=$(add "$LIME_C" "$LIME_S" 5 $((5000 * ONE)) $((5000 * ONE)))
echo "   LIME(c)/LIME 0.05%  $P_LL5  (5,000 + 5,000)"
for a in "limeswap-lime-xlm-30:$P_LX30" "limeswap-lime-xlm-100:$P_LX100" "limeswap-lime-lime-5:$P_LL5"; do
  stellar contract alias add "${a%%:*}" --contract-id "${a#*:}" "${N[@]}" --overwrite >/dev/null 2>&1 || true
done

step "3/6 Smoke test: quote and swap 10 XLM → LIME, plus a quoted arbitrage cycle"
Q=$(inv --id limeswap-router -- quote --amount_in $((10 * ONE)) --tokens "[\"$XLM\",\"$LIME_S\"]" --fees '[30]')
echo "   quote 10 XLM → LIME: $Q"
inv --id limeswap-router -- swap_exact_in --from "$OWNER" --to "$OWNER" --amount_in $((10 * ONE)) --min_out 0 \
  --tokens "[\"$XLM\",\"$LIME_S\"]" --fees '[30]' --deadline "$DEADLINE" >/dev/null
echo "   swapped ✓"
ARB=$(inv --id limeswap-router -- quote --amount_in $((20 * ONE)) --tokens "[\"$XLM\",\"$LIME_S\",\"$XLM\"]" --fees '[30,100]')
echo "   cycle XLM→LIME(0.3%)→XLM(1%) for 20 XLM: $ARB"

step "4/6 Write deployed.$NET.json"
NET="$NET" HERE="$HERE" FACTORY="$FACTORY" ROUTER="$ROUTER" ARB="$ARB" POOL_HASH="$POOL_HASH" XLM="$XLM" LIME_C="$LIME_C" LIME_S="$LIME_S" \
P_LX30="$P_LX30" P_LX100="$P_LX100" P_LL5="$P_LL5" node --input-type=module <<'JS'
import fs from "node:fs";
const e = process.env;
const amm = {
  network: e.NET, factory: e.FACTORY, router: e.ROUTER, arbExecutor: e.ARB, poolWasmHash: e.POOL_HASH,
  tokens: { xlm: e.XLM, limeContract: e.LIME_C, limeClassic: e.LIME_S },
  pools: [
    { id: e.P_LX30, pair: ["limeClassic", "xlm"], feeBps: 30 },
    { id: e.P_LX100, pair: ["limeClassic", "xlm"], feeBps: 100, note: "Arbitrage demo pool: seeded at a slightly different price than the 0.3% pool (0.11 vs 0.10 XLM per LIME), so the arbitrage bot has a real gap to close." },
    { id: e.P_LL5, pair: ["limeContract", "limeClassic"], feeBps: 5 },
  ],
  updated: new Date().toISOString(),
};
fs.writeFileSync(`${e.HERE}/deployed.${e.NET}.json`, JSON.stringify(amm, null, 2) + "\n");
// Also expose it in the project-wide file the dashboard reads.
const shared = `${e.HERE}/../deployed.${e.NET}.json`;
if (fs.existsSync(shared)) {
  const d = JSON.parse(fs.readFileSync(shared, "utf8"));
  Object.assign(d.contracts, { limeswapFactory: e.FACTORY, limeswapRouter: e.ROUTER });
  fs.writeFileSync(shared, JSON.stringify(d, null, 2) + "\n");
}
// Let the Watchtower alert on pool/factory code changes, pauses and big swaps.
const wl = `${e.HERE}/../watchtower/watchlist.${e.NET}.json`;
if (fs.existsSync(wl)) {
  const w = JSON.parse(fs.readFileSync(wl, "utf8"));
  const mine = [
    { id: e.FACTORY, label: "LimeSwap factory", autoExtend: true },
    { id: e.ROUTER, label: "LimeSwap router", autoExtend: true },
    { id: e.P_LX30, label: "LimeSwap LIME/XLM 0.3%", autoExtend: true },
    { id: e.P_LX100, label: "LimeSwap LIME/XLM 1%", autoExtend: true },
    { id: e.P_LL5, label: "LimeSwap LIME/LIME 0.05%", autoExtend: true },
  ];
  w.contracts = [...w.contracts.filter((c) => !c.label.startsWith("LimeSwap")), ...mine];
  fs.writeFileSync(wl, JSON.stringify(w, null, 2) + "\n");
}
JS
echo "   lime-amm/deployed.$NET.json"

step "5/6 Regulated-asset pool (LFUND/XLM, compliance mode)"
"$HERE/compliance-pool.sh" "$NET"

step "6/6 Oracle-anchored FX pool (LimeFX, LEUR/LUSD) + demo faucet + LFUND demo KYC desk"
"$HERE/fx-pool.sh" "$NET"
"$HERE/faucet.sh" "$NET"
"$HERE/kyc.sh" "$NET"
echo
echo "LimeSwap is live on $NET."
