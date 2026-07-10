// ─── HttpTransport: REST + SSE for cross-machine communication ──────────
// Publish/read/ack via fetch(). Subscribe via SSE using node:http
// (Bun's fetch doesn't stream incrementally). Works in both Node and Bun.
import * as http from "node:http";
import {
  isValidMessage,
  previewString,
  safeStringify,
  type ChannelMessage,
  type FilterOpts,
} from "./core";
import type { MessageTransport, ParseErrorInfo } from "./interfaces";

function normalizeRelayUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    // 0.0.0.0 is a bind-address for servers, not a client destination.
    if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

export class HttpTransport implements MessageTransport {
  readonly name = "http";
  onParseError?: (info: ParseErrorInfo) => void;
  readonly baseUrl: string;
  private sseConnections: Map<
    string,
    { req: http.ClientRequest; callback: (msgs: ChannelMessage[]) => void }
  > = new Map();

  constructor(baseUrl: string) {
    this.baseUrl = normalizeRelayUrl(baseUrl);
  }

  private channelUrl(channel: string): string {
    // Channel slashes become URL path segments — don't encode them
    const encoded = channel
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `${this.baseUrl}/channels/${encoded}`;
  }

  async publish(msg: ChannelMessage): Promise<void> {
    const res = await fetch(`${this.channelUrl(msg.channel)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      throw new Error(`publish failed: ${res.status} ${await res.text()}`);
    }
  }

  async read(channel: string, opts?: FilterOpts): Promise<ChannelMessage[]> {
    const params = new URLSearchParams();
    if (opts?.since) params.set("since", String(opts.since));
    if (opts?.unacked) params.set("unacked", "true");
    if (opts?.type) params.set("type", opts.type);
    const query = params.toString();
    const url = `${this.channelUrl(channel)}/messages${query ? `?${query}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`read failed: ${res.status} ${await res.text()}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onParseError?.({
        transport: "http",
        error: `invalid JSON from server on read`,
        rawPreview: msg,
        channel,
      });
      throw new Error(`read failed: invalid JSON from server: ${msg}`);
    }
    if (!Array.isArray(data)) {
      const shape = data === null ? "null" : typeof data;
      console.error(
        `[http-transport] read [${channel}]: expected array, got ${shape}`,
      );
      this.onParseError?.({
        transport: "http",
        error: `read response not an array (got ${shape})`,
        rawPreview: previewString(safeStringify(data)),
        channel,
      });
      return [];
    }
    const valid: ChannelMessage[] = [];
    let dropped = 0;
    for (const entry of data) {
      if (isValidMessage(entry)) valid.push(entry);
      else dropped++;
    }
    if (dropped > 0) {
      console.error(
        `[http-transport] read [${channel}]: dropped ${dropped} malformed message(s)`,
      );
    }
    return valid;
  }

  async ack(
    channel: string,
    messageId: string,
  ): Promise<{ ackedCount: number }> {
    const res = await fetch(
      `${this.channelUrl(channel)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH" },
    );
    if (!res.ok) {
      throw new Error(`ack failed: ${res.status} ${await res.text()}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new Error(
        `ack failed: invalid JSON from server: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (
      body == null ||
      typeof body !== "object" ||
      typeof (body as { ackedCount?: unknown }).ackedCount !== "number"
    ) {
      throw new Error(
        `ack failed: unexpected response shape: ${previewString(safeStringify(body))}`,
      );
    }
    return body as { ackedCount: number };
  }

  subscribe(channel: string, callback: (msgs: ChannelMessage[]) => void): void {
    // Clean up existing subscription
    this.unsubscribe(channel);

    const url = `${this.channelUrl(channel)}/stream`;
    let buffer = "";

    const reconnect = () => {
      // Only reconnect if still subscribed (not manually unsubscribed)
      if (!this.sseConnections.has(channel)) return;
      setTimeout(() => {
        this.subscribe(channel, callback);
      }, 2000);
    };

    const req = http.get(url, (res) => {
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        // SSE format: "data: <json>\n\n"
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          // Strip "data: " prefix
          const jsonStr = trimmed.replace(/^data:\s*/, "");
          try {
            const frame = JSON.parse(jsonStr);
            if (frame && frame.type === "message") {
              if (isValidMessage(frame.msg)) {
                callback([frame.msg]);
              } else {
                console.error(
                  `[http-transport] dropping malformed SSE message on [${channel}]`,
                );
                this.onParseError?.({
                  transport: "http",
                  error: "malformed ChannelMessage shape (SSE)",
                  rawPreview: previewString(safeStringify(frame.msg)),
                  channel,
                });
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[http-transport] SSE parse error on [${channel}]: ${msg}`,
            );
            this.onParseError?.({
              transport: "http",
              error: msg,
              rawPreview: previewString(jsonStr),
              channel,
            });
          }
        }
      });
      res.on("end", reconnect);
    });

    req.on("error", (err) => {
      console.error(
        `[http-transport] SSE error on [${channel}]: ${err.message}`,
      );
      reconnect();
    });

    this.sseConnections.set(channel, { req, callback });
  }

  unsubscribe(channel: string): void {
    const conn = this.sseConnections.get(channel);
    if (conn) {
      conn.req.destroy();
      this.sseConnections.delete(channel);
    }
  }

  unsubscribeAll(): void {
    for (const [ch] of this.sseConnections) {
      this.unsubscribe(ch);
    }
  }
}
