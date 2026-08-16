#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
release_lint=${script_directory}/release-config-lint.sh
pairing_lint=${script_directory}/clerk-origin-pairing-lint.sh
dsyms_upload=${script_directory}/upload-dsyms.sh
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

assert_rejected_with() {
  local expected_message=$1
  shift

  local output
  if output=$("$@" 2>&1); then
    print -u2 -r -- "expected command to be rejected"
    exit 1
  fi
  if [[ $output != *"$expected_message"* ]]; then
    print -u2 -r -- "expected rejection to contain: ${expected_message}"
    print -u2 -r -- "$output"
    exit 1
  fi
}

assert_succeeds_with() {
  local expected_message=$1
  shift

  local output
  if ! output=$("$@" 2>&1); then
    print -u2 -r -- "expected command to succeed"
    print -u2 -r -- "$output"
    exit 1
  fi
  if [[ $output != *"$expected_message"* ]]; then
    print -u2 -r -- "expected output to contain: ${expected_message}"
    print -u2 -r -- "$output"
    exit 1
  fi
}

test -x "$release_lint"
test -x "$pairing_lint"
test -x "$dsyms_upload"
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

assert_rejected_with 'SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY' env \
  CONFIGURATION=Release \
  SNAPLIST_CLERK_PUBLISHABLE_KEY= \
  "$pairing_lint"
assert_rejected_with 'SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY' env \
  CONFIGURATION=Release \
  SNAPLIST_CLERK_PUBLISHABLE_KEY='$(SNAPLIST_RELEASE_CLERK_PUBLISHABLE_KEY)' \
  "$pairing_lint"
assert_rejected_with 'development Clerk instance cannot authenticate' env \
  CONFIGURATION=Release \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_test_rejected \
  SNAPLIST_API_ORIGIN=https://api.snaplist.dev \
  "$pairing_lint"
env \
  CONFIGURATION=Release \
  SNAPLIST_CLERK_PUBLISHABLE_KEY=pk_live_cmVsZWFzZS1jbGVyay5leGFtcGxlLmludmFsaWQk \
  SNAPLIST_CLERK_FRONTEND_DOMAIN=release-clerk.example.invalid \
  SNAPLIST_API_ORIGIN=https://api.snaplist.dev \
  "$pairing_lint"
env \
  CONFIGURATION=Debug \
  SNAPLIST_CLERK_PUBLISHABLE_KEY= \
  "$pairing_lint"
env \
  SNAPLIST_CLERK_PUBLISHABLE_KEY= \
  "$pairing_lint"

test_path=$(mktemp -d)
trap 'rm -rf "$test_path"' EXIT
fake_sentry_cli=${test_path}/sentry-cli
authless_home=${test_path}/authless-home
assert_rejected_with 'sentry-cli is not installed' /usr/bin/env \
  CONFIGURATION=Release \
  ACTION=install \
  DWARF_DSYM_FOLDER_PATH=/tmp \
  SENTRY_AUTH_TOKEN=present \
  PATH="$test_path" \
  "$dsyms_upload"
assert_succeeds_with 'warning: sentry-cli is not installed' /usr/bin/env \
  CONFIGURATION=Release \
  ACTION=build \
  SKIP_INSTALL=NO \
  PLATFORM_NAME=iphonesimulator \
  DWARF_DSYM_FOLDER_PATH=/tmp \
  SENTRY_AUTH_TOKEN=present \
  PATH="$test_path" \
  "$dsyms_upload"
mkdir -p "$authless_home"
cat > "$fake_sentry_cli" <<'EOF'
#!/bin/zsh
exit 0
EOF
chmod +x "$fake_sentry_cli"
assert_rejected_with 'no Sentry auth token configured' /usr/bin/env \
  CONFIGURATION=Release \
  ACTION=install \
  DWARF_DSYM_FOLDER_PATH=/tmp \
  SENTRY_AUTH_TOKEN= \
  HOME="$authless_home" \
  PATH="$test_path" \
  "$dsyms_upload"

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
