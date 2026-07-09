"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MANIFEST = {
  schemaVersion: 1,
  docsDir: "功能文档",
  appName: {
    source: "repo-dir",
    configFile: "ai-agent/config/aidevApp.json",
    field: "app",
  },
  outputs: {
    serviceList: "{app}-服务清单",
    functionList: "{app}-功能清单",
    functionDocGuide: "{app}-功能文档说明",
    functionDocSuffix: "功能文档",
  },
  // 能力声明：skill 在 manifest.json 中显式声明才生效；未声明时走默认值。
  // serviceList/functionList/functionDocGuide/functionDoc: 是否生成对应任务
  // docPathSource: function-doc 的 output 路径来源
  //   - "function-rows"：从 function canonical rows 派生（默认，icbc 走这里）
  //   - "function-facts"：从 L2 functions.json 直接派生（oracle-sp 走这里）
  capabilities: {
    serviceList: true,
    functionList: true,
    functionDocGuide: true,
    functionDoc: true,
    docPathSource: "function-rows",
  },
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return fallback;
  }
}

function deepMerge(base, override) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function skillDir(baseDir, l3Skill) {
  const name = l3Skill || "wiki-l3-icbc";
  const candidates = [
    path.resolve(baseDir, "..", name),
    path.resolve(baseDir, "..", "..", name),
    path.resolve(baseDir, "..", "lingxicode-runtime", "config", "skills", name),
    path.resolve(baseDir, "..", "..", "lingxicode-runtime", "config", "skills", name),
    path.resolve(process.cwd(), "vendor", "lingxicode-runtime", "config", "skills", name),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "manifest.json")) || fs.existsSync(path.join(dir, "SKILL.md"))) || candidates[0];
}

function loadManifest(baseDir, l3Skill) {
  const dir = skillDir(baseDir, l3Skill);
  return deepMerge(DEFAULT_MANIFEST, readJsonSafe(path.join(dir, "manifest.json"), {}));
}

function renderPattern(pattern, values) {
  return String(pattern || "").replace(/\{(\w+)\}/g, (_, key) => values && values[key] != null ? String(values[key]) : "");
}

function appName(repo, manifest) {
  const cfg = manifest && manifest.appName || {};
  if (cfg.source === "aidevApp") {
    const file = path.join(repo, cfg.configFile || "ai-agent/config/aidevApp.json");
    const data = readJsonSafe(file, null);
    const value = data && data[cfg.field || "app"];
    if (value) return String(value);
  }
  return path.basename(repo);
}

function docsDir(repo, manifest) {
  const rootEnv = manifest && manifest.docsRootEnv ? String(manifest.docsRootEnv).trim() : "";
  if (rootEnv && process.env[rootEnv]) {
    return path.join(path.resolve(process.env[rootEnv]), manifest.docsDir || DEFAULT_MANIFEST.docsDir);
  }
  return path.join(repo, "docs", manifest.docsDir || DEFAULT_MANIFEST.docsDir);
}

function outputBaseName(kind, app, manifest) {
  const outputs = manifest && manifest.outputs || {};
  if (kind === "service-list") return renderPattern(outputs.serviceList || DEFAULT_MANIFEST.outputs.serviceList, { app });
  if (kind === "function-list") return renderPattern(outputs.functionList || DEFAULT_MANIFEST.outputs.functionList, { app });
  if (kind === "function-doc-guide") return renderPattern(outputs.functionDocGuide || DEFAULT_MANIFEST.outputs.functionDocGuide, { app });
  return "";
}

function functionDocSuffix(manifest) {
  if (manifest && manifest.outputs && "functionDocSuffix" in manifest.outputs) {
    return manifest.outputs.functionDocSuffix || "";
  }
  return DEFAULT_MANIFEST.outputs.functionDocSuffix;
}

module.exports = {
  DEFAULT_MANIFEST,
  appName,
  docsDir,
  functionDocSuffix,
  loadManifest,
  outputBaseName,
  renderPattern,
  skillDir,
};
