#!/usr/bin/env bash
set -euo pipefail

# 将「首次安装必看说明.txt」无损注入已生成的 macOS DMG，并保持 .VolumeIcon.icns 与美观窗口布局。
# 用法: scripts/inject-dmg-readme.sh <dmg_path> [readme_path]

DMG_PATH="${1:?请提供目标 .dmg 文件路径}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
README_PATH="${2:-$SCRIPT_DIR/../src-tauri/resources/首次安装必看说明.txt}"

if [ ! -f "$DMG_PATH" ]; then
  echo "ERROR: DMG not found: $DMG_PATH" >&2
  exit 1
fi
if [ ! -f "$README_PATH" ]; then
  echo "ERROR: Readme not found: $README_PATH" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/newmedia-dmg-repack.XXXXXX")"
RW_DMG="$WORK_DIR/temp-rw.dmg"
OUT_DMG="$WORK_DIR/out.dmg"
DEV_NAME=""
MNT_DIR=""

cleanup() {
  if [ -n "$MNT_DIR" ] && mount | grep -qF "$MNT_DIR"; then
    hdiutil detach "$MNT_DIR" -force >/dev/null 2>&1 || true
  elif [ -n "$DEV_NAME" ]; then
    hdiutil detach "$DEV_NAME" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# 转为可读写镜像并扩充空间，确保写入说明文件与 .DS_Store 不爆盘
hdiutil convert "$DMG_PATH" -format UDRW -o "$RW_DMG" >/dev/null
hdiutil resize -size 60m "$RW_DMG" >/dev/null || true

ATTACH_OUT="$(hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen)"
DEV_NAME="$(echo "$ATTACH_OUT" | awk '/^\/dev\//{print $1; exit}')"
MNT_DIR="$(echo "$ATTACH_OUT" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"

if [ -z "$MNT_DIR" ] || [ ! -d "$MNT_DIR" ]; then
  echo "ERROR: Failed to mount RW DMG: $ATTACH_OUT" >&2
  exit 1
fi

cp "$README_PATH" "$MNT_DIR/首次安装必看说明.txt"
chmod 644 "$MNT_DIR/首次安装必看说明.txt"
ICON_SRC="$SCRIPT_DIR/../src-tauri/icons/icon.icns"
if [ -f "$ICON_SRC" ] && [ ! -f "$MNT_DIR/.VolumeIcon.icns" ]; then
  cp "$ICON_SRC" "$MNT_DIR/.VolumeIcon.icns"
  chmod 644 "$MNT_DIR/.VolumeIcon.icns"
  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a C "$MNT_DIR" >/dev/null 2>&1 || true
  fi
fi
VOL_NAME="$(basename "$MNT_DIR")"

# 使用 Finder AppleScript 排版三图标三角形布局（左 App / 右 Applications / 中下 首次安装必看说明.txt）
osascript >/dev/null 2>&1 <<EOF || true
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {260, 180, 860, 560}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    try
      set position of item "AI新媒体工作台.app" of container window to {165, 130}
    end try
    try
      set position of item "Applications" of container window to {435, 130}
    end try
    try
      set position of item "首次安装必看说明.txt" of container window to {300, 275}
    end try
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF

sync
sleep 1
hdiutil detach "$DEV_NAME" -quiet || hdiutil detach "$MNT_DIR" -force -quiet
DEV_NAME=""
MNT_DIR=""

# 转回高压缩只读 UDZO 镜像覆盖原 DMG
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUT_DMG" >/dev/null
mv -f "$OUT_DMG" "$DMG_PATH"
echo "✓ 已将「首次安装必看说明.txt」注入 DMG: $DMG_PATH"
