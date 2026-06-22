import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

const __dirname = import.meta.dirname

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    include: ["tests/ts/**/*.test.ts"],
    // zod v4 的 ESM index.js 使用 `import * as z; export { z }` 模式，
    // esbuild 预打包时无法正确处理 namespace re-export，导致 `z` 为 undefined。
    // 解决方案：将 zod 标记为 inline 依赖，阻止 esbuild 预打包，
    // 让 Node.js 原生 ESM 加载器处理（Node 能正确解析 namespace re-export）。
    server: {
      deps: {
        // zod v4 的 ESM index.js 使用 `import * as z; export { z }` 模式，
        // esbuild 预打包时无法正确处理 namespace re-export，导致 `z` 为 undefined。
        // 解决方案：将 zod 及其子路径标记为 inline 依赖，阻止 esbuild 预打包，
        // 让 Node.js 原生 ESM 加载器处理（Node 能正确解析 namespace re-export）。
        inline: ["zod", "zod/v4/core"],
      },
    },
  },
  resolve: {
    alias: [
      { find: "@workflow", replacement: resolve(__dirname, ".opencode/workflow") },
      { find: "@plugins", replacement: resolve(__dirname, ".opencode/plugins") },
    ],
  },
})
