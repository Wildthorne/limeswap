#!/usr/bin/env bash
# Deploy (once) and fill the demo faucet: anyone can claim 100 LEUR + 100 LUSD + 100 LIME per day.
# The public website calls `claim` signed by the visitor's wallet; no secret key lives in the site.
# Usage: ./faucet.sh [testnet|local]   (after fx-pool.sh; refills to the target balances on re-run)
set -euo pipefail
NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
ONE=10000000
OWNER=$(stellar keys address lime-owner)
inv() { stellar contract invoke "${N[@]}" "$@" 2>/dev/null; }
LEUR=$(stellar contract alias show leur-sac "${N[@]}" 2>/dev/null)
LUSD=$(stellar contract alias show lusd-sac "${N[@]}" 2>/dev/null)
LIME=$(stellar contract alias show lime-classic-sac "${N[@]}" 2>/dev/null)

F=$(stellar contract alias show limeswap-faucet "${N[@]}" 2>/dev/null || true)
if [ -z "$F" ] || ! inv --source-account lime-owner --id "$F" -- version >/dev/null; then
  DRIPS="[{\"token\":\"$LEUR\",\"amount\":\"$((100 * ONE))\"},{\"token\":\"$LUSD\",\"amount\":\"$((100 * ONE))\"},{\"token\":\"$LIME\",\"amount\":\"$((100 * ONE))\"}]"
  F=$(stellar contract deploy --wasm "$HERE/releases/lime_amm_faucet_v1.wasm" --source-account lime-owner "${N[@]}" \
    --alias limeswap-faucet -- --admin "$OWNER" --drips "$DRIPS" --cooldown 86400 2>/dev/null | tail -1)
  echo "faucet deployed $F (alias limeswap-faucet): 100 LEUR + 100 LUSD + 100 LIME per address per day"
fi

# Top up to 100,000 LEUR / LUSD (minted by their issuer lime-fx) and 20,000 LIME (from lime-owner).
top() { # token, target units, source identity, mint|transfer
  local have; have=$(inv --source-account lime-owner --send=no --id "$1" -- balance --id "$F" | tr -d '"')
  local need=$(( $2 * ONE - have ))
  if [ "$need" -gt 0 ]; then
    if [ "$4" = mint ]; then inv --source-account "$3" --id "$1" -- mint --to "$F" --amount "$need" >/dev/null
    else inv --source-account "$3" --id "$1" -- transfer --from "$(stellar keys address "$3")" --to "$F" --amount "$need" >/dev/null; fi
  fi
}
top "$LEUR" 100000 lime-fx mint
top "$LUSD" 100000 lime-fx mint
top "$LIME" 20000 lime-owner transfer
echo "faucet $F holds 100,000 LEUR, 100,000 LUSD, 20,000 LIME"

HERE="$HERE" NET="$NET" F="$F" node --input-type=module -e '
import fs from "node:fs";
const e = process.env, f = `${e.HERE}/deployed.${e.NET}.json`;
const d = JSON.parse(fs.readFileSync(f, "utf8")); d.faucet = e.F;
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");'
