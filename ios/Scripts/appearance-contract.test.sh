#!/bin/zsh

# SnapList ships a light-only palette. SnapListColorToken resolves every colour
# to a fixed sRGB value with no dark variant, so the canvas token stays #FFFFFF
# whatever the device appearance is, while the app's semantic .primary and
# .secondary text inverts to white in Dark Mode. That combination rendered white
# labels on white cards and made Settings unreadable (#829).
#
# UIUserInterfaceStyle is what stops the system doing that. This contract fails
# if the key is removed or weakened before the palette can actually follow the
# system appearance, which is #832.

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
info_plist=${repository_root}/ios/SnapList/Info.plist
tokens_file=${repository_root}/ios/SnapList/DesignSystem/SnapListTokens.swift

[[ -f $info_plist ]] || {
  print -u2 -r -- "Info.plist is missing at ${info_plist}."
  exit 1
}

# The palette check below greps this file, and grep on a missing path only warns
# on stderr and returns non-zero, which reads as "no match found" and passes the
# contract. Splitting the palette into a new file is a plausible way to write
# #832, so without this guard the lock would silently stop being enforced by the
# very change it exists to catch.
[[ -f $tokens_file ]] || {
  print -u2 -r -- "SnapListTokens.swift is missing at ${tokens_file}. If the palette
moved, point this contract at its new home or delete the contract as part of #832."
  exit 1
}

declared_style=$(plutil -extract UIUserInterfaceStyle raw "$info_plist" 2>/dev/null) || {
  print -u2 -r -- "Info.plist declares no UIUserInterfaceStyle. SnapList's palette is
light-only, so without this key Dark Mode renders white text on white cards. Add
the key back, or land the adaptive palette in #832 and delete this contract."
  exit 1
}

[[ $declared_style == "Light" ]] || {
  print -u2 -r -- "UIUserInterfaceStyle is '${declared_style}', expected 'Light'."
  exit 1
}

# The lock exists only because the token layer cannot follow the system
# appearance. If a token ever gains a dark variant, this contract is the thing
# standing in its way, so fail loudly and name the issue rather than letting the
# lock silently outlive its reason.
if grep -q 'UITraitCollection\|userInterfaceStyle\|dynamicProvider' "$tokens_file"; then
  print -u2 -r -- "SnapListTokens.swift looks appearance-aware now. If the palette
resolves light and dark values, remove UIUserInterfaceStyle from Info.plist and
delete this contract as part of #832."
  exit 1
fi

print -r -- "Appearance contract OK: app is declared light-only and the palette is
still fixed-value, so the two agree."
