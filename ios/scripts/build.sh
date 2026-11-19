#!/bin/bash
# Builds CamSweep for the iOS simulator into ios/build. No signing needed.
set -euo pipefail
cd "$(dirname "$0")/.."

xcodebuild -version
xcodebuild \
  -project CamSweep.xcodeproj \
  -target CamSweep \
  -configuration Debug \
  -sdk iphonesimulator \
  ARCHS="$(uname -m)" ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO \
  SYMROOT="$PWD/build" \
  -quiet \
  build
