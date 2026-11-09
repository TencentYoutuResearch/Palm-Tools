#!/bin/sh
# Prepare a sealed development Electron bundle without changing a running runtime.
# Usage: prepare-desktop-notifications.sh /path/to/Electron.app /path/to/cache
set -eu
if [ "$(uname -s)" != Darwin ] || [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage on macOS: prepare-desktop-notifications.sh Electron.app cache-directory' >&2
  exit 1
fi
SOURCE=$(CDPATH= cd -- "$1" && pwd -P)
mkdir -p "$2"
CACHE=$(CDPATH= cd -- "$2" && pwd -P)
IDENTIFIER=$(/usr/bin/plutil -extract CFBundleIdentifier raw "$SOURCE/Contents/Info.plist")
if [ "$IDENTIFIER" != com.github.Electron ]; then
  printf '%s\n' 'Expected the development Electron.app bundle. Packaged Desktop signatures must be preserved.' >&2
  exit 1
fi
# The framework contains Electron's notification implementation. Refresh the copy
# whenever npm replaces the runtime, even when its outer launcher stays identical.
FINGERPRINT=$(/usr/bin/shasum -a 256 "$SOURCE/Contents/Info.plist" "$SOURCE/Contents/MacOS/Electron" "$SOURCE/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
TARGET="$CACHE/$FINGERPRINT/Electron.app"
if ! /usr/bin/codesign --verify --deep --strict "$TARGET" 2>/dev/null; then
  # Each attempt uses its own directory, so interrupted or concurrent preparation
  # cannot launch a partly copied bundle. Only the verified path reaches stdout.
  STAGING=$(/usr/bin/mktemp -d "$CACHE/preparing.XXXXXX")
  /usr/bin/ditto "$SOURCE" "$STAGING/Electron.app"
  /usr/bin/codesign --force --deep --sign - "$STAGING/Electron.app" >&2
  /usr/bin/codesign --verify --deep --strict "$STAGING/Electron.app" >&2
  /bin/ln -s -h "$STAGING" "$CACHE/$FINGERPRINT" 2>/dev/null || true
  /usr/bin/codesign --verify --deep --strict "$TARGET" >&2
fi
printf '%s\n' "$TARGET"
