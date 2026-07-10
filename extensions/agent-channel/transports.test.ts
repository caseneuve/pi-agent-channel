import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FileTransport } from "./transports";
import type { ChannelMessage } from "./core";

// ─── Helpers ────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ch-test-"));
}

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    channel: "test/ch",
    from: "agent-a",
    type: "status",
    body: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── FileTransport ──────────────────────────────────────────────────────

describe("FileTransport", () => {
  let dir: string;
  let transport: FileTransport;

  beforeEach(() => {
    dir = tmpDir();
    transport = new FileTransport(dir);
  });

  afterEach(() => {
    transport.unsubscribeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── publish ──

  test("publish writes message to channel file", async () => {
    const m = msg({ channel: "test/pub" });
    await transport.publish(m);

    const file = path.join(dir, "test_pub.json");
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].id).toBe(m.id);
  });

  test("publish appends to existing channel", async () => {
    const m1 = msg({ channel: "test/pub", body: "first" });
    const m2 = msg({ channel: "test/pub", body: "second" });
    await transport.publish(m1);
    await transport.publish(m2);

    const data = JSON.parse(
      fs.readFileSync(path.join(dir, "test_pub.json"), "utf-8"),
    );
    expect(data.messages).toHaveLength(2);
  });

  // ── read ──

  test("read returns empty for nonexistent channel", async () => {
    const msgs = await transport.read("nonexistent");
    expect(msgs).toEqual([]);
  });

  test("read tolerates a channel file with broken JSON", async () => {
    const file = path.join(dir, "test_broken.json");
    fs.writeFileSync(file, "{not valid json");
    const msgs = await transport.read("test/broken");
    expect(msgs).toEqual([]);
  });

  test("read tolerates a channel file with the wrong top-level shape", async () => {
    const file = path.join(dir, "test_shape.json");
    fs.writeFileSync(file, JSON.stringify({ unexpected: true }));
    const msgs = await transport.read("test/shape");
    expect(msgs).toEqual([]);
  });

  test("read drops malformed message entries but keeps valid ones", async () => {
    const good = msg({ channel: "test/mix", id: "good" });
    const file = path.join(dir, "test_mix.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        messages: [good, { id: "no-body" }, null, "nope"],
      }),
    );
    const msgs = await transport.read("test/mix");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("good");
  });

  test("publish onto a corrupted channel file replaces it without crashing", async () => {
    const file = path.join(dir, "test_recover.json");
    fs.writeFileSync(file, "{not valid json");
    // Should not throw
    await transport.publish(msg({ channel: "test/recover", id: "fresh" }));
    const msgs = await transport.read("test/recover");
    expect(msgs.map((m) => m.id)).toEqual(["fresh"]);
  });

  test("read returns all messages", async () => {
    const m1 = msg({ channel: "test/read", timestamp: 100 });
    const m2 = msg({ channel: "test/read", timestamp: 200 });
    await transport.publish(m1);
    await transport.publish(m2);

    const msgs = await transport.read("test/read");
    expect(msgs).toHaveLength(2);
  });

  test("read filters by unacked", async () => {
    const m1 = msg({ channel: "test/read", acked: true });
    const m2 = msg({ channel: "test/read", acked: false });
    await transport.publish(m1);
    await transport.publish(m2);

    const msgs = await transport.read("test/read", { unacked: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m2.id);
  });

  test("read filters by type", async () => {
    const m1 = msg({ channel: "test/read", type: "status" });
    const m2 = msg({ channel: "test/read", type: "review" });
    await transport.publish(m1);
    await transport.publish(m2);

    const msgs = await transport.read("test/read", { type: "review" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m2.id);
  });

  test("read filters by since", async () => {
    const m1 = msg({ channel: "test/read", timestamp: 100 });
    const m2 = msg({ channel: "test/read", timestamp: 300 });
    await transport.publish(m1);
    await transport.publish(m2);

    const msgs = await transport.read("test/read", { since: 200 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m2.id);
  });

  // ── ack ──

  test("ack specific message", async () => {
    const m1 = msg({ channel: "test/ack" });
    await transport.publish(m1);

    const result = await transport.ack("test/ack", m1.id);
    expect(result.ackedCount).toBe(1);

    // Verify persisted
    const msgs = await transport.read("test/ack", { unacked: true });
    expect(msgs).toHaveLength(0);
  });

  test("ack * marks all", async () => {
    await transport.publish(msg({ channel: "test/ack" }));
    await transport.publish(msg({ channel: "test/ack" }));

    const result = await transport.ack("test/ack", "*");
    expect(result.ackedCount).toBe(2);
  });

  test("ack last marks most recent unacked", async () => {
    const m1 = msg({ channel: "test/ack", id: "first" });
    const m2 = msg({ channel: "test/ack", id: "second" });
    await transport.publish(m1);
    await transport.publish(m2);

    const result = await transport.ack("test/ack", "last");
    expect(result.ackedCount).toBe(1);

    const unacked = await transport.read("test/ack", { unacked: true });
    expect(unacked).toHaveLength(1);
    expect(unacked[0].id).toBe("first");
  });

  test("ack returns 0 for nonexistent message", async () => {
    await transport.publish(msg({ channel: "test/ack" }));
    const result = await transport.ack("test/ack", "nonexistent");
    expect(result.ackedCount).toBe(0);
  });

  // ── subscribe ──

  test("subscribe delivers new messages via callback", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/sub", (msgs) => received.push(...msgs), {
      intervalMs: 50,
    });

    // Wait a tick, then publish
    await new Promise((r) => setTimeout(r, 20));
    await transport.publish(msg({ channel: "test/sub", body: "pushed" }));

    // Wait for poller to pick it up
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].body).toBe("pushed");
  });

  test("unsubscribe stops delivery", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/unsub", (msgs) => received.push(...msgs), {
      intervalMs: 50,
    });

    transport.unsubscribe("test/unsub");

    await transport.publish(msg({ channel: "test/unsub" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
  });

  test("unsubscribeAll stops all channels", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/a", (msgs) => received.push(...msgs), {
      intervalMs: 50,
    });
    transport.subscribe("test/b", (msgs) => received.push(...msgs), {
      intervalMs: 50,
    });

    transport.unsubscribeAll();

    await transport.publish(msg({ channel: "test/a" }));
    await transport.publish(msg({ channel: "test/b" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
  });

  // ── name ──

  test("name is 'file'", () => {
    expect(transport.name).toBe("file");
  });
});
