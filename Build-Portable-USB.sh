#!/usr/bin/env bash
# Build Linux files into the shared portable USB folder.
set -euo pipefail
cd "$(dirname "$0")"

echo "Building portable Yaskawa Job Editor package (Linux files)..."
echo "This needs Node, Rust, and Python ON THIS BUILD PC only."
echo "Windows .exe / Run.bat already in portable/YaskawaJobEditor/ are kept."
echo

if ! command -v node >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "Missing build tools. On Ubuntu you can install system libs with:"
  echo "  ./scripts/ubuntu-portable-deps.sh build"
  echo "Then install Node 24+, Rust (rustup), and: pip install pyinstaller numpy scipy"
  echo
fi

./scripts/build-portable.sh "$@"

echo
echo "Package is in: portable/YaskawaJobEditor/"
echo "Ubuntu single file: portable/YaskawaJobEditor/Yaskawa Job Editor.sh"
echo "Next: ./scripts/install-portable-to-drive.sh /media/\$USER/YOUR_USB"
