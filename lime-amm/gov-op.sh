#!/usr/bin/env bash
# Run one timelock operation for LimeSwap governance (after ./governance.sh has made the
# timelock the admin). Unsigned transactions come from gov-op.mjs; the CLI signs and sends them.
#
#   ./gov-op.sh <net> schedule <target> <fn> '<args-json>'   proposer = lime-gov (2-of-3 multisig),
#                                                            signed by $GOV_SIGNERS (default: lime-owner lime-friend)
#   ./gov-op.sh <net> execute <op-id>                        after the delay; anyone may execute (lime-owner pays)
#   ./gov-op.sh <net> state <op-id>                          Unset | Waiting | Ready | Done (+ ready ledger)
#   ./gov-op.sh <net> cancel <op-id>                         veto: lime-gov multisig, signed by $GOV_SIGNERS
#   ./gov-op.sh <net> list                                   operations scheduled from this machine
#
# <args-json> = the target function's arguments by name; the timelock itself is the admin, so
# `caller` is the timelock address. Example (upgrade a pool):
#   TL=$(stellar contract alias show limeswap-timelock --network testnet)
#   HASH=$(stellar contract upload --wasm releases/lime_amm_pool_v6.wasm --source lime-owner --network testnet)
#   ./gov-op.sh testnet schedule CBNC… upgrade "{\"caller\":\"$TL\",\"new_wasm_hash\":\"0x$HASH\"}"
# Every scheduled operation (target, fn, args, salt, id) is appended to governance.<net>.ops.jsonl,
# which `execute <op-id>` reads back (the exact call must be repeated to execute it).
set -euo pipefail
NET="${1:?network}"; CMD="${2:?command}"; shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/governance.$NET.ops.jsonl"
SIGNERS=${GOV_SIGNERS:-"lime-owner lime-friend"}

sign_and_send() { # stdin: unsigned XDR; $@: signer identities
  local tx; tx=$(cat)
  for k in "$@"; do tx=$(stellar tx sign --sign-with-key "$k" --network "$NET" <<<"$tx"); done
  stellar tx send --network "$NET" <<<"$tx" >/dev/null
}

case "$CMD" in
  schedule)
    TARGET="$1"; FN="$2"; ARGS="${3:-}"; [ -n "$ARGS" ] || ARGS='{}'
    SALT="0x$(openssl rand -hex 32)"
    ID=$(node "$HERE/gov-op.mjs" "$NET" id "$TARGET" "$FN" "$ARGS" --salt "$SALT")
    # shellcheck disable=SC2086
    node "$HERE/gov-op.mjs" "$NET" schedule "$TARGET" "$FN" "$ARGS" --salt "$SALT" | sign_and_send $SIGNERS
    node -e 'console.log(JSON.stringify({id:process.argv[1],target:process.argv[2],fn:process.argv[3],args:JSON.parse(process.argv[4]),salt:process.argv[5],at:new Date().toISOString()}))' \
      "$ID" "$TARGET" "$FN" "$ARGS" "$SALT" >> "$LOG"
    echo "scheduled $FN on $TARGET   op $ID"
    node "$HERE/gov-op.mjs" "$NET" state "$ID"
    ;;
  execute)
    ID="${1#0x}"
    LINE=$(grep "\"id\":\"$ID\"" "$LOG" | tail -1) || { echo "op $ID not in $LOG"; exit 1; }
    read -r TARGET FN ARGS SALT < <(node -e 'const o=JSON.parse(process.argv[1]);console.log(o.target,o.fn,JSON.stringify(o.args),o.salt)' "$LINE")
    node "$HERE/gov-op.mjs" "$NET" execute "$TARGET" "$FN" "$ARGS" --salt "$SALT" | sign_and_send lime-owner
    echo "executed $FN on $TARGET   op $ID"
    node "$HERE/gov-op.mjs" "$NET" state "$ID"
    ;;
  state)
    node "$HERE/gov-op.mjs" "$NET" state "${1#0x}"
    ;;
  cancel)
    # shellcheck disable=SC2086
    node "$HERE/gov-op.mjs" "$NET" cancel "${1#0x}" | sign_and_send $SIGNERS
    node "$HERE/gov-op.mjs" "$NET" state "${1#0x}"
    ;;
  list)
    [ -f "$LOG" ] && cat "$LOG" || echo "(none)"
    ;;
  *) echo "unknown command $CMD"; exit 1 ;;
esac
