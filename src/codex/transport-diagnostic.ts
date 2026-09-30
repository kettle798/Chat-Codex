export type CodexTransportFailureKind = "invalid_json" | "process_error" | "process_exit" | "stdout_closed";

export interface CodexTransportRequestDiagnostic {
  id: string;
  method: string;
}

/**
 * Bounded local-only data for diagnosing an app-server transport failure.
 * It deliberately never retains raw stdout JSON-RPC frames.
 */
export interface CodexTransportDiagnostic {
  source: "app-server";
  kind: CodexTransportFailureKind;
  error: string;
  observedAt: string;
  processId?: number;
  stdoutLineLength?: number;
  exitCode?: number | null;
  signal?: string | null;
  pendingRequests: CodexTransportRequestDiagnostic[];
  recentRequests: CodexTransportRequestDiagnostic[];
  stderrTail?: string;
}
