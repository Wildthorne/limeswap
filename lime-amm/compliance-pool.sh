#!/usr/bin/env bash
# Regulated-asset pool (Phase 3): LFUND / XLM 0.3% with compliance mode switched on by the LFUND
# issuer. Needs pool code v3+ in the factory and LFUND from ../setup.sh. Safe to re-run.
#
# Usage:  ./compliance-pool.sh [testnet|local]      (called by deploy.sh)
set -euo pipefail

NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
ONE=10000000
DEADLINE=$(( $(date +%s) + 3600 ))
owner() { stellar contract invoke --source-account lime-owner "${N[@]}" "$@" 2>/dev/null; }
source "$HERE/lfund-admin.sh" # issuer actions, before or after kyc.sh made the KYC desk LFUND's admin

OWNER=$(stellar keys address lime-owner)
XLM=$(stellar contract id asset --asset native "${N[@]}")
LFUND=$(stellar contract alias show lfund-sac "${N[@]}")

POOL=$(owner --id limeswap-factory -- get_pool --token_a "$LFUND" --token_b "$XLM" --fee_bps 30 | tr -d '"')
if [[ -z "$POOL" || "$POOL" == "null" ]]; then
  POOL=$(owner --id limeswap-factory -- create_pool --token_a "$LFUND" --token_b "$XLM" --fee_bps 30 | tr -d '"')
fi
stellar contract alias add limeswap-lfund-xlm-30 --contract-id "$POOL" "${N[@]}" --overwrite >/dev/null 2>&1 || true
echo "   LFUND/XLM 0.3%      $POOL"

# LFUND is AUTH_REQUIRED: the pool contract itself needs the issuer's approval to hold it.
lfund_authorize "$POOL" true >/dev/null 2>&1
lfund_pool_compliance "$POOL" true >/dev/null 2>&1
echo "   issuer approved the pool and switched compliance on: $(owner --id "$POOL" -- compliance)"

SHARES=$(owner --id "$POOL" -- info | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).total_shares))')
if [[ "$SHARES" == "0" ]]; then
  owner --id limeswap-router -- add_liquidity --from "$OWNER" --token_a "$LFUND" --token_b "$XLM" --fee_bps 30 \
    --desired_a $((200 * ONE)) --desired_b $((200 * ONE)) --min_a 0 --min_b 0 --deadline "$DEADLINE" >/dev/null
  echo "   seeded with 200 LFUND + 200 XLM by lime-owner"
fi

HERE="$HERE" NET="$NET" POOL="$POOL" LFUND="$LFUND" node --input-type=module <<'JS'
import fs from "node:fs";
const e = process.env;
const f = `${e.HERE}/deployed.${e.NET}.json`;
const d = JSON.parse(fs.readFileSync(f, "utf8"));
d.tokens.lfund = e.LFUND;
d.pools = [...d.pools.filter((p) => p.id !== e.POOL),
  { id: e.POOL, pair: ["lfund", "xlm"], feeBps: 30, compliance: "lfund" }];
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
JS
