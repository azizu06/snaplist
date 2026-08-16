#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
ios_directory=${script_directory:h}
snaplist_directory=${ios_directory}/SnapList

[[ -d $snaplist_directory ]] || {
  print -u2 -r -- "SnapList app source is missing."
  exit 1
}

# CaptureViews.swift's CameraFixtureSurface, FixtureItemScene and
# CaptureHandoffFixture are private structs that only the visual-state
# fixture route builds. They never render to a seller, so Reduce
# Transparency owes them nothing (#831).
excluded_file=${snaplist_directory}/Features/Capture/CaptureViews.swift

# Every SwiftUI spelling of a translucent system material or fill. A surface
# that backgrounds itself with one of these and never reads
# accessibilityReduceTransparency has nothing to fall back to when a seller
# turns that setting on: the surface just stays translucent regardless.
material_pattern='\.ultraThinMaterial\b|\.thinMaterial\b|\.regularMaterial\b|\.thickMaterial\b|\.ultraThickMaterial\b|\.bar\b'

# accessibilityReduceTransparency is read once per type, usually as a
# stored @Environment property declared near the top of the struct, and
# referenced from deep inside the body wherever the material call actually
# sits; that gap is routinely 40+ lines, so a fixed-line-window proximity
# check produces false positives on real, already-guarded code. A per-file
# scope check is what this repo's other contract scripts already do
# (token-routing-contract.test.sh scans a whole file for a bypass pattern
# with no windowing), and it is precise enough here: this repo has never
# put two unrelated SwiftUI types with two different transparency
# decisions in one file, so "the file declares the environment key
# somewhere" is a reliable proxy for "the material call in this file is
# guarded." The pattern below matches the literal `\.accessibilityReduceTransparency`
# environment-key spelling SwiftUI requires for `@Environment(...)`, not a
# bare mention of the word, so an explanatory comment can say the word
# without being mistaken for a guard.
environment_key_pattern='\\\.accessibilityReduceTransparency'

violations_file=$(mktemp)
trap 'rm -f "$violations_file"' EXIT

while IFS= read -r -d '' file; do
  [[ $file == "$excluded_file" ]] && continue

  if grep -q -E "$material_pattern" "$file" &&
    ! grep -q -E "$environment_key_pattern" "$file"
  then
    grep -n -E "$material_pattern" "$file" |
      sed "s#^#${file}:#" >> "$violations_file"
  fi
done < <(find "$snaplist_directory" -name '*.swift' -print0)

if [[ -s $violations_file ]]; then
  print -u2 -r -- \
    "Material or translucent fill outside the fixture routes with no accessibilityReduceTransparency fallback in the same file:"
  cat -- "$violations_file" >&2
  exit 1
fi

printf '%s\n' \
  "PASS every material or translucent fill outside the fixture routes has an accessibilityReduceTransparency fallback in the same file"
