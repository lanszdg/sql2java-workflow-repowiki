/**
 * harness/index.ts — L2 执行点测试 harness 统一导出
 */

export type {
  PhaseName,
  AssertionResult,
  CaseContext,
  CaseConfig,
  JudgeExecutionPointOptions,
  JudgeResult,
} from "./types"

export {
  runExecutionPoint,
  parseArtifacts,
  collectGeneratedFiles,
  type RunExecutionPointOptions,
  type RunExecutionPointResult,
} from "./run-test"

export { prepareExecutionPoint, RUN_ID, type PrepareOptions, type PreparedWorkspace } from "./workspace"

export {
  assertArtifactExists,
  assertArtifactField,
  assertArtifactFieldMatches,
  assertRunStatus,
  assertRunCompleted,
  assertGeneratedFileExists,
  assertJavaMatches,
  assertDecision,
  assertCheckFound,
  assertFileExists,
  assertFilesExist,
  assertStdoutContains,
  runAssertions,
  severityRank,
} from "./assertions"

export { judgeExecutionPoint, parseJudgeOutput } from "./judge"

export {
  printReport,
  generateJsonReport,
  casePassed,
  type CaseReport,
  type SuiteReport,
} from "./report"
