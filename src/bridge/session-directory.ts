import { formatLocalDateTimeWithZone } from "../time/display-time.js";
import type { SessionListItem } from "./bridge-types.js";
import { formatCompactPath, timestampValue } from "./formatters.js";
import { SESSION_LIST_PAGE_SIZE } from "./session-list.js";

export const UNKNOWN_SESSION_CWD_KEY = "__unknown_session_cwd__";

export interface SessionDirectoryItem {
  key: string;
  cwd?: string;
  totalSessions: number;
  selectableSessions: number;
  current: boolean;
  latestUpdatedAt: string;
}

export interface SessionDirectoryPage {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: SessionDirectoryItem[];
  clamped: boolean;
}

export interface FormatSessionDirectoryOptions {
  intro?: string;
}

export function buildSessionDirectories(items: SessionListItem[]): SessionDirectoryItem[] {
  const directories = new Map<string, SessionDirectoryItem>();
  for (const item of items) {
    const key = sessionDirectoryKey(item.cwd);
    const existing = directories.get(key);
    directories.set(key, {
      key,
      cwd: item.cwd,
      totalSessions: (existing?.totalSessions ?? 0) + 1,
      selectableSessions: (existing?.selectableSessions ?? 0) + (item.selectable ? 1 : 0),
      current: Boolean(existing?.current || item.current),
      latestUpdatedAt: newerTimestamp(existing?.latestUpdatedAt ?? "", item.updatedAt),
    });
  }
  return [...directories.values()].sort(compareSessionDirectories);
}

export function sessionDirectoryKey(cwd: string | undefined): string {
  return cwd && cwd.trim().length > 0 ? cwd : UNKNOWN_SESSION_CWD_KEY;
}

export function paginateSessionDirectories(
  items: SessionDirectoryItem[],
  requestedPage: number,
  pageSize = SESSION_LIST_PAGE_SIZE,
): SessionDirectoryPage {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const totalItems = items.length;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / normalizedPageSize) : 1;
  const normalizedRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(normalizedRequestedPage, 1), totalPages);
  const start = (page - 1) * normalizedPageSize;
  return {
    page,
    pageSize: normalizedPageSize,
    totalItems,
    totalPages,
    items: items.slice(start, start + normalizedPageSize),
    clamped: page !== normalizedRequestedPage,
  };
}

export function formatSessionDirectoryPage(page: SessionDirectoryPage, options: FormatSessionDirectoryOptions = {}): string {
  const lines = [
    "**Codex 会话目录**",
    options.intro,
    "",
    "- 范围: 全部可发现",
    `- 页码: \`${page.page} / ${page.totalPages}\``,
    `- 目录数: \`${page.totalItems}\``,
    page.clamped ? "- 提示: 页码超出范围，已显示最近可用页。" : undefined,
    "",
  ].filter((line): line is string => line !== undefined);

  if (page.totalItems === 0) {
    lines.push("未发现包含工作目录信息的 Codex 会话。发送 `/new` 创建新会话。");
  } else {
    page.items.forEach((item, index) => {
      lines.push(...formatSessionDirectoryItem(item, index + 1));
    });
  }

  lines.push("", "直接回复编号查看该目录下的 session；回复 `n` 下一页，`p` 上一页；回复“取消”退出。");
  return lines.join("\n").trimEnd();
}

export function formatSessionDirectoryScope(cwd: string | undefined): string {
  return cwd ? `工作目录 \`${formatCompactPath(cwd)}\`` : "未知工作目录";
}

function formatSessionDirectoryItem(item: SessionDirectoryItem, index: number): string[] {
  const suffix = item.current ? "（当前）" : "";
  return [
    `${index}. 工作目录: \`${directoryDisplayPath(item.cwd)}\`${suffix}`,
    `   - 会话数: \`${item.totalSessions}\``,
    `   - 最近活跃: \`${formatDirectoryUpdatedAt(item.latestUpdatedAt)}\``,
    `   - 可切换: \`${item.selectableSessions}\``,
  ];
}

function directoryDisplayPath(cwd: string | undefined): string {
  return cwd ? formatCompactPath(cwd) : "未知目录";
}

function formatDirectoryUpdatedAt(updatedAt: string): string {
  return updatedAt ? formatLocalDateTimeWithZone(updatedAt) : "未知";
}

function compareSessionDirectories(left: SessionDirectoryItem, right: SessionDirectoryItem): number {
  return timestampValue(right.latestUpdatedAt) - timestampValue(left.latestUpdatedAt)
    || directorySortValue(left).localeCompare(directorySortValue(right));
}

function directorySortValue(item: SessionDirectoryItem): string {
  return item.cwd ?? "";
}

function newerTimestamp(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return timestampValue(left) >= timestampValue(right) ? left : right;
}
