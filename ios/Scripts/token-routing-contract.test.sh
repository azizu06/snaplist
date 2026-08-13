#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
ios_directory=${script_directory:h}
design_system_directory=${ios_directory}/SnapList/DesignSystem
tokens_file=${design_system_directory}/SnapListTokens.swift

[[ -f $tokens_file ]] || {
  print -u2 -r -- "SnapListTokens.swift is missing."
  exit 1
}

violations_file=$(mktemp)
trap 'rm -f "$violations_file"' EXIT

# Every color in the iOS app must resolve through SnapListColorToken so a
# later dark palette can reach the whole app instead of leaving it half
# dark and half light. Color.white, the SwiftUI implicit-member shorthand
# `.white`, and inline Color(hex:) are all bypasses of that chokepoint.
# SnapListTokens.swift is the one file allowed to spell out raw hex values,
# since it is the chokepoint itself.
while IFS= read -r -d '' file; do
  [[ $file == "$tokens_file" ]] && continue

  grep -n -E 'Color\.white|(^|[^A-Za-z0-9_])\.white\b|Color\(hex:' "$file" |
    sed "s#^#${file}:#" >> "$violations_file" || true
done < <(find "$ios_directory/SnapList" -name '*.swift' -print0)

if [[ -s $violations_file ]]; then
  print -u2 -r -- "Color bypasses found outside SnapListTokens.swift:"
  cat -- "$violations_file" >&2
  exit 1
fi

# The token layer stays light-only until a separate, owner-approved issue
# introduces dark values on purpose. A premature appearance switch here
# would silently change every screen this issue proved renders unchanged.
if grep -q -E \
  'colorScheme|UITraitCollection|UIUserInterfaceStyle|prefersColorScheme|ColorScheme' \
  "$tokens_file"
then
  print -u2 -r -- "SnapListTokens.swift must not become appearance-aware yet."
  exit 1
fi

printf '%s\n' "PASS every color routes through SnapListColorToken, and the token layer stays appearance-neutral"
