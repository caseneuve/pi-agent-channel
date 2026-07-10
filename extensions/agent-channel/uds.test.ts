import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { RelayServer } from "../../relay/server";
import { UdsTransport, createTransport, FileTransport } from "./transports";
import type { ChannelMessage } from "./core";
import type { ParseErrorInfo } from "./interfaces";

function tmpSocket(): string {
  return path.join(
    os.tmpdir(),
    `agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`,
  );
}

let testPort = 18800 + Math.floor(Math.random() * 1000);
function nextPort(): number {
  return testPort++;
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

describe("UdsTransport + RelayServer", () => {
  let socketPath: string;
  let server: RelayServer;
  let transport: UdsTransport;

  beforeEach(() => {
    socketPath = tmpSocket();
    server = new RelayServer({
      socketPath,
      httpPort: nextPort(),
      httpHost: "127.0.0.1",
    });
    server.start();
    transport = new UdsTransport(socketPath);
  });

  afterEach(() => {
    transport.unsubscribeAll();
    server.stop();
  });

  // ── publish + read ──

  test("publish then read returns message", async () => {
    const m = msg({ channel: "test/rw" });
    await transport.publish(m);

    // Small delay for server to process
    await new Promise((r) => setTimeout(r, 50));

    const msgs = await transport.read("test/rw");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m.id);
    expect(msgs[0].body).toBe("hello");
  });

  test("read with filters", async () => {
    await transport.publish(msg({ channel: "test/f", type: "status" }));
    await transport.publish(msg({ channel: "test/f", type: "review" }));
    await new Promise((r) => setTimeout(r, 50));

    const msgs = await transport.read("test/f", { type: "review" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("review");
  });

  test("read empty channel", async () => {
    const msgs = await transport.read("nonexistent");
    expect(msgs).toEqual([]);
  });

  // ── ack ──

  test("ack marks message", async () => {
    const m = msg({ channel: "test/ack" });
    await transport.publish(m);
    await new Promise((r) => setTimeout(r, 50));

    const result = await transport.ack("test/ack", m.id);
    expect(result.ackedCount).toBe(1);

    const unacked = await transport.read("test/ack", { unacked: true });
    expect(unacked).toHaveLength(0);
  });

  // ── subscribe (push delivery) ──

  test("subscribe receives pushed messages", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/push", (msgs) => received.push(...msgs));

    // Wait for subscription to register
    await new Promise((r) => setTimeout(r, 100));

    // Publish via a second transport (simulates another agent)
    const t2 = new UdsTransport(socketPath);
    await t2.publish(msg({ channel: "test/push", body: "from-t2" }));

    // Wait for push delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].body).toBe("from-t2");

    t2.unsubscribeAll();
  });

  test("unsubscribe stops delivery", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/unsub", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 50));

    transport.unsubscribe("test/unsub");
    await new Promise((r) => setTimeout(r, 50));

    // Publish after unsubscribe — should not arrive
    const t2 = new UdsTransport(socketPath);
    await t2.publish(msg({ channel: "test/unsub" }));
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(0);
    t2.unsubscribeAll();
  });

  // ── name ──

  test("name is 'uds'", () => {
    expect(transport.name).toBe("uds");
  });

  // ── self-skip in fan-out ──

  test("publisher does not receive its own message via subscription", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/self", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 100));

    // Publish on the same transport that is subscribed
    await transport.publish(msg({ channel: "test/self", body: "self-msg" }));
    await new Promise((r) => setTimeout(r, 100));

    // Should NOT receive own message
    expect(received).toHaveLength(0);
  });

  // ── reconnect + re-subscribe ──

  test("re-subscribes after relay restart", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/recon", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 100));

    // Restart the relay (simulates crash + recovery)
    server.stop();
    await new Promise((r) => setTimeout(r, 100));
    server = new RelayServer({
      socketPath,
      httpPort: nextPort(),
      httpHost: "127.0.0.1",
    });
    server.start();

    // Give transport time to notice disconnect + reconnect on next operation
    await new Promise((r) => setTimeout(r, 100));

    // Publish from a second transport — should arrive via re-subscription
    const t2 = new UdsTransport(socketPath);
    await t2.publish(msg({ channel: "test/recon", body: "after-restart" }));
    await new Promise((r) => setTimeout(r, 200));

    // The first transport needs to reconnect — trigger via a read
    try {
      await transport.read("test/recon");
    } catch {
      // Connection may fail first time
    }
    await new Promise((r) => setTimeout(r, 100));

    // Now publish again — subscription should be re-registered
    await t2.publish(msg({ channel: "test/recon", body: "after-reconnect" }));
    await new Promise((r) => setTimeout(r, 200));

    const afterReconnect = received.filter((m) => m.body === "after-reconnect");
    expect(afterReconnect.length).toBeGreaterThanOrEqual(1);

    t2.unsubscribeAll();
  });
});

// ── Stale socket / createTransport fallback ────────────────────────────

describe("createTransport", () => {
  test("returns FileTransport when no socket exists", async () => {
    const prev = process.env.AGENT_UDS_SOCKET;
    process.env.AGENT_UDS_SOCKET = "/tmp/nonexistent-test.sock";
    try {
      const t = await createTransport();
      expect(t.name).toBe("file");
      expect(t).toBeInstanceOf(FileTransport);
    } finally {
      if (prev !== undefined) process.env.AGENT_UDS_SOCKET = prev;
      else delete process.env.AGENT_UDS_SOCKET;
    }
  });

  test("returns FileTransport when socket file exists but relay is down", async () => {
    // Create a stale socket file (not a real socket)
    const stalePath = path.join(os.tmpdir(), `stale-test-${Date.now()}.sock`);
    fs.writeFileSync(stalePath, "");
    const prev = process.env.AGENT_UDS_SOCKET;
    process.env.AGENT_UDS_SOCKET = stalePath;
    try {
      const t = await createTransport();
      expect(t.name).toBe("file");
    } finally {
      if (prev !== undefined) process.env.AGENT_UDS_SOCKET = prev;
      else delete process.env.AGENT_UDS_SOCKET;
      fs.unlinkSync(stalePath);
    }
  });

  test("returns UdsTransport when relay is running", async () => {
    const sockPath = path.join(os.tmpdir(), `probe-test-${Date.now()}.sock`);
    const srv = new RelayServer({
      socketPath: sockPath,
      httpPort: nextPort(),
      httpHost: "127.0.0.1",
    });
    srv.start();
    const prev = process.env.AGENT_UDS_SOCKET;
    process.env.AGENT_UDS_SOCKET = sockPath;
    try {
      const t = await createTransport();
      expect(t.name).toBe("uds");
      expect(t).toBeInstanceOf(UdsTransport);
      t.unsubscribeAll();
    } finally {
      if (prev !== undefined) process.env.AGENT_UDS_SOCKET = prev;
      else delete process.env.AGENT_UDS_SOCKET;
      srv.stop();
    }
  });
});

// ─── Framing / parse error surfacing ────────────────────────────────────
//
// Exercise UdsTransport against a *minimal* fake relay that lets us inject
// specific byte sequences: truncated JSON, glued frames without a newline,
// and malformed ChannelMessage payloads. The real relay never produces these
// but we've seen them reach the client in the wild (see position-811 report).

interface FakeRelayHandle {
  socketPath: string;
  send: (bytes: string) => void;
  close: () => Promise<void>;
}

async function startFakeRelay(): Promise<FakeRelayHandle> {
  const socketPath = tmpSocket();
  let client: net.Socket | null = null;
  const server = net.createServer((c) => {
    client = c;
    c.setEncoding("utf-8");
    // Drain subscribe/publish requests but don't interpret them.
    c.on("data", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    send: (bytes: string) => {
      if (!client) throw new Error("no client connected yet");
      client.write(bytes);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (client) client.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("UdsTransport framing + onParseError", () => {
  let relay: FakeRelayHandle;
  let transport: UdsTransport;
  const errors: ParseErrorInfo[] = [];

  beforeEach(async () => {
    relay = await startFakeRelay();
    transport = new UdsTransport(relay.socketPath);
    errors.length = 0;
    transport.onParseError = (info) => {
      errors.push(info);
    };
    // Force connection so relay.send has a client to write to.
    transport.subscribe("test/framing", () => {});
    // Wait for the socket to actually connect.
    await new Promise((r) => setTimeout(r, 40));
  });

  afterEach(async () => {
    transport.unsubscribeAll();
    await relay.close();
    try {
      fs.unlinkSync(relay.socketPath);
    } catch {
      /* may already be gone */
    }
  });

  test("balanced-but-invalid JSON surfaces a parse error to onParseError", async () => {
    // Brace-balanced so splitJsonFrames yields it as a complete frame,
    // but `bar` is not a valid JSON value so JSON.parse rejects it.
    relay.send('{"type":"message","channel":"test/framing","msg":bar}\n');
    await new Promise((r) => setTimeout(r, 40));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].transport).toBe("uds");
    expect(errors[0].error).toMatch(/JSON|Expected|Unexpected/i);
    expect(errors[0].rawPreview.length).toBeLessThanOrEqual(501);
  });

  test("truncated frames are buffered, not dropped", async () => {
    // An unbalanced frame must stay in the buffer until more data arrives.
    relay.send('{"type":"message","channel":"test/framing","msg":');
    await new Promise((r) => setTimeout(r, 40));
    expect(errors).toEqual([]);
  });

  test("glued frames without a separator are both parsed", async () => {
    const delivered: ChannelMessage[] = [];
    transport.unsubscribeAll();
    transport.subscribe("test/framing", (ms) => delivered.push(...ms));
    // Give the new subscribe time to round-trip to the fake relay.
    await new Promise((r) => setTimeout(r, 40));

    const m1 = msg({ channel: "test/framing", id: "a", body: "one" });
    const m2 = msg({ channel: "test/framing", id: "b", body: "two" });
    const f1 = JSON.stringify({
      type: "message",
      channel: "test/framing",
      msg: m1,
    });
    const f2 = JSON.stringify({
      type: "message",
      channel: "test/framing",
      msg: m2,
    });
    relay.send(f1 + f2); // no newline / separator
    await new Promise((r) => setTimeout(r, 60));

    expect(delivered.map((m) => m.id)).toEqual(["a", "b"]);
    // No parse errors should have been produced for this case.
    expect(errors).toEqual([]);
  });

  test("malformed ChannelMessage inside a well-formed frame is reported", async () => {
    const delivered: ChannelMessage[] = [];
    transport.unsubscribeAll();
    transport.subscribe("test/framing", (ms) => delivered.push(...ms));
    await new Promise((r) => setTimeout(r, 40));

    // Frame parses as JSON but msg is missing required fields.
    const frame = JSON.stringify({
      type: "message",
      channel: "test/framing",
      msg: { id: "only-id" },
    });
    relay.send(frame + "\n");
    await new Promise((r) => setTimeout(r, 40));

    expect(delivered).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].transport).toBe("uds");
    expect(errors[0].error).toMatch(/malformed/i);
    expect(errors[0].channel).toBe("test/framing");
  });

  test("array-shaped frame does not dispatch and does not raise", async () => {
    // Arrays are `typeof === 'object'` so they pass the null-guard in
    // handleFrame; but they have no `type` field so nothing happens.
    const delivered: ChannelMessage[] = [];
    transport.unsubscribeAll();
    transport.subscribe("test/framing", (ms) => delivered.push(...ms));
    await new Promise((r) => setTimeout(r, 40));

    relay.send("[1,2,3]\n");
    await new Promise((r) => setTimeout(r, 40));

    expect(delivered).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ─── Large-payload regression (todo 0020) ──────────────────────────────────
//
// Prior to commit [this one], the relay's UDS fan-out used
// `Bun.Socket.write(str)` which returns bytes-actually-written and
// silently dropped the tail past macOS `net.local.stream.sendspace`
// (8192 on default macOS). A `review-response` larger than that boundary
// arrived truncated at the subscriber and failed JSON.parse around
// position 8127 — exactly the symptom in todos/0020.
//
// Switching the relay to `node:net` gave us Node's auto-buffering write
// semantics, which the client side has used all along. This test pins
// the fix: two real UDS subscribers, a 16 KiB payload with multi-byte
// UTF-8, byte-exact round-trip assertion.

describe("UdsTransport + RelayServer: kB-scale payload round-trip (todo 0020)", () => {
  let socketPath: string;
  let server: RelayServer;
  let sender: UdsTransport;
  let receiver: UdsTransport;

  beforeEach(() => {
    socketPath = tmpSocket();
    server = new RelayServer({
      socketPath,
      httpPort: nextPort(),
      httpHost: "127.0.0.1",
    });
    server.start();
    sender = new UdsTransport(socketPath);
    receiver = new UdsTransport(socketPath);
  });

  afterEach(() => {
    sender.unsubscribeAll();
    receiver.unsubscribeAll();
    server.stop();
  });

  test("delivers a 16 KiB multi-byte UTF-8 body byte-exact", async () => {
    // Build a body well past the 8192 sendspace boundary that also
    // contains multi-byte UTF-8 (em dash, curly quotes, backticks) so a
    // naive string.slice-by-UTF-16-code-units fix would also fail this.
    const chunk =
      "Reviewed 32038e3. **Approve with one follow-up.** Answering your questions. " +
      "The `\u2018 em dash\u2014` scenario, \u201cquoted strings\u201d, and other multi-byte " +
      "characters such as \u2192 \u2194 \u2605 must survive intact. ";
    let body = "";
    while (body.length < 16 * 1024) body += chunk;
    // Cap to exactly 16 KiB-ish; trim mid-character if needed, then add
    // one terminator char known to be single-byte so the cap point is
    // deterministic.
    body = body.slice(0, 16 * 1024) + ".";
    expect(body.length).toBeGreaterThan(16 * 1024);

    const received: ChannelMessage[] = [];
    receiver.subscribe("test/0020", (msgs) => received.push(...msgs));

    // Let the subscribe round-trip to the relay.
    await new Promise((r) => setTimeout(r, 60));

    const sent = msg({ channel: "test/0020", body });
    await sender.publish(sent);

    // Give fan-out + receiver assembly a moment. The bug triggered in
    // single-digit ms so 150ms is generous.
    await new Promise((r) => setTimeout(r, 150));

    expect(received.length).toBe(1);
    expect(received[0].id).toBe(sent.id);
    // Byte-exact body preservation — the whole point. String equality
    // suffices because both sides encode in UTF-16 in JS memory; the
    // corruption would manifest as length mismatch / character loss.
    expect(received[0].body.length).toBe(body.length);
    expect(received[0].body).toBe(body);
  });

  test("delivers a 64 KiB payload byte-exact (stress)", async () => {
    const filler = "x\u2014y"; // 3 JS chars, 5 UTF-8 bytes (em dash is 3)
    let body = "";
    while (body.length < 64 * 1024) body += filler;
    body = body.slice(0, 64 * 1024);

    const received: ChannelMessage[] = [];
    receiver.subscribe("test/0020-big", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 60));

    const sent = msg({ channel: "test/0020-big", body });
    await sender.publish(sent);
    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(1);
    expect(received[0].body.length).toBe(body.length);
    expect(received[0].body).toBe(body);
  });
});
