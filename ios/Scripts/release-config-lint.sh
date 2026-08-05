#!/bin/zsh

set -euo pipefail

clerk_key=${SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY:-}
clerk_domain=${SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN:-}

if [[ $clerk_key != pk_live_* ]]; then
  print -u2 -r -- "Release requires SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY with pk_live_."
  exit 65
fi

if [[ -z $clerk_domain || $clerk_domain == *'$('* || $clerk_domain == *' '* ]]; then
  print -u2 -r -- "Release requires a concrete SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN."
  exit 65
fi

if [[ $clerk_domain == 'witty-walrus-27.clerk.accounts.dev' ]]; then
  print -u2 -r -- "Release cannot use the development Clerk frontend domain."
  exit 65
fi
