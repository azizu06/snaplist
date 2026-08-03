#!/bin/zsh

# Uploads the debug symbols a Release build produces so Sentry can symbolicate
# iOS crash reports without anyone running a command by hand. Invoked by the
# SnapList target's "Upload Sentry dSYMs" build phase.
#
# Auth is owner-supplied and never committed: sentry-cli reads SENTRY_AUTH_TOKEN
# from the environment or an auth token from ~/.sentryclirc. Only the org and
# project names live here, and neither is a secret.

set -euo pipefail

sentry_organization=${SENTRY_ORG:-azizu}
sentry_project=${SENTRY_PROJECT:-snaplist}

if [[ ${CONFIGURATION:-} != "Release" ]]; then
  exit 0
fi

if [[ -z ${DWARF_DSYM_FOLDER_PATH:-} ]]; then
  print -u2 -r -- "warning: DWARF_DSYM_FOLDER_PATH is unset; skipping upload."
  exit 0
fi

if ! command -v sentry-cli >/dev/null 2>&1; then
  print -u2 -r -- \
    "warning: sentry-cli is not installed, so Sentry cannot symbolicate this" \
    "build. Install it with 'brew install getsentry/tools/sentry-cli'."
  exit 0
fi

if [[ -z ${SENTRY_AUTH_TOKEN:-} ]] && [[ ! -f ${HOME}/.sentryclirc ]]; then
  print -u2 -r -- \
    "warning: no Sentry auth token configured, so Sentry cannot symbolicate" \
    "this build. Set SENTRY_AUTH_TOKEN or run 'sentry-cli login'."
  exit 0
fi

# Auth is configured, so a failure here is a real one: a Release build whose
# symbols never arrive produces unreadable crash reports.
exec sentry-cli debug-files upload \
  --org "$sentry_organization" \
  --project "$sentry_project" \
  "$DWARF_DSYM_FOLDER_PATH"
