import type { CodexEvent } from "../codex/types.js";

export type CodexContextCompactionEvent = Extract<CodexEvent, { type: "context.compaction" }>;

export function contextCompactionNotice(event: CodexContextCompactionEvent): string {
  return event.phase === "started"
    ? "Codex 正在压缩当前会话的上下文。"
    : "Codex 已完成当前会话的上下文压缩。";
}
