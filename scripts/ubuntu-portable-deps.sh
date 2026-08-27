#!/usr/bin/env bash
# Ubuntu packages for the portable USB app.
#   ./scripts/ubuntu-portable-deps.sh          # runtime (open the USB app)
#   ./scripts/ubuntu-portable-deps.sh build    # also install compile toolchain libs
set -euo pipefail

MODE="${1:-runtime}"

RUNTIME_PKGS=(
  libwebkit2gtk-4.1-0
  libgtk-3-0
  libayatana-appindicator3-1
  librsvg2-2
)

BUILD_PKGS=(
  build-essential
  curl
  wget
  file
  libssl-dev
  libgtk-3-dev
  libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libxdo-dev
  pkg-config
  python3-pip
  python3-venv
)

echo "Installing Ubuntu $MODE packages for Yaskawa Job Editor..."
sudo apt-get update
sudo apt-get install -y "${RUNTIME_PKGS[@]}"

if [[ "$MODE" == "build" ]]; then
  sudo apt-get install -y "${BUILD_PKGS[@]}"
  echo
  echo "Also needed on PATH (install once if missing):"
  echo "  Node 24+   https://nodejs.org"
  echo "  Rust       curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "  pip install pyinstaller numpy scipy"
fi

echo "Done."
