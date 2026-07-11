import type { CodexSessionDetail, CodexSessionGitInfo, CodexSessionStatus, CodexSessionSummary } from "../types.js";
import { isoFromSeconds, numberValue, objectValue, stringValue } from "./value-parsers.js";

export function sessionSummaryFromThread(value: Record<string, unknown>): CodexSessionSummary | undefined {
  const id = stringValue(value.id);
  if (!id) return undefined;
  return {
    id,
    title: stringValue(value.name) ?? stringValue(value.preview),
    cwd: stringValue(value.cwd),
    status: statusFromThread(value.status),
    updatedAt: threadUpdatedAt(value),
  };
}

export function sessionDetailFromThread(value: Record<string, unknown>): CodexSessionDetail | undefined {
  const threadId = stringValue(value.id);
  const sessionId = stringValue(value.sessionId);
  const id = threadId ?? sessionId;
  if (!id) return undefined;
  const source = stringValue(value.source);
  const threadSource = stringValue(value.threadSource);
  const modelProvider = stringValue(value.modelProvider);
  const cliVersion = stringValue(value.cliVersion);
  const path = stringValue(value.path);
  const forkedFromId = stringValue(value.forkedFromId);
  const parentThreadId = stringValue(value.parentThreadId);
  const gitInfo = gitInfoFromThread(value.gitInfo);
  const createdAt = isoFromSeconds(numberValue(value.createdAt));
  const recencyAt = isoFromSeconds(numberValue(value.recencyAt));
  return {
    id,
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
    title: stringValue(value.name) ?? undefined,
    preview: stringValue(value.preview) ?? undefined,
    cwd: stringValue(value.cwd),
    status: statusFromThread(value.status),
    updatedAt: threadUpdatedAt(value),
    ...(createdAt ? { createdAt } : {}),
    ...(recencyAt ? { recencyAt } : {}),
    ...(source ? { source } : {}),
    ...(threadSource ? { threadSource } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(path ? { path } : {}),
    ...(Object.keys(gitInfo).length > 0 ? { gitInfo } : {}),
    ...(forkedFromId ? { forkedFromId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(typeof value.ephemeral === "boolean" ? { ephemeral: value.ephemeral } : {}),
  };
}

export function mergeSessionSummaries(
  left: CodexSessionSummary[],
  right: CodexSessionSummary[],
): CodexSessionSummary[] {
  const merged = new Map<string, CodexSessionSummary>();
  for (const session of [...left, ...right]) {
    const existing = merged.get(session.id);
    if (!existing) {
      merged.set(session.id, { ...session });
      continue;
    }
    merged.set(session.id, {
      ...existing,
      title: existing.title ?? session.title,
      cwd: existing.cwd ?? session.cwd,
      status: preferKnownStatus(existing.status, session.status),
      updatedAt: newerTimestamp(existing.updatedAt, session.updatedAt),
      routeKey: existing.routeKey ?? session.routeKey,
    });
  }
  return [...merged.values()].sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "") || a.id.localeCompare(b.id));
}

function statusFromThread(value: unknown): CodexSessionStatus {
  const direct = stringValue(value);
  if (direct) return statusFromThreadType(direct, {});
  const status = objectValue(value);
  return statusFromThreadType(stringValue(status.type) ?? "unknown", status);
}

function statusFromThreadType(type: string, status: Record<string, unknown>): CodexSessionStatus {
  switch (type) {
    case "idle":
      return { type: "idle" };
    case "active": {
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags.filter((flag): flag is string => typeof flag === "string") : [];
      return flags.length > 0
        ? { type: "running", task: flags.join(", ") }
        : { type: "running" };
    }
    case "notLoaded":
      return { type: "unknown", detail: "not loaded" };
    case "systemError":
      return { type: "failed", error: "Codex thread system error" };
    default:
      return { type: "unknown", detail: type };
  }
}

function threadUpdatedAt(value: Record<string, unknown>): string {
  return isoFromSeconds(numberValue(value.recencyAt))
    ?? isoFromSeconds(numberValue(value.updatedAt))
    ?? isoFromSeconds(numberValue(value.createdAt))
    ?? "";
}

function gitInfoFromThread(value: unknown): CodexSessionGitInfo {
  const git = objectValue(value);
  return {
    ...(stringValue(git.root) ? { root: stringValue(git.root) } : {}),
    ...(stringValue(git.branch) ? { branch: stringValue(git.branch) } : {}),
    ...(stringValue(git.sha) ? { sha: stringValue(git.sha) } : {}),
    ...(stringValue(git.originUrl) ? { originUrl: stringValue(git.originUrl) } : {}),
  };
}

function preferKnownStatus(left: CodexSessionStatus, right: CodexSessionStatus): CodexSessionStatus {
  if (left.type === "unknown" && right.type !== "unknown") return right;
  return left;
}

function newerTimestamp(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
