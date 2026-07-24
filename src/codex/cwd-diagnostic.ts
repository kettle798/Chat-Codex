import fs from "node:fs";

export type CodexCwdInspectionState = "ok" | "not_provided" | "missing" | "not_directory" | "unavailable";

export interface CodexCwdInspection {
  cwd?: string;
  realpath?: string;
  state: CodexCwdInspectionState;
  error?: string;
}

export type CodexCwdDiagnosticSource = "thread/start" | "thread/resume" | "turn/start";

export interface CodexCwdDiagnostic {
  source: CodexCwdDiagnosticSource;
  error: string;
  observedAt: string;
  sessionId?: string;
  requestCwd: CodexCwdInspection;
  inheritedProcessCwd: CodexCwdInspection;
}

export function isInvalidCwdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\binvalid cwd\b/i.test(message);
}

export function inspectCodexCwd(cwd: string | undefined): CodexCwdInspection {
  if (!cwd) return { state: "not_provided" };
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) return { cwd, state: "not_directory" };
  } catch (error) {
    return { cwd, state: errorCode(error) === "ENOENT" ? "missing" : "unavailable", error: errorMessage(error) };
  }

  let realpath: string | undefined;
  try {
    realpath = fs.realpathSync.native(cwd);
  } catch (error) {
    return { cwd, state: "unavailable", error: errorMessage(error) };
  }

  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    return { cwd, realpath, state: "ok" };
  } catch (error) {
    return { cwd, realpath, state: "unavailable", error: errorMessage(error) };
  }
}

export function inspectCurrentProcessCwd(): CodexCwdInspection {
  try {
    return inspectCodexCwd(process.cwd());
  } catch (error) {
    return { state: "unavailable", error: errorMessage(error) };
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
