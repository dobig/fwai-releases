# shellcheck shell=bash
# Loads deploy/stages/<stage>.env and exports the client build variables from it.
# The file is the only source: values already in the shell are overwritten, and
# a missing value stops the script, so no build can leave the relay or gateway out.
fwai_load_stage() {
  local stage="$1" root file key
  root="$(git rev-parse --show-toplevel)"
  file="$root/deploy/stages/$stage.env"
  [ -f "$file" ] || { echo "unknown stage '$stage' (no $file)" >&2; return 2; }
  unset FWAI_GATEWAY_URL FWAI_CLIENT_ID FWAI_RELAY_URL FWAI_WEB_URL FWAI_WEB_HOST
  # shellcheck disable=SC1090
  . "$file"
  # FWAI_WEB_HOST is checked by scripts/fwai-deploy-web.sh; dobig/fwai-releases has no copy.
  for key in FWAI_GATEWAY_URL FWAI_CLIENT_ID FWAI_RELAY_URL FWAI_WEB_URL; do
    [ -n "${!key:-}" ] || { echo "$file does not set $key" >&2; return 1; }
  done
  # Desktop builds take their installed identity from it (packages/shared/src/fwaiDesktopIdentity.ts).
  export T3CODE_FWAI_STAGE="$stage"
  export T3CODE_FWAI_GATEWAY_URL="$FWAI_GATEWAY_URL"
  export T3CODE_FWAI_CLIENT_ID="$FWAI_CLIENT_ID"
  export T3CODE_RELAY_URL="$FWAI_RELAY_URL"
  export VITE_HOSTED_APP_URL="$FWAI_WEB_URL"
}
