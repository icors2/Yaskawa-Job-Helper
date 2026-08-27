#!/usr/bin/env bash
# Build Linux files into the shared portable USB folder (no installer).
# Output: portable/YaskawaJobEditor/
# Windows .exe / Run.bat already in that folder are left in place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_FRONTEND=0
SKIP_KIN=0
SKIP_TAURI=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-kin) SKIP_KIN=1 ;;
    --skip-tauri) SKIP_TAURI=1 ;;
    --clean) CLEAN=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

OUT_DIR="$ROOT/portable/YaskawaJobEditor"
RELEASE_DIR="$ROOT/src-tauri/target/release"
KIN_DIST="$ROOT/dist-kin"
KIN_DIR="$ROOT/kinematics"
PORTABLE_SRC="$ROOT/scripts/portable"

echo "=== Yaskawa Job Editor - portable Linux build ==="
echo "App root: $ROOT"
echo "Output:   $OUT_DIR"
echo

if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  echo "[1/4] Frontend (vite build)..."
  npm run build:web
else
  echo "[1/4] Skipping frontend"
fi

if [[ "$SKIP_KIN" -eq 0 ]]; then
  echo "[2/4] Kinematics sidecar (PyInstaller)..."
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 not found - required to bundle yaskawa-kin" >&2
    exit 1
  fi
  mkdir -p "$KIN_DIST"
  HIDDEN=(
    ar2010
    calibrate
    cnd
    robot_model
    robot_profile
    frame_flip
    transform
    numpy
    scipy
    scipy.optimize
  )
  PY_ARGS=(
    -m PyInstaller
    --noconfirm
    --onefile
    --name yaskawa-kin
    --paths "$KIN_DIR"
    --distpath "$KIN_DIST"
    --workpath "$KIN_DIST/work"
    --specpath "$KIN_DIST/spec"
    --collect-submodules numpy
    --collect-submodules scipy
  )
  for mod in "${HIDDEN[@]}"; do
    PY_ARGS+=(--hidden-import "$mod")
  done
  python3 "${PY_ARGS[@]}" "$KIN_DIR/server.py"

  KIN_BIN=""
  for cand in "$KIN_DIST/yaskawa-kin" "$KIN_DIST/yaskawa-kin.bin"; do
    if [[ -f "$cand" ]]; then
      KIN_BIN="$cand"
      break
    fi
  done
  if [[ -z "$KIN_BIN" ]]; then
    echo "PyInstaller did not produce yaskawa-kin - pip install pyinstaller numpy scipy" >&2
    exit 1
  fi
  chmod +x "$KIN_BIN"
  echo "    Smoke-testing yaskawa-kin..."
  python3 "$PORTABLE_SRC/smoke_kin.py" "$KIN_BIN"
else
  echo "[2/4] Skipping PyInstaller"
fi

if [[ "$SKIP_TAURI" -eq 0 ]]; then
  echo "[3/4] Tauri release binary (no installer bundle)..."
  if ! npx tauri build --no-bundle; then
    echo "tauri build --no-bundle failed; trying full tauri build..."
    npm run build
  fi
else
  echo "[3/4] Skipping Tauri build"
fi

echo "[4/4] Assembling portable folder (Linux files only)..."

APP_BIN=""
for cand in \
  "$RELEASE_DIR/yaskawa-job-editor" \
  "$RELEASE_DIR/Yaskawa Job Editor"
do
  if [[ -f "$cand" ]]; then
    APP_BIN="$cand"
    break
  fi
done
if [[ -z "$APP_BIN" ]]; then
  echo "Release binary not found under $RELEASE_DIR. Build Tauri first." >&2
  echo "On Ubuntu, install build libs: ./scripts/ubuntu-portable-deps.sh build" >&2
  exit 1
fi

KIN_BIN=""
for cand in "$KIN_DIST/yaskawa-kin" "$KIN_DIST/yaskawa-kin.bin"; do
  if [[ -f "$cand" ]]; then
    KIN_BIN="$cand"
    break
  fi
done
if [[ -z "$KIN_BIN" ]]; then
  echo "Missing $KIN_DIST/yaskawa-kin - run without --skip-kin" >&2
  exit 1
fi

if [[ "$CLEAN" -eq 1 && -d "$OUT_DIR" ]]; then
  echo "    --clean: removing $OUT_DIR"
  rm -rf "$OUT_DIR"
fi
mkdir -p "$OUT_DIR/kinematics"

cp -f "$APP_BIN" "$OUT_DIR/yaskawa-job-editor"
chmod +x "$OUT_DIR/yaskawa-job-editor"
cp -f "$KIN_BIN" "$OUT_DIR/yaskawa-kin"
chmod +x "$OUT_DIR/yaskawa-kin"
cp -f "$KIN_DIR/"*.py "$OUT_DIR/kinematics/" 2>/dev/null || true
cp -f "$KIN_DIR/requirements.txt" "$OUT_DIR/kinematics/" 2>/dev/null || true
cp -f "$PORTABLE_SRC/Yaskawa Job Editor.sh" "$OUT_DIR/Yaskawa Job Editor.sh"
chmod +x "$OUT_DIR/Yaskawa Job Editor.sh"
cp -f "$PORTABLE_SRC/README-PORTABLE.txt" "$OUT_DIR/README-PORTABLE.txt"

APPIMAGE=""
shopt -s nullglob
for img in "$ROOT/src-tauri/target/release/bundle/appimage/"*.AppImage; do
  APPIMAGE="$img"
done
shopt -u nullglob
if [[ -n "$APPIMAGE" ]]; then
  cp -f "$APPIMAGE" "$OUT_DIR/Yaskawa Job Editor.AppImage"
  chmod +x "$OUT_DIR/Yaskawa Job Editor.AppImage"
fi

echo
echo "Portable package ready:"
echo "  $OUT_DIR"
ls -lh "$OUT_DIR"
echo
if [[ -f "$OUT_DIR/Yaskawa Job Editor.exe" ]]; then
  echo "Windows files are still present (left untouched)."
fi
echo "Ubuntu: open  $OUT_DIR/Yaskawa Job Editor.sh"
echo "Next: ./scripts/install-portable-to-drive.sh /media/\$USER/YOUR_USB"
