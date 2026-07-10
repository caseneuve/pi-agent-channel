import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveLobbyFromEnv } from "./lobby";

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

describe("resolveLobbyFromEnv", () => {
  test("short-circuits to CMUX_WORKSPACE_ID when present", () => {
    const out = resolveLobbyFromEnv(
      {
        CMUX_WORKSPACE_ID: "cmux/workspace-123",
        TMUX: "/tmp/tmux-1000/default,1,0",
      },
      () => {
        throw new Error("tmux query should not be called");
      },
    );
    expect(out).toBe("cmux/workspace-123");
  });

  test("uses tmux session+window scope for lobby", () => {
    const env = { TMUX: "/tmp/tmux-1000/default,123,0" };
    const session = "scratch";
    const windowId = "@12";
    const expected = `tmux/${session}-${windowId}-${shortHash("/tmp/tmux-1000/default/scratch/@12")}`;

    const out = resolveLobbyFromEnv(env, (fmt) => {
      if (fmt === "#{session_name}") return session;
      if (fmt === "#{window_id}") return windowId;
      return undefined;
    });

    expect(out).toBe(expected);
  });

  test("falls back to file/lobby with no cmux/tmux env", () => {
    const out = resolveLobbyFromEnv({}, () => undefined);
    expect(out).toBe("file/lobby");
  });
});
