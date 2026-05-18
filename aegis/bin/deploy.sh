#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

cd "$(dirname "$0")/.."

# Build the App Engine entrypoint before uploading this checkout.
pnpm build

# Deploy aegis to the mento-prod project
gcloud app deploy --project mento-prod --quiet
