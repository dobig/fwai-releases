#!/usr/bin/env bash
# Build the desktop app for a stage, with its gateway, relay and site from
# deploy/stages/<stage>.env. Remaining arguments go to build-desktop-artifact.ts.
# A staging app has its own bundle id, scheme and ~/.fwai-staging, so it installs beside prod.
#
#   scripts/fwai-build-desktop.sh staging --platform mac --target dmg --arch arm64 --output-dir ~/fwai-builds
#
# With --signed on macOS, signing material comes from $FWAI_SIGNING_DIR/credentials.env
# (default ~/.fwai-signing), with the names dobig/fwai_app uses for the same Developer ID:
#   APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_ID,
#   APPLE_PASSWORD (app-specific, for notarizing), APPLE_TEAM_ID
# FWAI_SKIP_NOTARIZE=1 signs without notarizing; Gatekeeper then still warns on download.
set -euo pipefail

stage="${1:-}"
shift || true
case "$stage" in
  staging | prod) ;;
  *) echo "usage: scripts/fwai-build-desktop.sh staging|prod [build-desktop-artifact args...]" >&2; exit 2 ;;
esac
cd "$(git rev-parse --show-toplevel)"
. scripts/lib/fwai-stage.sh
fwai_load_stage "$stage"

fwai_signing_value() {
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

case " $* " in
  *" --signed "*)
    credentials="${FWAI_SIGNING_DIR:-$HOME/.fwai-signing}/credentials.env"
    [ -f "$credentials" ] || { echo "--signed needs $credentials" >&2; exit 1; }
    for key in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_TEAM_ID APPLE_ID APPLE_PASSWORD; do
      [ -n "$(fwai_signing_value "$key" "$credentials")" ] || { echo "$credentials does not set $key" >&2; exit 1; }
    done
    CSC_LINK="$(fwai_signing_value APPLE_CERTIFICATE "$credentials")"
    CSC_KEY_PASSWORD="$(fwai_signing_value APPLE_CERTIFICATE_PASSWORD "$credentials")"
    APPLE_TEAM_ID="$(fwai_signing_value APPLE_TEAM_ID "$credentials")"
    export CSC_LINK CSC_KEY_PASSWORD APPLE_TEAM_ID T3CODE_APPLE_TEAM_ID="$APPLE_TEAM_ID"
    if [ "${FWAI_SKIP_NOTARIZE:-}" = 1 ]; then
      echo "==> signing as team $APPLE_TEAM_ID, NOT notarizing"
      unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
    else
      APPLE_ID="$(fwai_signing_value APPLE_ID "$credentials")"
      APPLE_APP_SPECIFIC_PASSWORD="$(fwai_signing_value APPLE_PASSWORD "$credentials")"
      export APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
      echo "==> signing and notarizing as team $APPLE_TEAM_ID"
    fi
    ;;
esac

echo "==> desktop $stage (gateway $T3CODE_FWAI_GATEWAY_URL, relay $T3CODE_RELAY_URL)"
exec node scripts/build-desktop-artifact.ts "$@"
