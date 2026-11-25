#!/usr/bin/env bash
# Phase 3 demo: why a regulated asset needs a compliance-aware pool. Story with Maria (lime-friend):
#   KYC'd → provides LFUND liquidity → issuer freezes her → can she sell her LP claim? → issuer
#   force-redeems her position. Ends with Maria frozen and out of the pool (setup.sh's state).
#
# Usage:  ./demo-compliance.sh [testnet|local]      (after compliance-pool.sh)
set -uo pipefail

NET="${1:-testnet}"
N=(--network "$NET")
ONE=10000000
as() { local who=$1; shift; stellar contract invoke --source-account "$who" "${N[@]}" "$@" 2>&1; }
source "$(cd "$(dirname "$0")" && pwd)/lfund-admin.sh" # issuer actions, via the KYC desk once kyc.sh ran
q() { as lime-owner "$@" | tail -1 | tr -d '"'; }
step() { printf '\n== %s\n' "$*"; }
try() { # expect success/failure and say which contract error came back
  local out; out=$("$@"); local code=$?
  if [[ $code -eq 0 ]]; then echo "   ✓ succeeded"; else echo "   ✗ rejected: $(grep -oE 'Error\(Contract, #[0-9]+\)|balance is deauthorized|trustline entry is missing' <<<"$out" | head -1)"; fi
}

MARIA=$(stellar keys address lime-friend)
OWNER=$(stellar keys address lime-owner)
NEWBIE=$(stellar keys address lime-newbie)
FUND=$(stellar keys address lime-fund)
POOL=$(stellar contract alias show limeswap-lfund-xlm-30 "${N[@]}")
XLM=$(stellar contract id asset --asset native "${N[@]}")
LFUND_SAC=$(stellar contract alias show lfund-sac "${N[@]}")
lfund() { q --id lfund-sac -- balance --id "$1"; }
xlm() { q --id "$XLM" -- balance --id "$1"; }
shares() { q --id "$POOL" -- balance --account "$1"; }

step "1. LFUND issuer approves Maria (KYC passed); lime-owner sends her 50 LFUND; she adds liquidity"
lfund_authorize "$MARIA" true >/dev/null 2>&1
as lime-owner --id lfund-sac -- transfer --from "$OWNER" --to "$MARIA" --amount $((50 * ONE)) >/dev/null
as lime-friend --id "$POOL" -- deposit --from "$MARIA" --desired_a $((50 * ONE)) --desired_b $((50 * ONE)) --min_a 0 --min_b 0 >/dev/null
echo "   Maria: $(shares "$MARIA") LP shares, $(lfund "$MARIA") LFUND units left"

step "2. Issuer freezes Maria's LFUND trustline (e.g. a sanctions hit)"
lfund_authorize "$MARIA" false >/dev/null 2>&1
echo "   authorized: $(q --id lfund-sac -- authorized --id "$MARIA")"

step "3. Without compliance mode (v1–v2 behaviour): Maria sells 1 unit of her LP claim to lime-owner"
lfund_pool_compliance "$POOL" false >/dev/null 2>&1
try as lime-friend --id "$POOL" -- transfer --from "$MARIA" --to "$OWNER" --amount 1
echo "   → the freeze is bypassed: LP shares are a claim on LFUND the SAC can't see"

step "4. Compliance mode on: the same transfer, and a transfer to someone the issuer never approved"
lfund_pool_compliance "$POOL" true >/dev/null 2>&1
try as lime-friend --id "$POOL" -- transfer --from "$MARIA" --to "$OWNER" --amount 1
try as lime-owner --id "$POOL" -- transfer --from "$OWNER" --to "$NEWBIE" --amount 1
echo "   (#14 = NotAuthorizedHolder)"

step "5. Issuer force-redeems Maria's position: LFUND goes back to the issuer (burned), XLM to Maria"
X0=$(xlm "$MARIA")
OUT=$(lfund_force_redeem "$POOL" "$MARIA" "$FUND" true 2>/dev/null | tail -1)
X1=$(xlm "$MARIA")
echo "   [shares burned, LFUND seized] = $OUT"
echo "   Maria: $(shares "$MARIA") LP shares, +$(( (X1 - X0) / 100000 ))e-2 XLM received, still frozen: $(q --id lfund-sac -- authorized --id "$MARIA")"
echo "   pool: $(q --id "$POOL" -- info)"
