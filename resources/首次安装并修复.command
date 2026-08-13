#!/bin/zsh
# AI新媒体工作台内部开发者版安装器：无需 Apple 证书，首次在目标 Mac 本地完成临时签名。
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_APP="$SCRIPT_DIR/AI新媒体工作台.app"
TARGET_APP="/Applications/AI新媒体工作台.app"
BACKUP_APP="/Applications/AI新媒体工作台.app.previous"
CURRENT_USER="$(/usr/bin/id -un)"

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "未找到安装包中的 AI新媒体工作台.app。请直接从已挂载的 DMG 中运行本脚本。"
  read -r '?按回车键退出…'
  exit 1
fi
echo "将安装 AI新媒体工作台到“应用程序”文件夹。"
echo "系统会要求输入本机管理员密码；密码只由 macOS 自身处理，不会被本软件读取。"

sudo -v
sudo /bin/rm -rf "$BACKUP_APP"
if [[ -d "$TARGET_APP" ]]; then
  sudo /bin/mv "$TARGET_APP" "$BACKUP_APP"
fi

if ! sudo /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"; then
  echo "复制失败，正在恢复原应用。"
  if [[ -d "$BACKUP_APP" ]]; then
    sudo /bin/mv "$BACKUP_APP" "$TARGET_APP"
  fi
  read -r '?按回车键退出…'
  exit 1
fi

# 清除下载隔离标记，并在当前电脑上生成可验证的临时签名。
sudo /usr/bin/xattr -cr "$TARGET_APP"
sudo /usr/bin/codesign --force --deep --sign - "$TARGET_APP"
sudo /usr/sbin/chown -R "$CURRENT_USER":staff "$TARGET_APP"
sudo /bin/rm -rf "$BACKUP_APP"

if /usr/bin/codesign --verify --deep --strict "$TARGET_APP"; then
  echo "安装完成，正在打开 AI新媒体工作台。"
  /usr/bin/open "$TARGET_APP"
else
  echo "安装后的签名校验失败，请联系软件维护人员。"
  read -r '?按回车键退出…'
  exit 1
fi
