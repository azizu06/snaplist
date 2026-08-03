#!/bin/zsh

set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h:h}
asset_catalog=${repository_root}/ios/SnapList/Resources/Assets.xcassets
app_icon_set=${asset_catalog}/AppIcon.appiconset
contents_file=${app_icon_set}/Contents.json
icon_file=${app_icon_set}/AppIcon-1024.png
project_file=${repository_root}/ios/SnapList.xcodeproj/project.pbxproj

[[ -f $contents_file ]] || {
  print -u2 -r -- "AppIcon asset catalog contents are missing."
  exit 1
}

ruby -rjson -e '
  contents = JSON.parse(File.read(ARGV.fetch(0)))
  expected_images = [{
    "filename" => "AppIcon-1024.png",
    "idiom" => "universal",
    "platform" => "ios",
    "size" => "1024x1024"
  }]
  abort "AppIcon must declare exactly one universal iOS 1024 slot" unless
    contents.fetch("images") == expected_images
  abort "AppIcon contents metadata changed" unless
    contents.fetch("info") == { "author" => "xcode", "version" => 1 }
' "$contents_file"

[[ -f $icon_file ]] || {
  print -u2 -r -- "AppIcon 1024 PNG is missing."
  exit 1
}

pixel_width=$(/usr/bin/sips -g pixelWidth "$icon_file" | awk '/pixelWidth/{print $2}')
pixel_height=$(/usr/bin/sips -g pixelHeight "$icon_file" | awk '/pixelHeight/{print $2}')
color_space=$(/usr/bin/sips -g space "$icon_file" | awk '/space/{print $2}')
has_alpha=$(/usr/bin/sips -g hasAlpha "$icon_file" | awk '/hasAlpha/{print $2}')

[[ $pixel_width == 1024 && $pixel_height == 1024 ]] || {
  print -u2 -r -- "AppIcon must be 1024 by 1024 pixels."
  exit 1
}

[[ $color_space == RGB ]] || {
  print -u2 -r -- "AppIcon must use RGB color space."
  exit 1
}

[[ $has_alpha == no ]] || {
  print -u2 -r -- "AppIcon must not carry an alpha channel."
  exit 1
}

app_icon_setting_count=$(grep -Fc 'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;' "$project_file")
[[ $app_icon_setting_count == 2 ]] || {
  print -u2 -r -- "App target Debug and Release settings must name AppIcon."
  exit 1
}

print -r -- "PASS AppIcon catalog: one 1024 RGB PNG without alpha"
