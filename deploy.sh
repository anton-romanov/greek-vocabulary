#!/bin/sh
# Builds dist/ from the static files and publishes it with the functions to Cloudflare Pages.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
set -eu
cd "$(dirname "$0")"
if grep -q 'id = "KV_NAMESPACE_ID"' wrangler.toml; then
  echo "wrangler.toml still has the placeholder KV namespace id; create the namespace and put its id there." >&2
  exit 1
fi
rm -rf dist
mkdir dist
cp index.html sw.js manifest.webmanifest icon-192.png icon-512.png _headers dist/
npx -y wrangler@4 pages deploy --project-name greek-vocabulary --branch main --commit-dirty=true
