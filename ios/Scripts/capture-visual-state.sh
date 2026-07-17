#!/bin/zsh

set -euo pipefail

if (( $# != 2 )); then
  print -u2 "Usage: $0 <approved-state-id> <output.png>"
  exit 64
fi

state_id=$1
output_path=$2

if [[ $state_id == *[^A-Za-z0-9-]* ]]; then
  print -u2 "State IDs may contain only letters, numbers, and hyphens."
  exit 64
fi

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
manifest_path=$repository_root/ios/DesignContracts/Resolved/V1PlusRunRev/resolved/snaplist-visual-regression-manifest.json
approved_json=$(/usr/bin/plutil -extract approved json -o - $manifest_path)

if ! grep -Fq "\"$state_id\"" <<< $approved_json; then
  print -u2 "$state_id is not approved by the resolved visual manifest."
  exit 65
fi

snaplist_developer_dir=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
simulator_name=${SNAPLIST_SIMULATOR_NAME:-iPhone 17 Pro}
derived_data=${SNAPLIST_IOS_FIDELITY_DERIVED_DATA:-${TMPDIR:-/tmp}/snaplist-ios-fidelity-derived-data}
export DEVELOPER_DIR=$snaplist_developer_dir

device_line=$(xcrun simctl list devices available | grep -F -m1 "$simulator_name (")
simulator_udid=$(print -r -- $device_line | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')

if [[ -z $simulator_udid || $simulator_udid == $device_line ]]; then
  print -u2 "Could not resolve an available $simulator_name simulator."
  exit 69
fi

status_bar_overridden=0
function clear_status_bar_override {
  if (( status_bar_overridden == 1 )); then
    xcrun simctl status_bar $simulator_udid clear >/dev/null 2>&1 || true
  fi
}
trap clear_status_bar_override EXIT

cd $repository_root

xcrun simctl boot $simulator_udid >/dev/null 2>&1 || true
xcrun simctl bootstatus $simulator_udid -b
xcrun simctl status_bar $simulator_udid override \
  --time 9:41 \
  --dataNetwork wifi \
  --wifiMode active \
  --wifiBars 3 \
  --batteryState charged \
  --batteryLevel 100
status_bar_overridden=1

xcodebuild \
  -project ios/SnapList.xcodeproj \
  -scheme SnapList \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -derivedDataPath $derived_data \
  build

app_path=$derived_data/Build/Products/Debug-iphonesimulator/SnapList.app
xcrun simctl install $simulator_udid $app_path
xcrun simctl terminate $simulator_udid dev.snaplist.ios >/dev/null 2>&1 || true
xcrun simctl launch $simulator_udid dev.snaplist.ios \
  "--visual-state=$state_id" \
  --zero-network-fixtures \
  --reduced-motion >/dev/null

sleep 1
mkdir -p ${output_path:h}
xcrun simctl io $simulator_udid screenshot $output_path
xcrun simctl status_bar $simulator_udid clear
status_bar_overridden=0
print -r -- "Captured $state_id to $output_path"
