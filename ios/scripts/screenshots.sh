#!/bin/bash
# Captures screenshots of CamSweep from the iOS simulator.
#
#   ios/scripts/screenshots.sh <path/to/CamSweep.app> <output dir> [screen ...]
#
# With no screen names it captures the launch screen as launch.png. Each
# screen name is passed to the app as "-demoScreen <name>" and saved as
# <name>.png.
set -euo pipefail

APP="$1"
OUT="$2"
shift 2
BUNDLE_ID="com.example.camsweep"

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
plain, fallback = "", ""
for runtime in sorted(devices):
    if "iOS" not in runtime:
        continue
    for d in devices[runtime]:
        name = d["name"]
        if not name.startswith("iPhone"):
            continue
        fallback = d["udid"]
        if not any(s in name for s in ("Pro", "Plus", "SE", "Air")) and not name.endswith("e"):
            plain = d["udid"]
print(plain or fallback)
')
if [ -z "$UDID" ]; then
  echo "No iPhone simulator available" >&2
  exit 1
fi
echo "Simulator: $(xcrun simctl list devices available | grep "$UDID" | sed 's/^ *//')"

xcrun simctl bootstatus "$UDID" -b
xcrun simctl ui "$UDID" appearance dark
xcrun simctl status_bar "$UDID" override --time "9:41" \
  --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 \
  --batteryState charged --batteryLevel 100
xcrun simctl install "$UDID" "$APP"

mkdir -p "$OUT"
capture() {
  local name="$1"
  shift
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID" "$@" >/dev/null
  sleep 6
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png"
}

if [ "$#" -eq 0 ]; then
  capture launch
else
  for screen in "$@"; do
    capture "$screen" -demoScreen "$screen"
  done
fi

xcrun simctl shutdown "$UDID"
ls -la "$OUT"
