#!/bin/zsh

set -euo pipefail

clerk_key=${SNAPLIST_CLERK_PUBLISHABLE_KEY:-}
clerk_domain=${SNAPLIST_CLERK_FRONTEND_DOMAIN:-}
api_origin=${SNAPLIST_API_ORIGIN:-}

api_host=${${api_origin#*://}%%/*}
api_host=${api_host%%:*}
api_host=${api_host:l}

# A Clerk publishable key is base64 of "<frontend API domain>$" behind a
# pk_test_ or pk_live_ prefix, so the key states which instance it belongs to.
key_frontend_domain() {
  local payload=${1#pk_test_}
  payload=${payload#pk_live_}
  while (( ${#payload} % 4 )); do
    payload+='='
  done
  local decoded
  decoded=$(print -n -- "$payload" | /usr/bin/openssl base64 -d -A 2>/dev/null) || return 1
  [[ $decoded == *'$' ]] || return 1
  print -r -- "${decoded%\$}"
}

# Debug and direct script calls can have no resolved key. A Release build cannot:
# the resolved value is what lands in Info.plist and what SnapList reads at launch.
if [[ -z $clerk_key || $clerk_key == *'$('* ]]; then
  if [[ ${CONFIGURATION:-} == Release ]]; then
    print -u2 -r -- "error: Release requires SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY to resolve to a concrete Clerk publishable key."
    exit 65
  fi
  exit 0
fi

if [[ $clerk_domain == *'$('* ]]; then
  clerk_domain=
fi

if [[ $clerk_key != pk_test_* && $clerk_key != pk_live_* ]]; then
  print -u2 -r -- "error: SNAPLIST_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key."
  exit 65
fi

if [[ $clerk_key == pk_test_* && ( $api_host == snaplist.dev || $api_host == *.snaplist.dev ) ]]; then
  print -u2 -r -- "error: a development Clerk instance cannot authenticate against ${api_origin}."
  exit 65
fi

if [[ $clerk_key == pk_live_* && ( $api_host == localhost || $api_host == 127.0.0.1 || $api_host == '::1' || $api_host == '[::1]' ) ]]; then
  print -u2 -r -- "error: a production Clerk instance cannot authenticate against ${api_origin}."
  exit 65
fi

if [[ -n $clerk_domain ]]; then
  # CI proves the Release wiring with a synthetic live key that encodes no
  # domain, so an undecodable payload is reported rather than failed. Every real
  # Clerk key decodes.
  key_domain=$(key_frontend_domain "$clerk_key") || {
    print -u2 -r -- "warning: SNAPLIST_CLERK_PUBLISHABLE_KEY encodes no frontend API domain, so it cannot be checked against ${clerk_domain}."
    exit 0
  }
  if [[ ${key_domain:l} != ${clerk_domain:l} ]]; then
    print -u2 -r -- "error: the Clerk publishable key belongs to ${key_domain}, but SNAPLIST_CLERK_FRONTEND_DOMAIN declares ${clerk_domain}."
    exit 65
  fi
fi
