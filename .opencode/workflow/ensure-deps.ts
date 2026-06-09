/**
 * 依赖自动安装守卫
 *
 * 在插件加载前检测 node_modules 是否完整，缺失则自动安装。
 * 包管理器优先级：npm > bun > 报错。
 *
 * 用法：在需要 npm 包的文件顶部调用 await ensureDeps()
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

// ── 单例状态 ──────────────────────────────────────────────────────────────────

let ensurePromise: Promise<void> | null = null

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 找到 .opencode/ 目录（本文件在 .opencode/workflow/ 下，向上一级） */
export function findOpencodeDir(): string {
  return join(dirname(__filename), "..")
}

/** 读取 package.json 中的 dependencies（不含 optionalDependencies，可选依赖由使用方自行处理） */
function getRequiredDeps(opencodeDir: string): string[] {
  const pkgPath = join(opencodeDir, "package.json")
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    return Object.keys(pkg.dependencies || {})
  } catch {
    return []
  }
}

/**
 * 检查所有依赖是否已安装且完整。
 * 检查 package.json 存在（兼容 ESM-only 包，require.resolve 无法解析此类包）。
 */
function checkAllInstalled(opencodeDir: string, deps: string[]): boolean {
  if (deps.length === 0) return true
  return deps.every(dep => {
    const pkgJsonPath = join(opencodeDir, "node_modules", dep, "package.json")
    return existsSync(pkgJsonPath)
  })
}

/** 检测可用的包管理器 */
function detectPackageManager(): "npm" | "bun" | null {
  try { execSync("npm --version", { stdio: "pipe" }); return "npm" } catch {}
  try { execSync("bun --version", { stdio: "pipe" }); return "bun" } catch {}
  return null
}

/** 执行安装 */
function runInstall(opencodeDir: string, pm: "npm" | "bun"): void {
  const cmd = pm === "npm"
    ? (existsSync(join(opencodeDir, "package-lock.json")) ? "npm ci" : "npm install")
    : "bun install"

  console.error(`[ensure-deps] 使用 ${pm} 安装依赖: ${cmd}`)
  execSync(cmd, {
    cwd: opencodeDir,
    timeout: 120_000,
    stdio: "pipe",
  })
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 确保所有 npm 依赖已安装。
 * - 已安装：立即返回（检查 package.json 存在性，兼容 ESM-only 包）
 * - 缺失：自动安装（npm > bun > 抛错）
 * - 并发安全：多次调用共享同一个 Promise
 * - 可重试：失败时清除缓存，后续调用可重新安装（Fix #1）
 */
export async function ensureDeps(): Promise<void> {
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    try {
      const opencodeDir = findOpencodeDir()
      const deps = getRequiredDeps(opencodeDir)

      if (checkAllInstalled(opencodeDir, deps)) {
        return
      }

      const pm = detectPackageManager()
      if (!pm) {
        throw new Error(
          "[ensure-deps] 未找到 npm 或 bun。请安装 Node.js (https://nodejs.org/) 或 Bun (https://bun.sh/)"
        )
      }

      runInstall(opencodeDir, pm)

      // 安装后再次验证
      if (!checkAllInstalled(opencodeDir, deps)) {
        throw new Error(
          `[ensure-deps] 安装后依赖仍不完整。请手动执行: cd ${opencodeDir} && ${pm} install`
        )
      }

      console.error("[ensure-deps] 依赖安装完成")
    } catch (e) {
      // 失败时清除缓存，允许后续重试（Fix #1）
      ensurePromise = null
      throw e
    }
  })()

  return ensurePromise
}
