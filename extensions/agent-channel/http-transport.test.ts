import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { RelayServer } from "../../relay/server";
import { HttpTransport } from "./http-transport";
import type { ChannelMessage } from "./core";

function tmpSocket(): string {
  return path.join(
    os.tmpdir(),
    `http-transport-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`,
  );
}

let testPort = 19200 + Math.floor(Math.random() * 1000);
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

describe("HttpTransport", () => {
  let server: RelayServer;
  let transport: HttpTransport;
  let baseUrl: string;

  beforeEach(() => {
    const port = nextPort();
    server = new RelayServer({
      socketPath: tmpSocket(),
      httpPort: port,
      httpHost: "127.0.0.1",
    });
    server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    transport = new HttpTransport(baseUrl);
  });

  afterEach(() => {
    transport.unsubscribeAll();
    server.stop();
  });

  // ── publish + read ──

  test("publish then read returns message", async () => {
    const m = msg({ channel: "test/rw" });
    await transport.publish(m);

    const msgs = await transport.read("test/rw");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m.id);
    expect(msgs[0].body).toBe("hello");
  });

  test("read with filters", async () => {
    await transport.publish(msg({ channel: "test/f", type: "status" }));
    await transport.publish(msg({ channel: "test/f", type: "review" }));

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

    const result = await transport.ack("test/ack", m.id);
    expect(result.ackedCount).toBe(1);

    const unacked = await transport.read("test/ack", { unacked: true });
    expect(unacked).toHaveLength(0);
  });

  test("ack * marks all", async () => {
    await transport.publish(msg({ channel: "test/ack-all" }));
    await transport.publish(msg({ channel: "test/ack-all" }));

    const result = await transport.ack("test/ack-all", "*");
    expect(result.ackedCount).toBe(2);
  });

  // ── subscribe (SSE push delivery) ──

  test("subscribe receives pushed messages", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/push", (msgs) => received.push(...msgs));

    // Wait for SSE connection to establish
    await new Promise((r) => setTimeout(r, 200));

    // Publish via a second transport (simulates another agent)
    const t2 = new HttpTransport(baseUrl);
    await t2.publish(msg({ channel: "test/push", body: "from-t2" }));

    // Wait for push delivery
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].body).toBe("from-t2");

    t2.unsubscribeAll();
  });

  test("unsubscribe stops delivery", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/unsub", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 100));

    transport.unsubscribe("test/unsub");
    await new Promise((r) => setTimeout(r, 100));

    const t2 = new HttpTransport(baseUrl);
    await t2.publish(msg({ channel: "test/unsub" }));
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(0);
    t2.unsubscribeAll();
  });

  // ── cross-transport: UDS publish → HTTP/SSE receive ──

  test("message published via UDS is received via SSE", async () => {
    const received: ChannelMessage[] = [];
    transport.subscribe("test/cross", (msgs) => received.push(...msgs));
    await new Promise((r) => setTimeout(r, 200));

    // Publish via UDS (raw socket)
    const net = await import("node:net");
    const m = msg({ channel: "test/cross", body: "from-uds" });
    await new Promise<void>((resolve) => {
      const sock = net.createConnection({ path: server.socketPath }, () => {
        sock.write(
          JSON.stringify({
            action: "publish",
            channel: "test/cross",
            msg: m,
          }) + "\n",
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 100);
      });
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].body).toBe("from-uds");
  });

  // ── name ──

  test("name is 'http'", () => {
    expect(transport.name).toBe("http");
  });
});
