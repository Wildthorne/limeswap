#!/usr/bin/env bash
# Phase 3: LimeFX, an oracle-anchored stablecoin pool, next to an ordinary LimeSwap pool with the
# same liquidity for comparison. Test stablecoins LEUR / LUSD (issuer identity lime-fx).
# Oracle: Reflector FX feed on Testnet (live EUR/USD); our mock SEP-40 oracle on local.
#
# Usage:  ./fx-pool.sh [testnet|local]      (called by deploy.sh; safe to re-run)
set -euo pipefail

NET="${1:-testnet}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
REL="$HERE/releases"
ONE=10000000
DEADLINE=$(( $(date +%s) + 3600 ))
REFLECTOR_FX_TESTNET=CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W
BASE_FEE_BPS=${BASE_FEE_BPS:-5}
AMP=${AMP:-100}
owner() { stellar contract invoke --source-account lime-owner "${N[@]}" "$@" 2>/dev/null; }
quiet() { "$@" >/dev/null 2>&1; }
latest() { ls "$REL"/"$1"_v*.wasm | sort -V | tail -1; }
step() { printf '\n== %s\n' "$*"; }

OWNER=$(stellar keys address lime-owner)

step "1/5 Test stablecoins LEUR and LUSD (issuer lime-fx), 1,000,000 each to lime-owner"
stellar keys address lime-fx >/dev/null 2>&1 || stellar keys generate lime-fx >/dev/null
quiet stellar keys fund lime-fx "${N[@]}" || true
FX_ISSUER=$(stellar keys address lime-fx)
for C in LEUR LUSD; do
  ALIAS=$(tr 'A-Z' 'a-z' <<<"$C")-sac
  quiet stellar contract asset deploy --asset "$C:$FX_ISSUER" --source-account lime-fx "${N[@]}" --alias "$ALIAS" || true
  quiet stellar contract alias add "$ALIAS" --contract-id "$(stellar contract id asset --asset "$C:$FX_ISSUER" "${N[@]}")" "${N[@]}" --overwrite || true
  quiet stellar tx new change-trust --source-account lime-owner --line "$C:$FX_ISSUER" "${N[@]}" || true
  BAL=$(owner --id "$ALIAS" -- balance --id "$OWNER" | tr -d '"')
  if [[ "$BAL" == "0" ]]; then
    stellar contract invoke --source-account lime-fx "${N[@]}" --id "$ALIAS" -- mint --to "$OWNER" --amount $((1000000 * ONE)) >/dev/null 2>&1
  fi
done
LEUR=$(stellar contract alias show leur-sac "${N[@]}" 2>/dev/null)
LUSD=$(stellar contract alias show lusd-sac "${N[@]}" 2>/dev/null)
echo "   LEUR $LEUR"
echo "   LUSD $LUSD"

step "2/5 Oracle"
if [[ "$NET" == "testnet" ]]; then
  ORACLE=$REFLECTOR_FX_TESTNET
  echo "   Reflector FX feed $ORACLE"
else
  ORACLE=$(stellar contract deploy --wasm "$(latest lime_amm_mock_oracle)" --source-account lime-owner "${N[@]}" \
    --alias fx-oracle -- --admin "$OWNER" --base '{"Other":"USD"}' --decimals 14 --resolution 300 2>/dev/null | tail -1)
  # LimeFX's circuit breaker needs a history (7 records), so backfill 30 minutes at 300 s steps.
  NOW=$(date +%s)
  for k in 6 5 4 3 2 1 0; do
    owner --id "$ORACLE" -- set_price --asset '{"Other":"EUR"}' --price 112310000000000 --timestamp $(( NOW - k * 300 )) >/dev/null
  done
  echo "   mock SEP-40 oracle $ORACLE (EUR = 1.1231 USD, 7 records; keep it fresh with oracle-keeper.mjs)"
fi
EUR=$(owner --id "$ORACLE" -- lastprice --asset '{"Other":"EUR"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).price))')
echo "   EUR/USD now $(node -e "console.log(($EUR/1e14).toFixed(5))")"

step "3/5 Deploy LimeFX pool (base fee ${BASE_FEE_BPS} bps, amp ${AMP})"
# Tokens must be sorted the way the contract sorts them: by address bytes. Strkeys are base32
# (A–Z = 0–25, then 2–7), so a plain string compare gets it wrong; remap digits above letters.
key() { tr '234567' 'abcdef' <<<"$1"; }
if [[ "$(key "$LEUR")" < "$(key "$LUSD")" ]]; then A=$LEUR; B=$LUSD; AA='{"Other":"EUR"}'; AB='{"Other":"USD"}'
else A=$LUSD; B=$LEUR; AA='{"Other":"USD"}'; AB='{"Other":"EUR"}'; fi
# Hard price band ±30% around today's rate: LimeFX refuses to trade outside it, so even a
# compromised oracle can't price the pool into the ground. Price = token A in token B, 1e14 scale.
read -r MIN_P MAX_P < <(A_IS_EUR=$([[ "$A" == "$LEUR" ]] && echo 1 || echo 0) EUR="$EUR" node -e '
  const p = BigInt(process.env.EUR), S = 10n ** 14n;
  const [lo, hi] = process.env.A_IS_EUR === "1" ? [p * 7n / 10n, p * 13n / 10n] : [S * S * 10n / (p * 13n), S * S * 10n / (p * 7n)];
  console.log(lo.toString(), hi.toString());')
FX=$(stellar contract deploy --wasm "$(latest lime_amm_fx_pool)" --source-account lime-owner "${N[@]}" --alias limefx-eur-usd -- \
  --admin "$OWNER" --token_a "$A" --token_b "$B" --oracle "$ORACLE" --asset_a "$AA" --asset_b "$AB" \
  --base_fee_bps "$BASE_FEE_BPS" --amp "$AMP" --min_price "$MIN_P" --max_price "$MAX_P" 2>/dev/null | tail -1)
if [[ "$NET" == "testnet" ]]; then
  # Reflector posts each 300 s round up to ~70 s late; the default max_age (resolution + 60 s)
  # would make swaps revert for a few seconds every round. 480 s; the age surcharge prices the rest.
  PARAMS=$(owner --id "$FX" -- info | node -e 'process.stdin.on("data",d=>{const p=JSON.parse(d).params;p.max_age=480;console.log(JSON.stringify(p))})')
  owner --id "$FX" -- set_params --caller "$OWNER" --params "$PARAMS" >/dev/null
fi
echo "   LimeFX $FX  (trades only between $(node -e "console.log(($MIN_P/1e14).toFixed(4), 'and', ($MAX_P/1e14).toFixed(4))") A-in-B)"

step "4/5 Seed both pools with 10,000 LEUR + the same value in LUSD"
USD_AMT=$(node -e "console.log((10000n * BigInt($ONE) * BigInt('$EUR') / 10n**14n).toString())")
if [[ "$A" == "$LEUR" ]]; then DA=$((10000 * ONE)); DB=$USD_AMT; else DA=$USD_AMT; DB=$((10000 * ONE)); fi
# Mins at 99% of the amounts: a deposit can be sandwiched (skew the pool, let the deposit land at a
# bad ratio, unskew), so never deposit with min = 0 into a live pool.
MA=$(( DA / 100 * 99 )); MB=$(( DB / 100 * 99 ))
owner --id "$FX" -- deposit --from "$OWNER" --desired_a "$DA" --desired_b "$DB" --min_a "$MA" --min_b "$MB" >/dev/null
CP=$(owner --id limeswap-factory -- get_pool --token_a "$A" --token_b "$B" --fee_bps 5 | tr -d '"')
CP_SHARES=0
if [[ -n "$CP" && "$CP" != "null" ]]; then
  CP_SHARES=$(owner --id "$CP" -- info | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).total_shares))')
fi
if [[ "$CP_SHARES" == "0" ]]; then # seed the comparison pool once; later runs keep its liquidity
  owner --id limeswap-router -- add_liquidity --from "$OWNER" --token_a "$A" --token_b "$B" --fee_bps 5 \
    --desired_a "$DA" --desired_b "$DB" --min_a "$MA" --min_b "$MB" --deadline "$DEADLINE" >/dev/null
  CP=$(owner --id limeswap-factory -- get_pool --token_a "$A" --token_b "$B" --fee_bps 5 | tr -d '"')
fi
quiet stellar contract alias add limeswap-leur-lusd-5 --contract-id "$CP" "${N[@]}" --overwrite || true
echo "   LimeFX and LimeSwap 0.05% ($CP) both hold 10,000 LEUR + $(( USD_AMT / ONE )) LUSD"

# A LUSD/XLM pool links LimeFX to the rest of LimeSwap, so routes like XLM → LUSD → LEUR exist
# (LimeSwap hop, then LimeFX hop, in one router v2 `swap_route`). 1,000 XLM + 300 LUSD (0.30 $/XLM).
XLM=$(stellar contract id asset --asset native "${N[@]}")
UX=$(owner --id limeswap-factory -- get_pool --token_a "$LUSD" --token_b "$XLM" --fee_bps 30 | tr -d '"')
if [[ -z "$UX" || "$UX" == "null" ]]; then
  owner --id limeswap-router -- add_liquidity --from "$OWNER" --token_a "$XLM" --token_b "$LUSD" --fee_bps 30 \
    --desired_a $((1000 * ONE)) --desired_b $((300 * ONE)) --min_a 0 --min_b 0 --deadline "$DEADLINE" >/dev/null
  UX=$(owner --id limeswap-factory -- get_pool --token_a "$LUSD" --token_b "$XLM" --fee_bps 30 | tr -d '"')
fi
quiet stellar contract alias add limeswap-lusd-xlm-30 --contract-id "$UX" "${N[@]}" --overwrite || true
echo "   LUSD/XLM 0.3% ($UX) links LimeFX to XLM routes"

step "5/5 Compare: sell 1,000 / 3,000 LEUR for LUSD"
for X in 1000 3000; do
  QF=$(owner --id "$FX" -- quote --token_in "$LEUR" --amount_in $((X * ONE)))
  QC=$(owner --id limeswap-router -- quote --amount_in $((X * ONE)) --tokens "[\"$LEUR\",\"$LUSD\"]" --fees '[5]')
  X="$X" EUR="$EUR" QF="$QF" QC="$QC" node -e '
    const e = process.env, fair = Number(e.X) * Number(e.EUR) / 1e14;
    const f = JSON.parse(e.QF), fx = Number(f.amount_out) / 1e7, cp = Number(JSON.parse(e.QC).at(-1)) / 1e7;
    const loss = (v) => ((1 - v / fair) * 1e4).toFixed(1);
    console.log(`   ${e.X} LEUR: fair ${fair.toFixed(2)} | LimeFX ${fx.toFixed(2)} (−${loss(fx)} bps, fee ${f.fee_bps} bps) | LimeSwap ${cp.toFixed(2)} (−${loss(cp)} bps)`);'
done

QR=$(owner --id limeswap-router -- quote_route --amount_in $((100 * ONE)) --tokens "[\"$XLM\",\"$LUSD\",\"$LEUR\"]" \
  --hops "[{\"Pool\":30},{\"Fx\":\"$FX\"}]")
echo "   100 XLM → LUSD (LimeSwap 0.3%) → LEUR (LimeFX), router v2 quote_route: $QR"

HERE="$HERE" NET="$NET" FX="$FX" CP="$CP" UX="$UX" ORACLE="$ORACLE" LEUR="$LEUR" LUSD="$LUSD" node --input-type=module <<'JS'
import fs from "node:fs";
const e = process.env;
const f = `${e.HERE}/deployed.${e.NET}.json`;
const d = JSON.parse(fs.readFileSync(f, "utf8"));
Object.assign(d.tokens, { leur: e.LEUR, lusd: e.LUSD });
d.fx = { pool: e.FX, oracle: e.ORACLE, comparisonPool: e.CP };
d.pools = [...d.pools.filter((p) => p.id !== e.CP && p.id !== e.UX),
  { id: e.CP, pair: ["leur", "lusd"], feeBps: 5, note: "Plain x·y=k pool kept next to LimeFX for comparison: same tokens, priced only by its own reserves." }, { id: e.UX, pair: ["lusd", "xlm"], feeBps: 30 }];
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
JS
