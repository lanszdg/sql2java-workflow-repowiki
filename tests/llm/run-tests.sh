#!/usr/bin/env bash
#
# run-tests.sh — L2 执行点测试套件入口（case 粒度）
#
# 用法:
#   bash tests/llm/run-tests.sh                  # 运行全部用例（真实 agent，慢）
#   bash tests/llm/run-tests.sh <case>...        # 运行指定用例
#   ENABLE_JUDGE=1 bash tests/llm/run-tests.sh   # 启用 LLM-as-Judge
#   bash tests/llm/list-cases.sh                 # 仅列出可用用例（见下方）
#
# 环境变量:
#   ENABLE_JUDGE  — 设为 1 启用 LLM-as-Judge（仅对配置了 judge 的 case 生效）
#
# 说明：L2 用例会真实调用 opencode（走 .opencode agent），耗时数分钟、消耗 token、非确定。
# 廉价验证（harness/断言逻辑/§5 地基）用 vitest：`npx vitest run tests/ts`。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# 优先用 bun（.opencode 同源运行时，原生支持 TS + zod v4）
if command -v bun >/dev/null 2>&1; then
  RUNNER="bun"
else
  RUNNER="npx tsx"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  sql2java-workflow L2 执行点测试"
echo "  runner: $RUNNER   judge: ${ENABLE_JUDGE:-disabled}"
echo "════════════════════════════════════════════════════════════"

# 列出可用用例
echo "可用用例（tests/llm/cases/）："
if [ -d "$SCRIPT_DIR/cases" ]; then
  for d in "$SCRIPT_DIR/cases"/*/; do
    [ -f "${d}case.config.ts" ] && echo "  - $(basename "$d")"
  done
fi
echo ""

$RUNNER "$SCRIPT_DIR/run.ts" "$@"
