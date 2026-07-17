#!/bin/zsh

set -euo pipefail

if (( $# != 4 )); then
  print -u2 "Usage: $0 <approved-state-id> <reference.png> <actual.png> <output-directory>"
  exit 64
fi

state_id=$1
reference_path=$2
actual_path=$3
output_directory=$4
script_directory=${0:A:h}
repository_root=${script_directory:h:h}
manifest_path=$repository_root/ios/DesignContracts/Resolved/V1PlusRunRev/resolved/snaplist-visual-regression-manifest.json
approved_json=$(/usr/bin/plutil -extract approved json -o - $manifest_path)

if ! grep -Fq "\"$state_id\"" <<< $approved_json; then
  print -u2 "$state_id is not approved by the resolved visual manifest."
  exit 65
fi

for image_path in $reference_path $actual_path; do
  if [[ ! -f $image_path ]]; then
    print -u2 "Missing image: $image_path"
    exit 66
  fi
done

mkdir -p $output_directory
side_by_side_path=$output_directory/$state_id-side-by-side.png
overlay_path=$output_directory/$state_id-overlay.png

xcrun swift $script_directory/compare-screenshots.swift \
  $reference_path \
  $actual_path \
  $side_by_side_path \
  $overlay_path

print -r -- "Side-by-side: $side_by_side_path"
print -r -- "Overlay: $overlay_path"
