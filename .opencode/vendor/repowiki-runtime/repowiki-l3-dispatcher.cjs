#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const skillDir = __dirname;
const packageRoot = path.resolve(skillDir, "..", "..", "..");
const progressCli = path.join(skillDir, "repowiki-progress.cjs");
const workerPromptFile = path.join(skillDir, "l3-worker-prompt.md");

function usage() {
  console.error("usage: node repowiki-l3-dispatcher.cjs <repo> [--kind <kind>] [--runner <opencode|lingxicode.bat>] [--poll-ms <n>] [--once] [--dry-run] [--verbose-worker-output]");
  process.exit(2);
}

function argValue(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function numberArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return fallback;
  }
}

function runNode(args) {
  return childProcess.execFileSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseProgressLine(line) {
  const text = String(line || "").trim();
  const out = { raw: text, allDone: /\bstatus=ALL_DONE\b/.test(text) || /\bALL_DONE l3\b/.test(text) };
  for (const key of ["outputs", "running", "ready", "blocked", "dispatch", "failed", "pending", "fakeDone"]) {
    const m = text.match(new RegExp(`\\b${key}=([^\\s]+)`));
    if (!m) continue;
    const value = m[1];
    if (value.includes("/")) {
      const [current, total] = value.split("/").map((x) => Number(x));
      out[key] = Number.isFinite(current) ? current : 0;
      out[`${key}Limit`] = Number.isFinite(total) ? total : 0;
    } else {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : 0;
    }
  }
  const hint = text.match(/\bdispatchHint=([^\s]+)/);
  if (hint) out.dispatchHint = hint[1];
  return out;
}

function decisionFromProgress(progress) {
  const dispatch = Math.max(0, Math.floor(Number(progress.dispatch) || 0));
  if (progress.allDone) return { action: "done", spawn: 0, reason: "all_done" };
  if (dispatch > 0) return { action: "spawn", spawn: dispatch, reason: progress.dispatchHint || `spawn_exactly_${dispatch}` };
  if ((progress.running || 0) > 0) return { action: "wait", spawn: 0, reason: "wait_running" };
  if ((progress.failed || 0) > 0) return { action: "failed", spawn: 0, reason: "failed_tasks" };
  if ((progress.pending || 0) > 0 || (progress.blocked || 0) > 0) return { action: "blocked", spawn: 0, reason: "wait_upstream" };
  return { action: "done", spawn: 0, reason: "no_remaining_work" };
}

function defaultRunner() {
  const exe = path.join(packageRoot, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  if (fs.existsSync(exe)) return exe;
  return path.join(packageRoot, "lingxicode.bat");
}

function pathEnvValue(env) {
  if (!env) return "";
  for (const key of ["PATH", "Path", "path"]) {
    if (env[key]) return env[key];
  }
  const found = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return found ? env[found] || "" : "";
}

function runnerEnv(baseEnv) {
  const env = { ...baseEnv };
  env.OPENCODE_PARSERS_DIR = env.OPENCODE_PARSERS_DIR || path.join(packageRoot, "parsers");
  env.OPENCODE_DISABLE_AUTOUPDATE = env.OPENCODE_DISABLE_AUTOUPDATE || "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = env.OPENCODE_DISABLE_MODELS_FETCH || "true";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = env.OPENCODE_DISABLE_LSP_DOWNLOAD || "true";
  env.OPENCODE_CONFIG_DIR = env.OPENCODE_CONFIG_DIR || path.join(packageRoot, "config");
  env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || "3600000";
  const codegraphHome = path.join(packageRoot, "config", "bin", "codegraph");
  env.CODEGRAPH_HOME = env.CODEGRAPH_HOME || codegraphHome;
  const sep = process.platform === "win32" ? ";" : ":";
  env.PATH = `${codegraphHome}${sep}${pathEnvValue(env)}`;
  return env;
}

function validateOpencodeConfig(modelOverride = "") {
  const configFile = path.join(packageRoot, "config", "opencode.json");
  const config = readJson(configFile, null);
  if (!config && !modelOverride) return { ok: true, skipped: true };
  const model = String(modelOverride || (config && config.model) || "");
  if (!model) return { ok: true, skipped: true };
  const providers = (config && config.provider) || {};
  const enabledProviders = (config && Array.isArray(config.enabled_providers) && config.enabled_providers.length)
    ? config.enabled_providers.filter((pid) => providers[pid])
    : Object.keys(providers);
  let providerId, modelId;
  if (model.includes("/")) {
    const parts = model.split("/");
    providerId = parts[0];
    modelId = parts.slice(1).join("/");
  } else {
    const found = enabledProviders.find((pid) => {
      const p = providers[pid];
      return p && p.models && Object.prototype.hasOwnProperty.call(p.models, model);
    });
    if (!found) {
      const allModels = enabledProviders.map((pid) => Object.keys((providers[pid] && providers[pid].models) || {}).join(",")).join(",");
      return {
        ok: false,
        reason: `opencode model not configured: ${model}; enabled providers=${enabledProviders.join(",") || "<none>"} models=${allModels || "<none>"}`,
      };
    }
    providerId = found;
    modelId = model;
  }
  const provider = providers[providerId];
  const models = (provider && provider.models) || {};
  if (!Object.prototype.hasOwnProperty.call(models, modelId)) {
    return {
      ok: false,
      reason: `opencode model not configured: ${model}; provider ${providerId} models=${Object.keys(models).join(",") || "<none>"}`,
    };
  }
  return { ok: true };
}

function dispatcherLogDir(repo) {
  return path.join(repo, ".repowiki", "logs", "l3-dispatcher");
}

function dispatcherPromptDir(repo) {
  return path.join(dispatcherLogDir(repo), "prompts");
}

function safeLogName(s) {
  return String(s || "worker").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160);
}

function statusLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\[L3-task\]\s+(done|fail|no-task|no-slot|no-ready-task)\b/.test(line));
}

function writeWorkerChunk(info, streamName, buf, verboseWorkerOutput) {
  const text = String(buf || "");
  if (info.logStream) info.logStream.write(`[${streamName}] ${text}`);
  if (verboseWorkerOutput) {
    for (const line of statusLines(text)) {
      const writer = /\b(fail|no-slot)\b/.test(line) ? process.stderr : process.stdout;
      writer.write(`[${info.agentName}] ${line}\n`);
    }
  }
  if (verboseWorkerOutput) {
    const writer = streamName === "stderr" ? process.stderr : process.stdout;
    writer.write(`[${info.agentName}] ${text}`);
  }
}

function concreteWorkerPrompt(repo, agentName, kind) {
  const prompt = readText(workerPromptFile)
    .replace(/<REPOWIKI_SKILL_DIR>/g, skillDir)
    .replace(/<REPO>/g, repo)
    .replace(/<AGENT_NAME>/g, agentName)
    .replace(/<KIND>/g, kind || "");
  const kindLine = kind
    ? `本次必须领取 kind=${kind} 的任务，claim 命令必须带 --kind ${kind}。`
    : "本次不限定 kind，claim 命令不要带 --kind。";
  return [
    "你是由 repowiki-l3-dispatcher.cjs 启动的滚动 L3 worker。",
    kindLine,
    "严格按下面固定提示执行；只处理一个 claim 到的 task，done/fail 后立即结束。",
    "",
    prompt,
  ].join("\n");
}

function writeWorkerPromptAttachment(repo, agentName, message) {
  const dir = dispatcherPromptDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeLogName(agentName)}.prompt.md`);
  fs.writeFileSync(file, message, "utf8");
  return file;
}

function workerPromptAttachmentMessage(agentName) {
  return [
    `Read the attached L3 worker prompt file for agent ${agentName} and follow it exactly.`,
    "Do not summarize the attachment. Execute one claim/done/fail cycle and finish with the one-line [L3-task] status required by the prompt.",
  ].join("\n");
}

function buildWorkerRunArgs(options, agentName, promptFile) {
  const args = [
    "run",
    workerPromptAttachmentMessage(agentName),
    "--dir", options.repo,
    "--title", agentName,
    "--dangerously-skip-permissions",
  ];
  if (options.model) args.push("--model", options.model);
  args.push("--file", promptFile);
  return args;
}

function windowsBatSpawnPlan(runner, args, command = process.env.ComSpec || "cmd.exe") {
  return {
    command,
    args: ["/d", "/s", "/c", "call", runner, ...args],
  };
}

function spawnWorker(options, seq) {
  const agentName = `${options.agentPrefix}-${Date.now()}-${seq}`;
  const message = concreteWorkerPrompt(options.repo, agentName, options.kind);
  const promptFile = writeWorkerPromptAttachment(options.repo, agentName, message);
  const runner = options.runner;
  const args = buildWorkerRunArgs(options, agentName, promptFile);
  const logDir = dispatcherLogDir(options.repo);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${safeLogName(agentName)}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  logStream.write(`[dispatcher] agent=${agentName} started=${new Date().toISOString()}\n`);
  logStream.write(`[dispatcher] prompt=${promptFile}\n`);
  const child = process.platform === "win32" && /\.bat$/i.test(runner)
    ? (() => {
      const plan = windowsBatSpawnPlan(runner, args);
      return childProcess.spawn(plan.command, plan.args, {
        cwd: packageRoot,
        env: runnerEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    })()
    : childProcess.spawn(runner, args, {
      cwd: packageRoot,
      env: runnerEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
  const info = { child, agentName, startedAt: Date.now(), logFile, logStream };
  child.stdout.on("data", (buf) => writeWorkerChunk(info, "stdout", buf, options.verboseWorkerOutput));
  child.stderr.on("data", (buf) => writeWorkerChunk(info, "stderr", buf, options.verboseWorkerOutput));
  child.on("exit", (code, signal) => {
    closeWorkerLog(info, `[dispatcher] agent=${agentName} exit code=${code === null ? "" : code} signal=${signal || ""} finished=${new Date().toISOString()}\n`);
  });
  if (options.verboseWorkerOutput) {
    console.log(`[L3-dispatcher] worker-start agent=${agentName} log=${logFile}`);
  }
  return info;
}

function closeWorkerLog(info, line = "") {
  if (!info || info.logClosed || !info.logStream) return;
  if (line) info.logStream.write(line);
  info.logStream.end();
  info.logClosed = true;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    childProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else if (!child.killed) {
    child.kill("SIGTERM");
  }
}

function stopActiveWorkers(active, reason = "dispatcher_stop", killFn = killProcessTree) {
  if (!active || active.size === 0) return 0;
  let stopped = 0;
  for (const [, info] of active) {
    if (!info || info.exited) continue;
    closeWorkerLog(info, `[dispatcher] agent=${info.agentName || ""} stop reason=${reason} finished=${new Date().toISOString()}\n`);
    try {
      killFn(info.child);
    } catch (_) {
      // A failed cleanup must not keep the dispatcher alive after all tasks are done.
    }
    try { if (info.child && info.child.stdout) info.child.stdout.destroy(); } catch (_) {}
    try { if (info.child && info.child.stderr) info.child.stderr.destroy(); } catch (_) {}
    try { if (info.child && info.child.unref) info.child.unref(); } catch (_) {}
    info.exited = true;
    stopped++;
  }
  active.clear();
  return stopped;
}

function windowsQuote(value) {
  const s = String(value);
  if (!/[ \t"^&|<>]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function readProgress(repo) {
  const output = runNode([progressCli, repo, "l3", "--line"]).trim().split(/\r?\n/).filter(Boolean).pop() || "";
  return parseProgressLine(output);
}

function reflectedActiveCount(repo, active) {
  if (!active || active.size === 0) return 0;
  const state = readJson(path.join(repo, ".repowiki", "l3-scheduler", "state.json"), { tasks: {} });
  const activeAgents = new Set(Array.from(active.values()).map((item) => item.agentName).filter(Boolean));
  let count = 0;
  for (const item of Object.values(state.tasks || {})) {
    if (item && item.status === "running" && activeAgents.has(item.agent)) count++;
  }
  return count;
}

function spawnCountForProgress(progress, activeSize, reflectedActive, freshActive = activeSize) {
  const decision = decisionFromProgress(progress);
  if (decision.action !== "spawn") return { ...decision, spawnNow: 0 };
  const limit = Math.max(1, Math.floor(Number(progress.runningLimit) || 1));
  const running = Math.max(0, Math.floor(Number(progress.running) || 0));
  const reflected = Math.max(0, Math.min(Math.floor(Number(reflectedActive) || 0), running, activeSize));
  const externalRunning = Math.max(0, running - reflected);
  const freshUnreflected = Math.max(0, Math.min(Math.floor(Number(freshActive) || 0), Math.max(0, activeSize - reflected)));
  const reservedSlots = Math.max(0, externalRunning + reflected + freshUnreflected);
  const available = Math.max(0, limit - reservedSlots);
  const ready = Math.max(0, Math.floor(Number(progress.ready) || 0));
  return { ...decision, spawnNow: Math.min(decision.spawn, available, ready), reservedSlots, externalRunning, reflectedActive: reflected, freshActive: freshUnreflected };
}

function freshActiveCount(active, reflectedActive, graceMs) {
  if (!active || active.size === 0) return 0;
  const now = Date.now();
  const fresh = Array.from(active.values()).filter((info) => !info.exited && now - Number(info.startedAt || now) <= graceMs).length;
  return Math.max(0, Math.min(fresh, Math.max(0, active.size - Math.max(0, Math.floor(Number(reflectedActive) || 0)))));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg || repoArg.startsWith("--")) usage();
  const options = {
    repo: path.resolve(repoArg),
    runner: path.resolve(argValue("--runner", defaultRunner())),
    kind: argValue("--kind", ""),
    pollMs: Math.max(1000, Math.floor(Number(argValue("--poll-ms", "5000")) || 5000)),
    maxLaunchFailures: Math.max(1, Math.floor(numberArg("--max-launch-failures", 3))),
    launchFailureWindowMs: Math.max(1000, Math.floor(numberArg("--launch-failure-window-ms", 30000))),
    once: hasArg("--once"),
    dryRun: hasArg("--dry-run"),
    verboseWorkerOutput: hasArg("--verbose-worker-output"),
    agentPrefix: argValue("--agent-prefix", "l3-worker"),
    model: argValue("--model", ""),
    activeStartupGraceMs: Math.max(0, Math.floor(numberArg("--active-startup-grace-ms", 30000))),
  };
  if (!fs.existsSync(options.runner)) throw new Error(`runner not found: ${options.runner}`);
  if (!options.dryRun) {
    const configCheck = validateOpencodeConfig(options.model);
    if (!configCheck.ok) throw new Error(configCheck.reason);
  }

  const active = new Map();
  const launchFailures = [];
  let sequence = 1;
  while (true) {
    for (const [pid, info] of active) {
      if (info.exited) active.delete(pid);
    }
    const progress = readProgress(options.repo);
    const reflected = reflectedActiveCount(options.repo, active);
    const freshActive = freshActiveCount(active, reflected, options.activeStartupGraceMs);
    const decision = spawnCountForProgress(progress, active.size, reflected, freshActive);
    console.log(`[L3-dispatcher] ${progress.raw}`);
    if (options.verboseWorkerOutput || options.dryRun) {
      console.log(`[L3-dispatcher] action=${decision.action} spawn=${decision.spawnNow || 0} requested=${decision.spawn || 0} active=${active.size} reflected=${decision.reflectedActive || 0} fresh=${decision.freshActive || 0} externalRunning=${decision.externalRunning || 0} reason=${decision.reason}`);
    }

    if (decision.action === "done") {
      const stopped = stopActiveWorkers(active, decision.reason);
      if (stopped) console.log(`[L3-dispatcher] stopped-active-workers count=${stopped} reason=${decision.reason}`);
      return;
    }
    if (decision.action === "failed") throw new Error("L3 has failed tasks and no runnable work; inspect scheduler diagnostics");
    if (decision.action === "spawn") {
      for (let i = 0; i < decision.spawnNow; i++) {
        if (options.dryRun) {
          console.log(`[L3-dispatcher] dry-run would spawn ${options.agentPrefix}-${sequence}`);
          sequence++;
          continue;
        }
        const info = spawnWorker(options, sequence++);
        active.set(info.child.pid, info);
        info.child.on("exit", (code, signal) => {
          info.exited = true;
          const ageMs = Date.now() - Number(info.startedAt || Date.now());
          // Only count genuine fast *failures* (non-zero exit / killed) toward the
          // circuit breaker. Clean fast exits (NO_READY_TASK / NO_TASK while the DAG
          // is serialized or a slot race loses) exit code 0 and must NOT trip it.
          if (ageMs < options.launchFailureWindowMs && (code !== 0 || signal)) {
            launchFailures.push({ at: Date.now(), agentName: info.agentName, code, signal });
            while (launchFailures.length && Date.now() - launchFailures[0].at > options.launchFailureWindowMs) launchFailures.shift();
            if (launchFailures.length >= options.maxLaunchFailures) {
              console.error(`[L3-dispatcher] launch-failure-threshold failures=${launchFailures.length}/${options.maxLaunchFailures} windowMs=${options.launchFailureWindowMs}; stopping to avoid respawn loop`);
              process.exitCode = 1;
            }
          }
          const failed = code !== 0 || !!signal;
          if (failed || options.verboseWorkerOutput) {
            console.log(`[L3-dispatcher] worker-exit agent=${info.agentName} code=${code === null ? "" : code} signal=${signal || ""}${failed ? ` log=${info.logFile}` : ""}`);
          }
        });
      }
    }
    // 当等待 running worker 时，定期 reap 卡住的任务。
    // worker 可能生成文件但未调 done（LLM 协议执行不可靠），导致任务卡在 running。
    // reap 会检测超时（RUNNING_STALE_MS，默认 10 分钟）的 running 任务：
    //   输出文件有效 → 自动 done；无效 → 重置为 pending 重新派发。
    // 不加这一步，dispatcher 会无限 wait_running，永远无法到达 ALL_DONE。
    if (decision.action === "wait" && (progress.running || 0) > 0 && !options.dryRun) {
      try {
        const reapOut = runNode([
          path.join(skillDir, "repowiki-l3-task.cjs"),
          "reap",
          options.repo,
        ]);
        const reapLine = String(reapOut).trim().split(/\r?\n/).pop();
        if (reapLine && reapLine.includes("changed=1")) {
          console.log(`[L3-dispatcher] reaped stale tasks: ${reapLine}`);
        }
      } catch (e) {
        // reap 失败不致命，继续等待
      }
    }
    if (options.once || options.dryRun) return;
    if (process.exitCode) return;
    await sleep(options.pollMs);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[L3-dispatcher] ERROR ${err && err.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  parseProgressLine,
  decisionFromProgress,
  spawnCountForProgress,
  concreteWorkerPrompt,
  buildWorkerRunArgs,
  windowsBatSpawnPlan,
  dispatcherLogDir,
  dispatcherPromptDir,
  runnerEnv,
  safeLogName,
  statusLines,
  stopActiveWorkers,
  validateOpencodeConfig,
};
