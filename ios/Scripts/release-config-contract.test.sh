#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
release_lint=${script_directory}/release-config-lint.sh
project_file=${repository_root}/ios/SnapList.xcodeproj/project.pbxproj
debug_config=${repository_root}/ios/Configuration/SnapList.Debug.xcconfig
release_config=${repository_root}/ios/Configuration/SnapList.Release.xcconfig
entitlements=${repository_root}/ios/SnapList/SnapList.entitlements

assert_rejected() {
  if "$@" >/dev/null 2>&1; then
    print -u2 -r -- "expected Release configuration to be rejected"
    exit 1
  fi
}

test -x "$release_lint"
test -f "$debug_config"
test -f "$release_config"
grep -Fq 'SnapList.Debug.xcconfig' "$project_file"
grep -Fq 'SnapList.Release.xcconfig' "$project_file"
grep -Eq '^SNAPLIST_CLERK_PUBLISHABLE_KEY = pk_(live|test)_' "$debug_config"
if grep -Fq 'pk_test_' "$release_config"; then
  print -u2 -r -- "Release configuration contains a development Clerk key"
  exit 1
fi
if grep -Fq 'pk_' "$release_config"; then
  print -u2 -r -- "Release configuration contains a committed Clerk key"
  exit 1
fi
grep -Fq 'webcredentials:$(SNAPLIST_CLERK_FRONTEND_DOMAIN)' "$entitlements"

assert_rejected env \
  SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY=pk_test_rejected \
  SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN=release-clerk.example.invalid \
  "$release_lint"
assert_rejected env \
  SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY=pk_live_valid \
  SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN=witty-walrus-27.clerk.accounts.dev \
  "$release_lint"

env \
  SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY=pk_live_valid \
  SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN=release-clerk.example.invalid \
  "$release_lint"
