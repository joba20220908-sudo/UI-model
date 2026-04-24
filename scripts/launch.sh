#!/usr/bin/env bash
# launch.sh — 一键启动 MindDeck
# 用法: bash scripts/launch.sh <file.xmind> [port]
#
# 自动完成：解析 XMind → 建项目目录 → 复制模板 → 启动服务器 → 打开浏览器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/template"
PROJECTS_DIR="$ROOT_DIR/Projects"

XMIND_FILE="${1:-}"
PORT="${2:-8080}"

# ── 参数检查 ──────────────────────────────────────────────────────────────────
if [[ -z "$XMIND_FILE" ]]; then
  echo "用法: bash scripts/launch.sh <file.xmind> [port]"
  exit 1
fi
if [[ ! -f "$XMIND_FILE" ]]; then
  echo "文件不存在: $XMIND_FILE"
  exit 1
fi

# ── 找 node / python3 ─────────────────────────────────────────────────────────
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  # macOS Homebrew 常见路径
  for p in /usr/local/bin/node /opt/homebrew/bin/node; do
    [[ -x "$p" ]] && NODE_BIN="$p" && break
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node，请先安装 Node.js: https://nodejs.org"
  exit 1
fi

PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "未找到 python3，请先安装 Python 3"
  exit 1
fi

# ── 解析 XMind，生成项目目录 ──────────────────────────────────────────────────
BASE_NAME="$(basename "$XMIND_FILE" .xmind)"
PROJECT_DIR="$PROJECTS_DIR/$BASE_NAME"

echo "▶ 解析 $BASE_NAME.xmind ..."
"$NODE_BIN" "$SCRIPT_DIR/parse-xmind.js" "$XMIND_FILE" "$PROJECT_DIR"

# ── 复制模板文件（HTML + JS 模块）────────────────────────────────────────────
echo "▶ 复制模板文件 ..."
JS_MODULES=(storage.js tree.js hotspots.js comments-ui.js screen.js export-ui.js ai.js app.js)

# 优先从 template/ 目录读，回退到第一个已有项目
if [[ -d "$TEMPLATE_DIR" ]]; then
  SRC_DIR="$TEMPLATE_DIR"
else
  # 找第一个已有的项目目录作为模板源
  SRC_DIR=""
  for d in "$PROJECTS_DIR"/*/; do
    if [[ -f "$d/Prototype.html" && "$d" != "$PROJECT_DIR/" ]]; then
      SRC_DIR="$d"
      break
    fi
  done
fi

if [[ -z "$SRC_DIR" ]]; then
  echo "未找到模板文件，请先确保 Projects/ 下有至少一个完整项目"
  exit 1
fi

cp "$SRC_DIR/Prototype.html" "$PROJECT_DIR/Prototype.html"
for f in "${JS_MODULES[@]}"; do
  [[ -f "$SRC_DIR/$f" ]] && cp "$SRC_DIR/$f" "$PROJECT_DIR/$f"
done

# ── 检查端口是否被占用，自动换端口 ───────────────────────────────────────────
while lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; do
  echo "端口 $PORT 已被占用，尝试 $((PORT+1)) ..."
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT/Prototype.html"

# ── 启动 HTTP 服务器（后台）──────────────────────────────────────────────────
echo "▶ 启动服务器 → $URL"
cd "$PROJECT_DIR"
"$PYTHON_BIN" -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!

# 等待服务器就绪
for i in $(seq 1 10); do
  curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break
  sleep 0.3
done

# ── 打开浏览器 ───────────────────────────────────────────────────────────────
if command -v open >/dev/null 2>&1; then       # macOS
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then # Linux
  xdg-open "$URL"
fi

echo ""
echo "✓ MindDeck 已启动: $URL"
echo "  按 Ctrl+C 停止服务器"
echo ""

# ── 等待 Ctrl+C，清理 ────────────────────────────────────────────────────────
trap "echo ''; echo '停止服务器...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
