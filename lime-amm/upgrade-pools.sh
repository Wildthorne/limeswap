#!/usr/bin/env bash
# Bring a network up to the latest releases/: every LimeSwap pool upgraded in place to the newest
# lime_amm_pool_vN.wasm (+ its migration), the factory pointed at that code for future pools,
# LimeFX upgraded, the factory upgraded, and a newer router redeployed. Admin = lime-owner.
#
# After ./governance.sh has handed a contract to the timelock, lime-owner can no longer upgrade
# it: such contracts are skipped and the script prints the ./gov-op.sh command that schedules
# the same call through the timelock (2-of-3 multisig, then execute after the delay).
#
# Usage:  ./upgrade-pools.sh [testnet|local]
# Release flow: bump VERSION in the contract → stellar contract build →
#   copy the wasm to releases/<name>_vN.wasm → cargo test → ./upgrade-pools.sh <net>
# Order matters: pools first (router v2 calls the pools' v4 deposit_raw/tokens).
set -euo pipefail

NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
OWNER=$(stellar keys address lime-owner)
inv() { stellar contract invoke --source-account lime-owner "${N[@]}" "$@" 2>/dev/null; }
admin_of() { inv --id "$1" -- admin | tr -d '"'; }
# Print the timelock route for a call lime-owner can no longer make. $1 contract, $2 fn, $3 args JSON (without caller).
via_timelock() {
  echo "   $1: admin is $(admin_of "$1") (not lime-owner) → skipped. Through the timelock:"
  echo "     ./gov-op.sh $NET schedule $1 $2 '{\"caller\":\"$(admin_of "$1")\",$3}'"
}

# Factory: upgrade in place when releases/ has a newer lime_amm_factory_vN.wasm (v2 adds the
# two-step admin transfer that governance.sh needs).
F_WASM=$(ls "$HERE"/releases/lime_amm_factory_v*.wasm | sort -V | tail -1)
F_REL=$(basename "$F_WASM" .wasm); F_REL=${F_REL##*_v}
F_ON=$(inv --id limeswap-factory -- version)
if [ "$F_ON" -lt "$F_REL" ]; then
  F_HASH=$(stellar contract upload --wasm "$F_WASM" --source-account lime-owner "${N[@]}" 2>/dev/null | tail -1)
  if [ "$(admin_of limeswap-factory)" = "$OWNER" ]; then
    inv --id limeswap-factory -- upgrade --caller "$OWNER" --new_wasm_hash "$F_HASH" >/dev/null
    echo "factory v$F_ON → v$(inv --id limeswap-factory -- version)"
  else
    via_timelock "$(stellar contract alias show limeswap-factory "${N[@]}")" upgrade "\"new_wasm_hash\":\"0x$F_HASH\""
  fi
else
  echo "factory already v$F_ON"
fi

WASM=$(ls "$HERE"/releases/lime_amm_pool_v*.wasm | sort -V | tail -1)
HASH=$(stellar contract upload --wasm "$WASM" --source-account lime-owner "${N[@]}" 2>/dev/null | tail -1)
echo "pool code $(basename "$WASM")  $HASH"

COUNT=$(inv --id limeswap-factory -- pool_count)
POOLS=$(inv --id limeswap-factory -- pools --start 0 --limit "$COUNT" | tr -d '[]"' | tr ',' ' ')
REL=$(basename "$WASM" .wasm); REL=${REL##*_v}
for P in $POOLS; do
  FROM=$(inv --id "$P" -- version)
  if [ "$FROM" -ge "$REL" ]; then echo "   $P  already v$FROM"; continue; fi
  if [ "$(admin_of "$P")" != "$OWNER" ]; then
    via_timelock "$P" upgrade "\"new_wasm_hash\":\"0x$HASH\""
    continue
  fi
  inv --id "$P" -- upgrade --caller "$OWNER" --new_wasm_hash "$HASH" >/dev/null
  inv --id "$P" -- migrate --caller "$OWNER" >/dev/null
  echo "   $P  v$FROM → v$(inv --id "$P" -- version)"
done
if [ "$(admin_of limeswap-factory)" = "$OWNER" ]; then
  inv --id limeswap-factory -- set_pool_wasm --caller "$OWNER" --pool_wasm_hash "$HASH" >/dev/null
  echo "factory now deploys $HASH"
elif [ "$(inv --id limeswap-factory -- pool_wasm_hash | tr -d '"')" != "$HASH" ]; then
  via_timelock "$(stellar contract alias show limeswap-factory "${N[@]}")" set_pool_wasm "\"pool_wasm_hash\":\"0x$HASH\""
fi

# LimeFX: upgrade in place when releases/ has a newer lime_amm_fx_pool_vN.wasm.
FX_WASM=$(ls "$HERE"/releases/lime_amm_fx_pool_v*.wasm | sort -V | tail -1)
FX_REL=$(basename "$FX_WASM" .wasm); FX_REL=${FX_REL##*_v}
if FX=$(stellar contract alias show limefx-eur-usd "${N[@]}" 2>/dev/null) && [ -n "$FX" ]; then
  FX_ON=$(inv --id "$FX" -- version)
  if [ "$FX_ON" -lt "$FX_REL" ]; then
    FX_HASH=$(stellar contract upload --wasm "$FX_WASM" --source-account lime-owner "${N[@]}" 2>/dev/null | tail -1)
    if [ "$(admin_of "$FX")" = "$OWNER" ]; then
      inv --id "$FX" -- upgrade --caller "$OWNER" --new_wasm_hash "$FX_HASH" >/dev/null
      echo "LimeFX $FX  v$FX_ON → v$(inv --id "$FX" -- version)"
    else
      via_timelock "$FX" upgrade "\"new_wasm_hash\":\"0x$FX_HASH\""
    fi
  else
    echo "LimeFX already v$FX_ON"
  fi
fi

# Router: no admin and no upgrade, so a newer release means a new deployment (it holds no
# funds or state besides the factory). Updates the alias and every file that names it.
R_WASM=$(ls "$HERE"/releases/lime_amm_router_v*.wasm | sort -V | tail -1)
R_REL=$(basename "$R_WASM" .wasm); R_REL=${R_REL##*_v}
R_ON=$(inv --id limeswap-router -- version)
if [ "$R_ON" -lt "$R_REL" ]; then
  FACTORY=$(stellar contract alias show limeswap-factory "${N[@]}")
  OLD_ROUTER=$(stellar contract alias show limeswap-router "${N[@]}")
  ROUTER=$(stellar contract deploy --wasm "$R_WASM" --source-account lime-owner "${N[@]}" \
    --alias limeswap-router -- --factory "$FACTORY" 2>/dev/null | tail -1)
  HERE="$HERE" NET="$NET" OLD="$OLD_ROUTER" NEW="$ROUTER" node --input-type=module <<'JS'
import fs from "node:fs";
const e = process.env;
for (const f of [`${e.HERE}/deployed.${e.NET}.json`, `${e.HERE}/../deployed.${e.NET}.json`, `${e.HERE}/../watchtower/watchlist.${e.NET}.json`]) {
  if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replaceAll(e.OLD, e.NEW));
}
JS
  echo "router v$R_ON $OLD_ROUTER → v$R_REL $ROUTER (alias limeswap-router, deployed + watchlist files updated)"
else
  echo "router already v$R_ON"
fi
