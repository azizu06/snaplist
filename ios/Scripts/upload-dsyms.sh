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

is_archive=0
# Simulator Release builds use SKIP_INSTALL=NO too; ACTION=install remains the
# archive signal there, while device products with SKIP_INSTALL=NO must upload.
if [[ ${ACTION:-} == install ]] || {
  [[ ${SKIP_INSTALL:-} == NO ]] && [[ ${PLATFORM_NAME:-} != iphonesimulator ]]
}; then
  is_archive=1
fi

cannot_upload() {
  local message=$1

  if (( is_archive )); then
    print -u2 -r -- "error: ${message}"
    exit 65
  fi

  print -u2 -r -- "warning: ${message}"
  exit 0
}

if [[ -z ${DWARF_DSYM_FOLDER_PATH:-} ]]; then
  cannot_upload "DWARF_DSYM_FOLDER_PATH is unset; Sentry cannot symbolicate this build."
fi

if ! command -v sentry-cli >/dev/null 2>&1; then
  cannot_upload "sentry-cli is not installed, so Sentry cannot symbolicate this build. Install it with 'brew install getsentry/tools/sentry-cli'."
fi

if [[ -z ${SENTRY_AUTH_TOKEN:-} ]] && [[ ! -f ${HOME}/.sentryclirc ]]; then
  cannot_upload "no Sentry auth token configured, so Sentry cannot symbolicate this build. Set SENTRY_AUTH_TOKEN or run 'sentry-cli login'."
fi

# Auth is configured, so a failure here is a real one: a Release build whose
# symbols never arrive produces unreadable crash reports.
exec sentry-cli debug-files upload \
  --org "$sentry_organization" \
  --project "$sentry_project" \
  "$DWARF_DSYM_FOLDER_PATH"
