#!/bin/zsh

set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)
ios_directory=$(dirname -- "$script_directory")
entitlements_file=$ios_directory/SnapList/SnapList.entitlements
info_plist_file=$ios_directory/SnapList/Info.plist

/usr/bin/plutil -convert json -o - "$entitlements_file" |
  ruby -rjson -e '
    domains = JSON.parse(STDIN.read).fetch("com.apple.developer.associated-domains")
    expected = [
      "webcredentials:snaplist.dev",
      "webcredentials:$(SNAPLIST_CLERK_FRONTEND_DOMAIN)",
    ]
    abort "associated domains must preserve only approved webcredentials" unless domains == expected
  '

url_scheme=$(
  /usr/bin/plutil \
    -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 \
    raw \
    "$info_plist_file"
)
[[ $url_scheme == "snaplist" ]]

printf '%s\n' "PASS deep-link entitlement and custom-scheme contract"
