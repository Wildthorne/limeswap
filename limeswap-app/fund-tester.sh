#!/usr/bin/env bash
# Fund the dApp's dev signer so Claude can test without a wallet extension.
#   ./fund-tester.sh [local]   → identity limeswap-tester, secret in .env.local as VITE_DEV_SECRET
#   ./fund-tester.sh testnet   → identity limeswap-qa,     secret in .env.local as VITE_DEV_SECRET_TESTNET
# Gives it XLM (friendbot), trustlines + LEUR/LUSD (minted by lime-fx), classic LIME (from lime-owner)
# and LFUND (authorized by its issuer lime-fund, from lime-owner). Test keys only: never Mainnet.
# The secret goes straight from the CLI into the git-ignored .env.local; it is never printed.
set -euo pipefail
NET="${1:-local}"
case "$NET" in
  local)   ID=limeswap-tester; VAR=VITE_DEV_SECRET ;;
  testnet) ID=limeswap-qa;     VAR=VITE_DEV_SECRET_TESTNET ;;
  *) echo "only local or testnet" >&2; exit 1 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
N=(--network "$NET")
quiet() { "$@" >/dev/null 2>&1; }
ONE=10000000

stellar keys address "$ID" >/dev/null 2>&1 || stellar keys generate "$ID" >/dev/null
T=$(stellar keys address "$ID")
quiet stellar keys fund "$ID" "${N[@]}" || true
for line in "LEUR:$(stellar keys address lime-fx)" "LUSD:$(stellar keys address lime-fx)" \
            "LIME:$(stellar keys address lime-issuer)" "LFUND:$(stellar keys address lime-fund)"; do
  quiet stellar tx new change-trust --source-account "$ID" --line "$line" "${N[@]}" || true
done
inv() { stellar contract invoke "${N[@]}" "$@" >/dev/null 2>&1; }
inv --id leur-sac --source-account lime-fx -- mint --to "$T" --amount $((5000 * ONE))
inv --id lusd-sac --source-account lime-fx -- mint --to "$T" --amount $((5000 * ONE))
inv --id lime-classic-sac --source-account lime-owner -- transfer --from "$(stellar keys address lime-owner)" --to "$T" --amount $((2000 * ONE))
source "$HERE/../lime-amm/lfund-admin.sh" # via the KYC desk once lime-amm/kyc.sh ran
lfund_authorize "$T" true >/dev/null 2>&1
inv --id lfund-sac --source-account lime-owner -- transfer --from "$(stellar keys address lime-owner)" --to "$T" --amount $((50 * ONE))

# Store the secret for the dev server / e2e (replace an existing line, keep everything else).
ENV="$HERE/.env.local"; touch "$ENV"; chmod 600 "$ENV"
grep -v "^$VAR=" "$ENV" > "$ENV.tmp" || true
printf '%s=%s\n' "$VAR" "$(stellar keys secret "$ID")" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"
echo "$ID $T funded on $NET: 5,000 LEUR + 5,000 LUSD, 2,000 LIME, 50 LFUND (authorized); $VAR set in .env.local"
