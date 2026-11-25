#!/usr/bin/env bash
# Publish the Testnet demo to Cloudflare Pages (project "limeswap" → https://limeswap-t2l.pages.dev).
# Builds for Testnet, refuses to publish if a dev-signer key from .env.local is in the bundle, then
# deploys dist/ (including public/_headers: CSP + security headers). Needs `npx wrangler@4 login` once
# (scopes: account:read user:read pages:write).
set -euo pipefail
cd "$(dirname "$0")"
npm run build >/dev/null
if [ -f .env.local ]; then
  while IFS='=' read -r k v; do
    case "$k" in VITE_DEV_SECRET*) [ -n "$v" ] && grep -rlq -- "$v" dist && { echo "ABORT: $k is inside dist/; not deploying" >&2; exit 1; } ;; esac
  done < .env.local
fi
echo "build clean: no dev-signer key in dist/"
npx --yes wrangler@4 pages deploy dist --project-name limeswap --branch main --commit-dirty=true 2>&1 | grep -E "Success|Deployment complete|ERROR"
echo "live: https://limeswap-t2l.pages.dev"
