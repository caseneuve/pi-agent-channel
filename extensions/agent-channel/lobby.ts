import { createHash } from "node:crypto";

/** Short hash for lobby channel names. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

/** Derive the lobby channel from environment-like input.
 *  Priority: CMUX_WORKSPACE_ID (cmux) → tmux socket+session+window hash → file/lobby. */
export function resolveLobbyFromEnv(
  env: Record<string, string | undefined>,
  tmuxValue: (format: "#{session_name}" | "#{window_id}") => string | undefined,
): string | undefined {
  if (env.CMUX_WORKSPACE_ID) return env.CMUX_WORKSPACE_ID;
  if (env.TMUX) {
    const session = tmuxValue("#{session_name}");
    const windowId = tmuxValue("#{window_id}");
    if (session && windowId) {
      const socket = (env.TMUX || "").split(",")[0] || "";
      const hash = shortHash(`${socket}/${session}/${windowId}`);
      return `tmux/${session}-${windowId}-${hash}`;
    }
  }
  return "file/lobby";
}
