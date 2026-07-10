import { describe, expect, test } from "bun:test";

const cli = new URL("../bin/pi-agent-channel-relay.ts", import.meta.url)
  .pathname;

function run(...args: string[]) {
  return Bun.spawnSync(["bun", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("pi-agent-channel-relay help", () => {
  test.each(["-h", "--help", "help"])("documents commands for %s", (flag) => {
    const result = run(flag);
    const output = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("manage the detached agent-channel relay");
    expect(output).toContain("Usage: pi-agent-channel-relay <command>");
    expect(output).toContain("start     Start the relay");
    expect(output).toContain("status    Show the relay PID");
  });

  test("rejects an unknown command with help", () => {
    const result = run("wat");
    const output = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(output).toContain("Unknown command: wat");
    expect(output).toContain("Usage: pi-agent-channel-relay <command>");
  });
});
