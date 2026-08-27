#!/usr/bin/env bash
# Copy the portable package onto a USB mount (Ubuntu).
# Usage:
#   ./scripts/install-portable-to-drive.sh /media/$USER/YOUR_USB
#   ./scripts/install-portable-to-drive.sh            # lists likely USB mounts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/portable/YaskawaJobEditor"
FOLDER_NAME="${FOLDER_NAME:-YaskawaJobEditor}"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: Portable package not found:"
  echo "  $SRC"
  echo "Build first:"
  echo "  ./scripts/build-portable.sh"
  exit 1
fi

list_usb_mounts() {
  local user="${USER:-$(id -un)}"
  local root
  for root in "/media/$user" "/run/media/$user" /media /run/media /mnt; do
    [[ -d "$root" ]] || continue
    find "$root" -mindepth 1 -maxdepth 2 -type d -print 2>/dev/null || true
  done
}

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "USB mount not specified. Likely removable mounts:"
  list_usb_mounts | sed 's/^/  /'
  echo
  echo "Usage:"
  echo "  $0 /media/\$USER/YOUR_USB"
  exit 1
fi

if [[ ! -d "$TARGET" ]]; then
  echo "ERROR: Mount is not available: $TARGET"
  echo "Plug in the USB, then pass its mount path."
  exit 1
fi

DEST="$TARGET/$FOLDER_NAME"
echo "Copying portable app..."
echo "  From: $SRC"
echo "  To:   $DEST"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
chmod +x "$DEST/Yaskawa Job Editor.sh" 2>/dev/null || true
chmod +x "$DEST/yaskawa-job-editor" 2>/dev/null || true
chmod +x "$DEST/yaskawa-kin" 2>/dev/null || true
chmod +x "$DEST/Yaskawa Job Editor.AppImage" 2>/dev/null || true

echo
echo "Installed portable app to:"
echo "  $DEST"
echo "Ubuntu:  bash \"$DEST/Yaskawa Job Editor.sh\""
if [[ -f "$DEST/Run.bat" ]]; then
  echo "Windows: $DEST/Run.bat"
fi
