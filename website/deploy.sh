#!/usr/bin/env bash
# Deploys the website (website/pages + website/functions) to Cloudflare Pages: https://adalkeep.pages.dev/
# Needs, once, in the environment of whoever deploys:
#   CLOUDFLARE_API_TOKEN   (Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers"/Pages template, or Account → Cloudflare Pages: Edit)
#   CLOUDFLARE_ACCOUNT_ID  (Cloudflare dashboard → Workers & Pages → right side)
# and, once, in the Pages project (Settings → Variables and Secrets, Production):
#   SUPABASE_URL, SUPABASE_SERVICE_KEY   (the same as adal-admin/.env; stored encrypted by Cloudflare)
# Nothing is deployed from here without the token. Never commit the token.
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
npx --yes wrangler@3 pages deploy pages --project-name "${PAGES_PROJECT:-adalkeep}" --branch main --commit-dirty=true
