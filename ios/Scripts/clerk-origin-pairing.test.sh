#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
pairing_lint=${script_directory}/clerk-origin-pairing-lint.sh

assert_rejected() {
  local exit_status=0
  "$@" >/dev/null 2>&1 || exit_status=$?
  if (( exit_status == 0 )); then
    print -u2 -r -- "expected the Clerk/API pairing to be rejected: $*"
    exit 1
  fi
  # 126/127 mean the lint never ran. A missing or non-executable enforcer must
  # not read as a rejection.
  if (( exit_status == 126 || exit_status == 127 )); then
    print -u2 -r -- "pairing lint did not execute (status ${exit_status}): $*"
    exit 1
  fi
}

test -x "$pairing_lint"

# A development Clerk instance cannot mint sessions the production API accepts.
assert_rejected env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_test_d2l0dHktd2FscnVzLTI3LmNsZXJrLmFjY291bnRzLmRldiQ \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=witty-walrus-27.clerk.accounts.dev \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"

# A production Clerk instance must not mint real seller sessions against a
# loopback API that no production tenant owns.
assert_rejected env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuc25hcGxpc3QuZGV2JA \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=clerk.snaplist.dev \
  SNAPLIST_API_ORIGIN=http://127.0.0.1:3001 \
  "$pairing_lint"

# Consistent pairings must stay buildable, or the enforcer is useless.
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuc25hcGxpc3QuZGV2JA \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=clerk.snaplist.dev \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_test_d2l0dHktd2FscnVzLTI3LmNsZXJrLmFjY291bnRzLmRldiQ \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=witty-walrus-27.clerk.accounts.dev \
  SNAPLIST_API_ORIGIN=http://127.0.0.1:3001 \
  "$pairing_lint"

# The key encodes its own frontend API domain. A key that disagrees with the
# declared domain would ship associated-domain credentials for one instance and
# tokens from another.
assert_rejected env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuc25hcGxpc3QuZGV2JA \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=witty-walrus-27.clerk.accounts.dev \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"

# A key with neither prefix is not a Clerk publishable key at all.
assert_rejected env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=clerk.snaplist.dev \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=clerk.snaplist.dev \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"

# Release builds carry no committed key. An absent or unexpanded value is
# release-config-lint.sh's contract, not a pairing inconsistency, so this lint
# stays silent about it rather than breaking configuration-less builds.
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY= \
  SNAPLIST_CLERK_FRONTEND_DOMAIN= \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"
env \
  'SNAPLIST_CLERK_PUBLISHABLE_KEY=$(SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY)' \
  'SNAPLIST_CLERK_FRONTEND_DOMAIN=$(SNAPLIST_RELEASE_CLERK_FRONTEND_DOMAIN)' \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"

# The committed Debug configuration must satisfy the lint it is subject to.
xcconfig_value() {
  local setting_value
  setting_value=$(
    /usr/bin/grep -E "^${2} = " "$1" | /usr/bin/tail -n 1
  ) || return 1
  setting_value=${setting_value#${2} = }
  print -r -- "${setting_value//\$\(\)/}"
}

shared_config=${repository_root}/ios/Configuration/SnapList.xcconfig
debug_config=${repository_root}/ios/Configuration/SnapList.Debug.xcconfig

env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY="$(xcconfig_value "$debug_config" SNAPLIST_CLERK_PUBLISHABLE_KEY)" \
  SNAPLIST_CLERK_FRONTEND_DOMAIN="$(xcconfig_value "$debug_config" SNAPLIST_CLERK_FRONTEND_DOMAIN)" \
  SNAPLIST_API_ORIGIN="$(xcconfig_value "$shared_config" SNAPLIST_API_ORIGIN)" \
  "$pairing_lint"

# The Release configuration inherits the same shared origin, so the injected
# production key must satisfy the same pairing.
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuc25hcGxpc3QuZGV2JA \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=clerk.snaplist.dev \
  SNAPLIST_API_ORIGIN="$(xcconfig_value "$shared_config" SNAPLIST_API_ORIGIN)" \
  "$pairing_lint"

# The lint is only an enforcer if every build runs it, so it stays wired into
# the app target ahead of compilation.
project_file=${repository_root}/ios/SnapList.xcodeproj/project.pbxproj

grep -Fq 'shellScript = "\"${SRCROOT}/Scripts/clerk-origin-pairing-lint.sh\"\n";' "$project_file"
if ! grep -Eq 'buildPhases = \(483600000000000000000002 /\* Validate Clerk instance and API origin pairing \*/, 400000000000000000000001 /\* Sources \*/' "$project_file"; then
  print -u2 -r -- "the pairing lint must run before the app target compiles"
  exit 1
fi

# CI proves the Release wiring with a synthetic live key that encodes no domain
# (see the `release` job in .github/workflows/ios.yml). A key whose payload is
# not a Clerk frontend domain cannot be compared, so the lint reports that it
# could not verify instead of failing a build it cannot judge.
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_ci_release_validation \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=release-clerk.example.invalid \
  SNAPLIST_API_ORIGIN=https://snaplist.dev \
  "$pairing_lint"
