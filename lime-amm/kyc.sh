#!/usr/bin/env bash
# Mock KYC desk for LFUND (Testnet demo): deploys contracts/kyc, makes it the admin of LFUND's SAC,
# and syncs the desk with today's trustlines: approved holders are marked Verified (no grant),
# frozen ones Revoked (they can't self-verify). Then anyone can call `verify` from the website to
# get approved + a 20 LFUND starter grant. The issuer keeps freeze/clawback/pool powers through
# the desk's pass-through functions (`lfund-admin.sh` wraps them for scripts).
#
# Usage:  ./kyc.sh [testnet|local]      (after compliance-pool.sh; safe to re-run)
#   Rehearsal on another asset: ISSUER_ID=… CODE=… SAC_ALIAS=… ALIAS=… POOL_ALIAS= DEPLOYED=0 ./kyc.sh testnet
set -euo pipefail
NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
ONE=10000000
ISSUER_ID="${ISSUER_ID:-lime-fund}"
CODE="${CODE:-LFUND}"
SAC_ALIAS="${SAC_ALIAS:-lfund-sac}"
ALIAS="${ALIAS:-lfund-kyc}"
POOL_ALIAS="${POOL_ALIAS-limeswap-lfund-xlm-30}"
GRANT="${GRANT:-20}"
inv() { stellar contract invoke "${N[@]}" "$@" 2>/dev/null; }
ro() { inv --source-account lime-owner --send=no "$@" | tail -1 | tr -d '"'; }

ISSUER=$(stellar keys address "$ISSUER_ID")
SAC=$(stellar contract alias show "$SAC_ALIAS" "${N[@]}" 2>/dev/null)

DESK=$(stellar contract alias show "$ALIAS" "${N[@]}" 2>/dev/null || true)
if [ -z "$DESK" ] || ! inv --source-account lime-owner --send=no --id "$DESK" -- version >/dev/null; then
  DESK=$(stellar contract deploy --wasm "$HERE/releases/lime_amm_kyc_v1.wasm" --source-account "$ISSUER_ID" "${N[@]}" \
    --alias "$ALIAS" -- --issuer "$ISSUER" --token "$SAC" --grant $((GRANT * ONE)) 2>/dev/null | tail -1)
  echo "   KYC desk deployed $DESK (alias $ALIAS), grant $GRANT $CODE"
fi

if [ "$(ro --id "$SAC" -- admin)" != "$DESK" ]; then
  inv --source-account "$ISSUER_ID" --id "$SAC" -- set_admin --new_admin "$DESK" >/dev/null
fi
echo "   $CODE SAC admin: $(ro --id "$SAC" -- admin) (desk)"

# Sync the desk with existing trustlines (Horizon lists every account holding one).
case "$NET" in
  local) HORIZON=http://localhost:8000 ;;
  *) HORIZON=https://horizon-testnet.stellar.org ;;
esac
HOLDERS=$(curl -s "$HORIZON/accounts?asset=$CODE:$ISSUER&limit=200" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    for (const a of JSON.parse(s)._embedded.records) {
      const b = a.balances.find((x) => x.asset_code === process.argv[1] && x.asset_issuer === process.argv[2]);
      console.log(a.account_id, b.is_authorized ? "true" : "false");
    }
  });' "$CODE" "$ISSUER")
while read -r ACC AUTH; do
  [ -z "$ACC" ] && continue
  if [ "$(ro --id "$DESK" -- status --user "$ACC")" = "0" ]; then
    inv --source-account "$ISSUER_ID" --id "$DESK" -- set_status --user "$ACC" --verified "$AUTH" >/dev/null
    echo "   synced ${ACC:0:6}…: $([ "$AUTH" = true ] && echo verified || echo revoked)"
  fi
done <<<"$HOLDERS"

# The compliance pool now checks the desk as LFUND's admin: prove the pass-through works.
if [ -n "$POOL_ALIAS" ] && POOL=$(stellar contract alias show "$POOL_ALIAS" "${N[@]}" 2>/dev/null); then
  inv --source-account "$ISSUER_ID" --id "$DESK" -- pool_set_compliance --pool "$POOL" --enabled true >/dev/null
  echo "   compliance pool via desk: $(ro --id "$POOL" -- compliance | tr -d '\n ')"
fi

if [ "${DEPLOYED:-1}" = 1 ]; then
  HERE="$HERE" NET="$NET" DESK="$DESK" node --input-type=module -e '
  import fs from "node:fs";
  const e = process.env, f = `${e.HERE}/deployed.${e.NET}.json`;
  const d = JSON.parse(fs.readFileSync(f, "utf8")); d.kyc = { lfund: e.DESK };
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");'
fi
