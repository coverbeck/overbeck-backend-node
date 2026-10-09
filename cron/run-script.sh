#!/usr/bin/env bash
# Runs a script from the repo root with .env loaded. For cron, which starts in
# $HOME with a minimal PATH, so node (installed via nvm on the server) isn't found
# otherwise. Sourcing nvm here, as deploy.sh does, avoids hardcoding a node version
# path that would break on the next nvm upgrade.
#
#   cron/run-script.sh scripts/collect-forecasts.ts

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
fi
set -euo pipefail

cd "$(dirname "$0")/.."
exec node --env-file=.env "$@"
