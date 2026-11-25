#!/usr/bin/env bash
# Move LimeSwap admin rights from one key (lime-owner) to a timelock controlled by a 2-of-3
# Stellar multisig account. Safe to re-run: every step checks what is already done.
#
#   ./governance.sh [testnet|local] setup    1-5 below, then schedules the timelock's accept_admin calls
#   ./governance.sh [testnet|local] accept   after the delay: executes them (timelock becomes admin)
#   ./governance.sh [testnet|local] status   who is admin / pending / guardian of what
#
# Needs factory v2, pools v5 and LimeFX v3 on the network first: run ./upgrade-pools.sh <net>.
#
# 1. Identity `lime-gov` (created + funded if missing) becomes a classic multisig account:
#    signers lime-owner, lime-friend, lime-issuer (weight 1 each), master key weight 0,
#    thresholds low/med/high = 2. Every transaction from it needs 2 of the 3 keys.
# 2. Timelock `limeswap-timelock` (releases/lime_amm_timelock_v1.wasm): proposer = lime-gov,
#    executors = none (anyone may execute a ready operation), canceller = lime-gov only
#    (2 of 3 keys to veto or act, see review M1 below), self-administered. Delay: 720 ledgers (~1 h)
#    on testnet, 12 ledgers (~1 min at 5 s/ledger) on local; override with DELAY=<ledgers>.
# 3. Guardian = lime-owner on every pool and LimeFX: it can still pause instantly, nothing else.
# 4. lime-owner proposes the timelock as admin of the factory, every pool and LimeFX.
# 5. lime-gov schedules accept_admin(timelock) on each; `accept` executes them after the delay.
#
# Afterwards upgrades / params go through ./gov-op.sh (schedule → wait → execute), and
# ./upgrade-pools.sh skips contracts whose admin is no longer lime-owner.
set -euo pipefail

NET="${1:-testnet}"; STEP="${2:-setup}"
N=(--network "$NET")
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$NET" in testnet) DEFAULT_DELAY=720 ;; *) DEFAULT_DELAY=12 ;; esac
DELAY="${DELAY:-$DEFAULT_DELAY}"
OWNER=$(stellar keys address lime-owner)
inv() { stellar contract invoke --source-account lime-owner "${N[@]}" "$@" 2>/dev/null; }
unq() { tr -d '"'; }

FACTORY=$(stellar contract alias show limeswap-factory "${N[@]}")
FX=$(stellar contract alias show limefx-eur-usd "${N[@]}" 2>/dev/null || true)
COUNT=$(inv --id "$FACTORY" -- pool_count)
POOLS=$(inv --id "$FACTORY" -- pools --start 0 --limit "$COUNT" | tr -d '[]"' | tr ',' ' ')
TL=$(stellar contract alias show limeswap-timelock "${N[@]}" 2>/dev/null || true)

# name:min_version:address  (pools and LimeFX also have a guardian)
TARGETS=("factory:2:$FACTORY")
for P in $POOLS; do TARGETS+=("pool:5:$P"); done
[ -n "$FX" ] && TARGETS+=("limefx:3:$FX")

# Id of the last accept_admin operation scheduled for contract $1 from this machine (or empty).
last_accept_op() {
  { grep "\"target\":\"$1\",\"fn\":\"accept_admin\"" "$HERE/governance.$NET.ops.jsonl" 2>/dev/null || true; } | tail -1 |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.trim()?JSON.parse(s).id:""))'
}

status() {
  printf "%-8s %-58s %-4s %-10s %-10s %s\n" kind contract ver admin pending guardian
  for T in "${TARGETS[@]}"; do
    IFS=: read -r KIND _ ID <<<"$T"
    who() { case "$1" in "$OWNER") echo lime-owner ;; "$TL") echo timelock ;; null|"") echo - ;; *) echo "${1:0:8}…" ;; esac; }
    V=$(inv --id "$ID" -- version)
    A=$(inv --id "$ID" -- admin | unq)
    PEND=$(inv --id "$ID" -- pending_admin 2>/dev/null | unq || echo "n/a")
    G=$( [ "$KIND" = factory ] && echo "" || inv --id "$ID" -- guardian 2>/dev/null | unq || echo "n/a")
    printf "%-8s %-58s v%-3s %-10s %-10s %s\n" "$KIND" "$ID" "$V" "$(who "$A")" "$(who "$PEND")" "$(who "$G")"
  done
}

if [ "$STEP" = status ]; then
  echo "timelock: ${TL:-not deployed}"
  [ -n "$TL" ] && echo "min delay: $(inv --id "$TL" -- get_min_delay) ledgers"
  status
  exit 0
fi

# ------------------------------------------------------------------ accept (after the delay)
if [ "$STEP" = accept ]; then
  [ -n "$TL" ] || { echo "no timelock on $NET: run setup first"; exit 1; }
  LOG="$HERE/governance.$NET.ops.jsonl"
  for T in "${TARGETS[@]}"; do
    IFS=: read -r KIND _ ID <<<"$T"
    [ "$(inv --id "$ID" -- admin | unq)" = "$TL" ] && { echo "$KIND $ID: timelock already admin"; continue; }
    OP=$(last_accept_op "$ID")
    [ -n "$OP" ] || { echo "$KIND $ID: no scheduled accept_admin in $LOG (run setup)"; continue; }
    STATE=$(node "$HERE/gov-op.mjs" "$NET" state "$OP")
    case "$STATE" in
      *'"Ready"'*)
        if "$HERE/gov-op.sh" "$NET" execute "$OP" >/dev/null; then echo "$KIND $ID: timelock is admin"
        else echo "$KIND $ID: executing op $OP failed (often a busy account sequence); re-run accept" >&2; fi ;;
      *) echo "$KIND $ID: op $OP not ready yet: $STATE" ;;
    esac
  done
  status
  exit 0
fi

[ "$STEP" = setup ] || { echo "usage: $0 [net] setup|accept|status"; exit 1; }

# ------------------------------------------------------------------ 0. versions
for T in "${TARGETS[@]}"; do
  IFS=: read -r KIND MIN ID <<<"$T"
  V=$(inv --id "$ID" -- version)
  [ "$V" -ge "$MIN" ] || { echo "$KIND $ID is v$V; needs v$MIN+ (two-step admin). Run ./upgrade-pools.sh $NET first."; exit 1; }
done

# ------------------------------------------------------------------ 1. multisig account lime-gov
if ! GOV=$(stellar keys address lime-gov 2>/dev/null); then
  stellar keys generate lime-gov "${N[@]}" --fund >/dev/null
  GOV=$(stellar keys address lime-gov)
  echo "created identity lime-gov $GOV"
fi
ACCOUNT=$(stellar ledger entry fetch account --account "$GOV" "${N[@]}" 2>/dev/null || true)
if ! grep -q "$GOV" <<<"$ACCOUNT"; then
  stellar keys fund lime-gov "${N[@]}" >/dev/null
  ACCOUNT=$(stellar ledger entry fetch account --account "$GOV" "${N[@]}")
  echo "funded lime-gov"
fi
SIGNER_KEYS=("$(stellar keys address lime-owner)" "$(stellar keys address lime-friend)" "$(stellar keys address lime-issuer)")
# Thresholds are 4 bytes (master, low, med, high), shown as hex in the JSON ledger entry.
MULTISIG_OK=$(ACCOUNT="$ACCOUNT" node -e '
  const a = JSON.stringify(JSON.parse(process.env.ACCOUNT));
  const keys = process.argv.slice(1);
  const th = (a.match(/"thresholds":"([0-9a-f]{8})"/) || [])[1];
  console.log(th === "00020202" && keys.every(k => a.includes(k)) ? "yes" : "no");
' "${SIGNER_KEYS[@]}")
if [ "$MULTISIG_OK" = yes ]; then
  echo "lime-gov $GOV is already a 2-of-3 multisig"
else
  # While thresholds are still 0, the master key alone signs. Signers first, thresholds last.
  for K in "${SIGNER_KEYS[@]}"; do
    stellar tx new set-options --source-account lime-gov "${N[@]}" --signer "$K" --signer-weight 1 >/dev/null
  done
  stellar tx new set-options --source-account lime-gov "${N[@]}" \
    --master-weight 0 --low-threshold 2 --med-threshold 2 --high-threshold 2 >/dev/null
  echo "lime-gov $GOV: signers lime-owner, lime-friend, lime-issuer; master off; 2-of-3"
fi

# ------------------------------------------------------------------ 2. timelock
if [ -n "$TL" ] && ! inv --id "$TL" -- version >/dev/null; then
  # Never replace a known timelock because one read failed: contracts may already trust it.
  echo "timelock $TL (alias limeswap-timelock) did not answer; check the RPC and retry" >&2; exit 1
fi
if [ -z "$TL" ]; then
  TL=$(stellar contract deploy --wasm "$HERE/releases/lime_amm_timelock_v1.wasm" --source-account lime-owner "${N[@]}" \
    --alias limeswap-timelock -- --min_delay "$DELAY" --proposers "[\"$GOV\"]" --executors '[]' \
    --cancellers '[]' 2>/dev/null | tail -1)
  # Review M1: no single-key canceller. lime-owner is the guardian (instant pause); if it could also
  # veto, one stolen key could pause everything and cancel every recovery operation forever. The
  # proposer multisig is a canceller by construction (2 of 3 keys to veto).
  echo "timelock deployed $TL (alias limeswap-timelock), min delay $DELAY ledgers"
else
  echo "timelock $TL already deployed, min delay $(inv --id "$TL" -- get_min_delay) ledgers"
fi

# ------------------------------------------------------------------ 3-5. guardian, propose, schedule accept
for T in "${TARGETS[@]}"; do
  IFS=: read -r KIND _ ID <<<"$T"
  A=$(inv --id "$ID" -- admin | unq)
  if [ "$A" = "$TL" ]; then echo "$KIND $ID: timelock already admin"; continue; fi
  if [ "$A" != "$OWNER" ]; then echo "$KIND $ID: admin is $A (not lime-owner) — skipped"; continue; fi
  if [ "$KIND" != factory ] && [ "$(inv --id "$ID" -- guardian | unq)" != "$OWNER" ]; then
    inv --id "$ID" -- set_guardian --caller "$OWNER" --guardian "\"$OWNER\"" >/dev/null
    echo "$KIND $ID: guardian = lime-owner (pause only)"
  fi
  if [ "$(inv --id "$ID" -- pending_admin | unq)" != "$TL" ]; then
    inv --id "$ID" -- propose_admin --caller "$OWNER" --new_admin "$TL" >/dev/null
    echo "$KIND $ID: proposed timelock as admin"
  fi
  OP=$(last_accept_op "$ID")
  if [ -n "$OP" ] && ! node "$HERE/gov-op.mjs" "$NET" state "$OP" | grep -q '"Unset"'; then
    echo "$KIND $ID: accept_admin already scheduled (op $OP)"
  else
    "$HERE/gov-op.sh" "$NET" schedule "$ID" accept_admin "{\"new_admin\":\"$TL\"}" | head -1
  fi
done

echo
echo "Scheduled. After $DELAY ledgers (~$((DELAY * 5 / 60)) min at 5 s/ledger) run: ./governance.sh $NET accept"
