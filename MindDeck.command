#!/usr/bin/env bash
# MindDeck.command — macOS 双击启动器
# 双击此文件，弹出文件选择框，选择 .xmind 文件后自动启动 MindDeck

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# macOS 文件选择对话框
XMIND_FILE="$(osascript -e '
  set f to choose file with prompt "选择 XMind 文件：" of type {"xmind", "public.data"}
  return POSIX path of f
' 2>/dev/null || true)"

if [[ -z "$XMIND_FILE" ]]; then
  echo "未选择文件，已取消。"
  exit 0
fi

exec bash "$SCRIPT_DIR/scripts/launch.sh" "$XMIND_FILE"
