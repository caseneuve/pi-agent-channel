import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { RelayServer } from "./server";
import type { ChannelMessage } from "./store";

function tmpSocket(): string {
  return path.join(os.tmpdir(), `relay-http-test-${Date.now()}.sock`);
}

let portCounter = 17700 + Math.floor(Math.random() * 1000);
function nextPort(): number {
  return portCounter++;
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

/** Helper: subscribe to SSE and collect the first pushed message. */
function sseSubscribe(
  baseUrl: string,
  channel: string,
): { promise: Promise<any>; abort: () => void } {
  let req: http.ClientRequest;
  const promise = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSE timeout")), 3000);
    req = http.get(`${baseUrl}/channels/${channel}/stream`, (res) => {
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        clearTimeout(timeout);
        const jsonStr = chunk.replace(/^data:\s*/, "").trim();
        try {
          resolve(JSON.parse(jsonStr));
        } catch {
          resolve(chunk);
        }
        req.destroy();
      });
    });
    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  return { promise, abort: () => req?.destroy() };
}

describe("HTTP/SSE relay", () => {
  let server: RelayServer;
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
  });

  afterEach(() => {
    server.stop();
  });

  // ── publish + read ──

  test("POST publish then GET read returns message", async () => {
    const m = msg({ channel: "test/rw" });
    const pubRes = await fetch(`${baseUrl}/channels/test/rw/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    });
    expect(pubRes.ok).toBe(true);
    const pubData = await pubRes.json();
    expect(pubData.ok).toBe(true);

    const readRes = await fetch(`${baseUrl}/channels/test/rw/messages`);
    const msgs = await readRes.json();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m.id);
  });

  test("GET read with query filters", async () => {
    await fetch(`${baseUrl}/channels/test/f/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg({ channel: "test/f", type: "status" })),
    });
    await fetch(`${baseUrl}/channels/test/f/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg({ channel: "test/f", type: "review" })),
    });

    const res = await fetch(`${baseUrl}/channels/test/f/messages?type=review`);
    const msgs = await res.json();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("review");
  });

  test("GET read empty channel", async () => {
    const res = await fetch(`${baseUrl}/channels/nope/messages`);
    const msgs = await res.json();
    expect(msgs).toEqual([]);
  });

  // ── ack ──

  test("PATCH ack marks message", async () => {
    const m = msg({ channel: "test/ack" });
    await fetch(`${baseUrl}/channels/test/ack/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    });

    const ackRes = await fetch(
      `${baseUrl}/channels/test/ack/messages/${m.id}`,
      { method: "PATCH" },
    );
    const result = await ackRes.json();
    expect(result.ackedCount).toBe(1);

    const readRes = await fetch(
      `${baseUrl}/channels/test/ack/messages?unacked=true`,
    );
    const msgs = await readRes.json();
    expect(msgs).toHaveLength(0);
  });

  // ── list ──

  test("GET /channels lists all channels", async () => {
    await fetch(`${baseUrl}/channels/ch-a/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg({ channel: "ch-a" })),
    });
    await fetch(`${baseUrl}/channels/ch-b/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg({ channel: "ch-b" })),
    });

    const res = await fetch(`${baseUrl}/channels`);
    const list = await res.json();
    expect(list).toHaveLength(2);
    expect(list.map((c: any) => c.name).sort()).toEqual(["ch-a", "ch-b"]);
  });

  // ── SSE subscription ──

  test("SSE stream receives pushed messages", async () => {
    const { promise, abort } = sseSubscribe(baseUrl, "test/sse");

    // Wait for SSE to connect
    await new Promise((r) => setTimeout(r, 100));

    // Publish
    await fetch(`${baseUrl}/channels/test/sse/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg({ channel: "test/sse", body: "pushed!" })),
    });

    const frame = await promise;
    expect(frame.type).toBe("message");
    expect(frame.msg.body).toBe("pushed!");
    abort();
  });

  // ── cross-transport: UDS publish → SSE receive ──

  test("message published via UDS is pushed to SSE subscribers", async () => {
    const { promise, abort } = sseSubscribe(baseUrl, "test/cross");

    await new Promise((r) => setTimeout(r, 100));

    // Publish via UDS
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
        }, 50);
      });
    });

    const frame = await promise;
    expect(frame.type).toBe("message");
    expect(frame.msg.body).toBe("from-uds");
    abort();
  });

  // ── 404 ──

  test("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
