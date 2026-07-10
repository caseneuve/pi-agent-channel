#!/usr/bin/env bun
/** Manage the package-owned relay with the established dotagents lifecycle. */
import { spawnSync } from "node:child_process";

const relayScript = new URL("./relay.ts", import.meta.url).pathname;
// Recognize the temporary dotagents entrypoint so its compatibility wrapper
// can manage a relay that was started before package cutover.
const relayEntrypoints = [relayScript, "shared/relay/main.ts"];
const relaySocket = "/tmp/agent-channels.sock";
const relayLog = "/tmp/agent-relay.log";

function shell(command: string, args: string[]): void {
  spawnSync(command, args, { stdio: "inherit" });
}

function relayPid(): string | undefined {
  for (const entrypoint of relayEntrypoints) {
    const result = spawnSync("pgrep", ["-f", entrypoint], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim().split("\n")[0];
  }
  return undefined;
}

function status(): void {
  const pid = relayPid();
  if (!pid) {
    console.log("relay: not running");
    return;
  }
  console.log("relay pid:", pid);
  shell("ps", ["-o", "pid,etime,rss,command", "-p", pid]);
  console.log();
  shell("ls", ["-la", relaySocket]);
  console.log(`\n--- last 10 log lines (${relayLog}) ---`);
  shell("tail", ["-n", "10", relayLog]);
}

async function start(): Promise<void> {
  const existing = relayPid();
  if (existing) {
    console.log("relay already running, pid:", existing);
    return;
  }
  spawnSync("sh", [
    "-c",
    `nohup bun ${relayScript} --quiet >> ${relayLog} 2>&1 &`,
  ]);
  await Bun.sleep(400);
  const pid = relayPid();
  if (pid) console.log("relay started, pid:", pid);
  else {
    console.log("relay start: PID not detected; check", relayLog);
    globalThis.process.exitCode = 1;
  }
}

async function stop(): Promise<void> {
  const pid = relayPid();
  if (!pid) {
    console.log("relay: not running");
    return;
  }
  shell("kill", [pid]);
  await Bun.sleep(500);
  if (relayPid()) {
    console.log("relay still running after SIGTERM; sending SIGKILL");
    shell("kill", ["-9", pid]);
  } else console.log("relay stopped, pid was:", pid);
}

function usage(): string {
  return `pi-agent-channel-relay — manage the detached agent-channel relay

Usage: pi-agent-channel-relay <command>

Commands:
  start     Start the relay if it is not already running.
  stop      Stop the running relay with SIGTERM.
  status    Show the relay PID, socket, and recent log output.
  restart   Stop, wait briefly, then start the relay.
  logs      Follow the relay log; press Ctrl+C to stop following.

The relay uses Bun, /tmp/agent-channels.sock, and /tmp/agent-relay.log.`;
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "status":
      status();
      break;
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      await Bun.sleep(700);
      await start();
      break;
    case "logs":
      shell("tail", ["-f", relayLog]);
      break;
    case "-h":
    case "--help":
    case "help":
      console.log(usage());
      break;
    default:
      console.error(
        `Unknown command: ${process.argv[2] ?? "(none)"}\n\n${usage()}`,
      );
      process.exitCode = 1;
  }
}

await main();
