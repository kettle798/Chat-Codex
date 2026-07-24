import { arrayValue, objectValue, stringValue } from "./value-parsers.js";

/**
 * Returns the newest user-visible assistant message from a thread/read history.
 * Commentary is intentionally excluded because it is not the final reply.
 */
export function lastAssistantMessageFromThread(thread: Record<string, unknown>): string | undefined {
  const turns = arrayValue(thread.turns);
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = arrayValue(objectValue(turns[turnIndex]).items);
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = objectValue(items[itemIndex]);
      if (stringValue(item.type) !== "agentMessage" || stringValue(item.phase) === "commentary") continue;
      const text = stringValue(item.text)?.trim();
      if (text) return text;
    }
  }
  return undefined;
}

export async function readLastAssistantMessageFromHistory(
  request: (params: { threadId: string; includeTurns: true }) => Promise<Record<string, unknown>>,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const response = await request({ threadId: sessionId, includeTurns: true });
    return lastAssistantMessageFromThread(objectValue(response.thread));
  } catch {
    // A history read is additive: a successful reload must not fail on older app-server builds.
    return undefined;
  }
}
