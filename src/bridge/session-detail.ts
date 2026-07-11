import { truncateDisplayText } from "../codex/codex-cli.js";
import type { CodexAdapter, CodexSessionDetail, CodexSessionGitInfo, CodexSessionSummary } from "../codex/types.js";
import type { ChannelMessage } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import { formatLocalDateTimeWithZone } from "../time/display-time.js";
import { formatCodexStatus, formatCompactPath, truncateForChannel } from "./formatters.js";

export interface SessionDetailTextOptions {
  state: MemoryStateStore;
  codex: CodexAdapter;
  message: ChannelMessage;
  sessionId: string;
}

export async function sessionDetailText(options: SessionDetailTextOptions): Promise<string> {
  const detail = await loadSessionDetail(options.codex, options.sessionId);
  if (!detail) {
    return [
      "未找到 Codex 会话详情。",
      `Session: \`${options.sessionId}\``,
      "可发送 `/sessions all` 查看全部可发现会话。",
    ].join("\n");
  }
  return formatSessionDetail(detail, sessionOwnershipText(options.state, options.message.routeKey, options.sessionId));
}

async function loadSessionDetail(codex: CodexAdapter, sessionId: string): Promise<CodexSessionDetail | undefined> {
  const detail = await codex.getSessionDetail?.(sessionId).catch(() => undefined);
  if (detail) return detail;
  const summary = (await codex.listSessions(undefined).catch(() => []))
    .find((session) => session.id === sessionId);
  return summary ? detailFromSummary(summary) : undefined;
}

function detailFromSummary(summary: CodexSessionSummary): CodexSessionDetail {
  return {
    ...summary,
    sessionId: summary.id,
    threadId: summary.id,
  };
}

function formatSessionDetail(detail: CodexSessionDetail, ownership: string): string {
  const lines = [
    "**Codex 会话详情**",
    "",
    `- Session: \`${detail.sessionId ?? detail.id}\``,
    detail.threadId && detail.threadId !== (detail.sessionId ?? detail.id) ? `- Thread: \`${detail.threadId}\`` : undefined,
    detail.title ? `- 标题: ${truncateDisplayText(detail.title, 80)}` : undefined,
    detail.preview ? `- 预览: ${truncateForChannel(detail.preview, 160)}` : undefined,
    `- 状态: ${formatCodexStatus(detail.status)}`,
    detail.cwd ? `- 工作目录: \`${formatCompactPath(detail.cwd)}\`` : undefined,
    detail.updatedAt ? `- 最近活跃: \`${formatDetailTime(detail.updatedAt)}\`` : undefined,
    detail.createdAt ? `- 创建时间: \`${formatDetailTime(detail.createdAt)}\`` : undefined,
    detail.recencyAt && detail.recencyAt !== detail.updatedAt ? `- Recency: \`${formatDetailTime(detail.recencyAt)}\`` : undefined,
    detail.source ? `- 来源: \`${detail.source}\`` : undefined,
    detail.threadSource ? `- Thread source: \`${detail.threadSource}\`` : undefined,
    detail.modelProvider ? `- Model provider: \`${detail.modelProvider}\`` : undefined,
    detail.cliVersion ? `- CLI 版本: \`${detail.cliVersion}\`` : undefined,
    detail.path ? `- 历史文件: \`${formatCompactPath(detail.path)}\`` : undefined,
    formatGitInfo(detail.gitInfo),
    detail.forkedFromId ? `- Fork 来源: \`${detail.forkedFromId}\`` : undefined,
    detail.parentThreadId ? `- Parent thread: \`${detail.parentThreadId}\`` : undefined,
    typeof detail.ephemeral === "boolean" ? `- Ephemeral: \`${detail.ephemeral}\`` : undefined,
    `- 归属: ${ownership}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function sessionOwnershipText(state: MemoryStateStore, routeKey: string, sessionId: string): string {
  const owner = state.getSessionOwner(sessionId);
  if (!owner) return "未绑定";
  return owner.ownerRouteKey === routeKey ? "当前聊天" : "已绑定到其它聊天上下文";
}

function formatDetailTime(value: string): string {
  return formatLocalDateTimeWithZone(value);
}

function formatGitInfo(gitInfo: CodexSessionGitInfo | undefined): string | undefined {
  if (!gitInfo) return undefined;
  const parts = [
    gitInfo.root ? `repo=${formatCompactPath(gitInfo.root)}` : undefined,
    gitInfo.branch ? `branch=${gitInfo.branch}` : undefined,
    gitInfo.sha ? `sha=${truncateDisplayText(gitInfo.sha, 12)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `- Git: \`${parts.join(" ")}\`` : undefined;
}
