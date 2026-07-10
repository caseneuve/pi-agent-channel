// ─── UdsTransport: push-based via Unix Domain Socket ────────────────────
// Connects to relay server. Uses Node.js net module — works in both
// Node and Bun runtimes. subscribe() receives pushed messages in
// real-time — no polling.
import * as net from "node:net";
import {
  isValidMessage,
  previewString,
  safeStringify,
  splitJsonFrames,
  type ChannelMessage,
  type FilterOpts,
} from "./core";
import type { MessageTransport, ParseErrorInfo } from "./interfaces";

/**
 * Safety cap on in-flight reassembly buffer size. A hostile / buggy relay
 * that sends `{` and never closes it would otherwise grow this unbounded.
 * 1 MiB is ~15× the largest real-world message we've ever seen.
 */
const MAX_BUFFER_BYTES = 1_000_000;

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

export class UdsTransport implements MessageTransport {
  readonly name = "uds";
  onParseError?: (info: ParseErrorInfo) => void;
  readonly socketPath: string;
  private socket: net.Socket | null = null;
  private connected: boolean = false;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private subscriptions: Map<string, (msgs: ChannelMessage[]) => void> =
    new Map();
  private reqCounter = 0;
  private buffer = "";

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private nextReqId(): string {
    return `r-${++this.reqCounter}-${Date.now()}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const transport = this;
      const sock = net.createConnection({ path: this.socketPath }, () => {
        transport.socket = sock;
        transport.connected = true;
        transport.connectPromise = null;
        // Re-subscribe all active subscriptions after reconnect
        for (const [channel] of transport.subscriptions) {
          sock.write(JSON.stringify({ action: "subscribe", channel }) + "\n");
        }
        resolve();
      });

      sock.setEncoding("utf-8");

      sock.on("data", (data: string) => {
        transport.buffer += data;

        // Guard against an unterminated frame growing the buffer unbounded.
        // If the buffer exceeds the cap and we're clearly mid-frame, drop it
        // and surface the incident so the agent knows we've lost context.
        if (transport.buffer.length > MAX_BUFFER_BYTES) {
          const dropped = previewString(transport.buffer);
          transport.buffer = "";
          console.error(
            `[uds-transport] buffer overflow (>${MAX_BUFFER_BYTES} bytes) — dropping reassembly buffer`,
          );
          transport.onParseError?.({
            transport: "uds",
            error: `buffer overflow (>${MAX_BUFFER_BYTES} bytes), dropping unterminated frame`,
            rawPreview: dropped,
          });
          return;
        }

        const { frames, remainder } = splitJsonFrames(transport.buffer);
        transport.buffer = remainder;

        for (const raw of frames) {
          let frame: unknown;
          try {
            frame = JSON.parse(raw);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[uds-transport] parse error: ${msg}`);
            transport.onParseError?.({
              transport: "uds",
              error: msg,
              rawPreview: previewString(raw),
            });
            continue;
          }
          transport.handleFrame(frame);
        }
      });

      sock.on("close", () => {
        transport.connected = false;
        transport.socket = null;
        transport.connectPromise = null;
        transport.buffer = "";
        for (const [, pending] of transport.pendingRequests) {
          pending.reject(new Error("Connection closed"));
        }
        transport.pendingRequests.clear();
      });

      sock.on("error", (err) => {
        transport.connected = false;
        transport.connectPromise = null;
        reject(err);
      });
    });

    return this.connectPromise;
  }

  private handleFrame(frame: unknown): void {
    if (frame == null || typeof frame !== "object") {
      const pv = previewString(safeStringify(frame));
      console.error(`[uds-transport] dropping non-object frame: ${pv}`);
      this.onParseError?.({
        transport: "uds",
        error: "non-object frame",
        rawPreview: pv,
      });
      return;
    }
    const f = frame as {
      type?: unknown;
      channel?: unknown;
      msg?: unknown;
      reqId?: unknown;
      data?: unknown;
    };

    if (f.type === "message") {
      if (typeof f.channel !== "string") {
        console.error("[uds-transport] dropping message frame with no channel");
        this.onParseError?.({
          transport: "uds",
          error: "message frame missing channel",
          rawPreview: previewString(safeStringify(f)),
        });
        return;
      }
      const cb = this.subscriptions.get(f.channel);
      if (!cb) return;
      if (!isValidMessage(f.msg)) {
        console.error(
          `[uds-transport] dropping malformed message frame on [${f.channel}]`,
        );
        this.onParseError?.({
          transport: "uds",
          error: "malformed ChannelMessage shape",
          rawPreview: previewString(safeStringify(f.msg)),
          channel: f.channel,
        });
        return;
      }
      cb([f.msg]);
    } else if (f.type === "response" && typeof f.reqId === "string") {
      const pending = this.pendingRequests.get(f.reqId);
      if (pending) {
        this.pendingRequests.delete(f.reqId);
        pending.resolve(f.data);
      }
    }
  }

  private send(obj: any): void {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(JSON.stringify(obj) + "\n");
  }

  private async request(obj: any): Promise<any> {
    await this.ensureConnected();
    const reqId = this.nextReqId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve, reject });
      this.send({ ...obj, reqId });
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error(`Request ${reqId} timed out`));
        }
      }, 5000);
    });
  }

  async publish(msg: ChannelMessage): Promise<void> {
    await this.ensureConnected();
    this.send({ action: "publish", channel: msg.channel, msg });
  }

  async read(channel: string, opts?: FilterOpts): Promise<ChannelMessage[]> {
    const data = await this.request({ action: "read", channel, opts });
    if (!Array.isArray(data)) {
      const shape = data === null ? "null" : typeof data;
      console.error(
        `[uds-transport] read [${channel}]: expected array, got ${shape}`,
      );
      this.onParseError?.({
        transport: "uds",
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
        `[uds-transport] read [${channel}]: dropped ${dropped} malformed message(s)`,
      );
    }
    return valid;
  }

  async ack(
    channel: string,
    messageId: string,
  ): Promise<{ ackedCount: number }> {
    const data = await this.request({ action: "ack", channel, messageId });
    if (
      data == null ||
      typeof data !== "object" ||
      typeof (data as { ackedCount?: unknown }).ackedCount !== "number"
    ) {
      throw new Error(
        `ack failed: unexpected response shape: ${previewString(safeStringify(data))}`,
      );
    }
    return data as { ackedCount: number };
  }

  subscribe(channel: string, callback: (msgs: ChannelMessage[]) => void): void {
    this.subscriptions.set(channel, callback);
    this.ensureConnected().then(() => {
      this.send({ action: "subscribe", channel });
    });
  }

  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    if (this.connected) {
      try {
        this.send({ action: "unsubscribe", channel });
      } catch {
        /* connection may be gone */
      }
    }
  }

  unsubscribeAll(): void {
    for (const [ch] of this.subscriptions) {
      this.unsubscribe(ch);
    }
  }
}
