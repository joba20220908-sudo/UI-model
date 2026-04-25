#!/usr/bin/env bash
# MindDeck 一键启动：同时起静态服务（8000）+ OCR 定位服务（8788）
#
# 用法:
#   bash scripts/start.sh
#
# 自动从 ~/.claude/settings.json 读取 ANTHROPIC_AUTH_TOKEN 作为智谱 key。
# 退出时自动清理两个服务进程。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

STATIC_PORT="${STATIC_PORT:-8000}"
OCR_PORT="${OCR_PORT:-8788}"

# 端口冲突检查
for port in "$STATIC_PORT" "$OCR_PORT"; do
  if lsof -ti ":$port" >/dev/null 2>&1; then
    echo "❌ 端口 $port 被占用，先释放它再启动："
    echo "    lsof -ti :$port | xargs kill -9"
    exit 1
  fi
done

# 智谱 key（语义匹配 LLM 用），可从环境变量覆盖
if [ -z "${ZHIPU_API_KEY:-}" ] && [ -f "$HOME/.claude/settings.json" ]; then
  ZHIPU_API_KEY="$(python3 -c "
import json, sys
try:
  d = json.load(open('$HOME/.claude/settings.json'))
  print(d.get('env', {}).get('ANTHROPIC_AUTH_TOKEN', ''))
except: pass
" 2>/dev/null || true)"
  export ZHIPU_API_KEY
fi
[ -n "${ZHIPU_API_KEY:-}" ] && echo "✓ 已从 ~/.claude/settings.json 加载智谱 key" \
                            || echo "⚠️  无智谱 key，LLM 语义补漏将跳过（仅字符串匹配）"

# 清理函数：脚本退出时杀掉两个服务
PIDS=()
cleanup() {
  echo ""
  echo "停止服务..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "✓ 已清理"
}
trap cleanup EXIT INT TERM

# 1. OCR 服务（后台）
echo "启动 OCR 服务 → http://localhost:$OCR_PORT"
python3 -u "$ROOT_DIR/scripts/ocr-locate-server.py" "$OCR_PORT" &
PIDS+=($!)
sleep 1.5

# 2. 静态服务（前台，Ctrl+C 退出整个脚本）
echo "启动静态服务 → http://localhost:$STATIC_PORT"
echo ""
echo "📌 浏览器打开（任选其一）："
echo "   http://localhost:$STATIC_PORT/index.html"
echo "   http://localhost:$STATIC_PORT/Projects/hnw-licai/Prototype.html"
echo ""
echo "Ctrl+C 退出（自动清理两个服务）"
echo ""

python3 -m http.server "$STATIC_PORT"
