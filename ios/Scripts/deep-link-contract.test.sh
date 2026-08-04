#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
entitlements_file=${script_directory:h}/SnapList/SnapList.entitlements
info_plist_file=${script_directory:h}/SnapList/Info.plist

/usr/bin/plutil -convert json -o - "$entitlements_file" |
  ruby -rjson -e '
    domains = JSON.parse(STDIN.read).fetch("com.apple.developer.associated-domains")
    expected = [
      "webcredentials:snaplist.dev",
      "webcredentials:witty-walrus-27.clerk.accounts.dev",
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

print -r -- "PASS deep-link entitlement and custom-scheme contract"
