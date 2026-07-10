// ─── StatusDisplay implementations ──────────────────────────────────────
import { execFileSync } from "node:child_process";
import type { StatusDisplay } from "./interfaces";

// ─── Helpers ──────────────────────────────────────────────────────────
export function execArgs(args: string[]): string {
  try {
    return execFileSync(args[0], args.slice(1), {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch (err) {
    console.error(
      `[agent-channel] exec failed: ${args.join(" ")}: ${err instanceof Error ? err.message : err}`,
    );
    return "";
  }
}

// ─── CmuxDisplay ────────────────────────────────────────────────────────
export class CmuxDisplay implements StatusDisplay {
  readonly name = "cmux";

  async setStatus(key: string, value: string, icon?: string): Promise<void> {
    const args = ["cmux", "set-status", key, value];
    if (icon) args.push("--icon", icon);
    execArgs(args);
  }

  async setProgress(fraction: number, label: string): Promise<void> {
    execArgs(["cmux", "set-progress", String(fraction), "--label", label]);
  }

  async clearProgress(): Promise<void> {
    execArgs(["cmux", "clear-progress"]);
  }

  async log(message: string, level?: string, source?: string): Promise<void> {
    const args = ["cmux", "log"];
    if (level) args.push("--level", level);
    if (source) args.push("--source", source);
    args.push("--", message);
    execArgs(args);
  }

  async notify(title: string, body: string): Promise<void> {
    execArgs(["cmux", "notify", "--title", title, "--body", body]);
  }
}

// ─── TmuxDisplay ────────────────────────────────────────────────────────

type TmuxNotifyMode = "tmux" | "notify-send" | "auto";

function hasNotifySend(): boolean {
  try {
    execFileSync("which", ["notify-send"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export class TmuxDisplay implements StatusDisplay {
  readonly name = "tmux";
  private notifyMode: TmuxNotifyMode;
  private useNotifySend: boolean;
  private paneId: string;

  constructor(notifyMode: TmuxNotifyMode = "auto") {
    this.notifyMode = notifyMode;
    this.useNotifySend =
      notifyMode === "notify-send" ||
      (notifyMode === "auto" && hasNotifySend());
    this.paneId =
      process.env.TMUX_PANE ||
      execArgs(["tmux", "display-message", "-p", "#{pane_id}"]) ||
      "";
  }

  private setOpt(opt: string, value: string): void {
    execArgs(["tmux", "set-option", "-p", "-t", this.paneId, opt, value]);
  }

  private unsetOpt(opt: string): void {
    execArgs(["tmux", "set-option", "-pu", "-t", this.paneId, opt]);
  }

  /** Configure tmux pane border for agent status. Called when comms turn ON. */
  setup(): void {
    this.setOpt("pane-border-status", "top");
    this.setOpt(
      "pane-border-format",
      " #{@agent-agent}#{?@agent-progress, [#{@agent-progress}],} ",
    );
  }

  /** Restore tmux pane border. Called when comms turn OFF or session shuts down. */
  teardown(): void {
    this.unsetOpt("@agent-agent");
    this.unsetOpt("@agent-progress");
    this.unsetOpt("pane-border-status");
    this.unsetOpt("pane-border-format");
  }

  async setStatus(key: string, value: string, icon?: string): Promise<void> {
    const display = icon ? `${icon} ${value}` : value;
    this.setOpt(`@agent-${key}`, display);
  }

  async setProgress(fraction: number, label: string): Promise<void> {
    const filled = Math.round(fraction * 10);
    const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
    const pct = `${Math.round(fraction * 100)}%`;
    const display = `${bar} ${pct}${label ? " " + label : ""}`;
    this.setOpt("@agent-progress", display);
    if (this.useNotifySend) {
      execArgs([
        "notify-send",
        "-h",
        `int:value:${Math.round(fraction * 100)}`,
        "-h",
        "string:x-dunst-stack-tag:agent-progress",
        "Agent Progress",
        `${label || "working"} ${pct}`,
      ]);
    }
  }

  async clearProgress(): Promise<void> {
    this.unsetOpt("@agent-progress");
  }

  private displayMessage(text: string, durationMs: number): void {
    const width = parseInt(
      execArgs([
        "tmux",
        "display-message",
        "-t",
        this.paneId,
        "-p",
        "#{client_width}",
      ]) || "0",
      10,
    );
    const pad =
      width > text.length
        ? " ".repeat(Math.floor((width - text.length) / 2))
        : "";
    execArgs([
      "tmux",
      "display-message",
      "-t",
      this.paneId,
      "-d",
      String(durationMs),
      `${pad}${text}`,
    ]);
  }

  async log(message: string, level?: string, _source?: string): Promise<void> {
    if (level && level !== "info") {
      this.displayMessage(`[${level}] ${message}`, 3000);
    }
  }

  async notify(title: string, body: string): Promise<void> {
    if (this.useNotifySend) {
      execArgs([
        "notify-send",
        "-h",
        "string:x-dunst-stack-tag:agent-notify",
        title,
        body,
      ]);
    } else {
      this.displayMessage(`📡 ${title}: ${body}`, 5000);
    }
  }
}

// ─── NoopDisplay ────────────────────────────────────────────────────────
export class NoopDisplay implements StatusDisplay {
  readonly name = "noop";

  async setStatus(_key: string, _value: string): Promise<void> {
    /* no-op */
  }
  async setProgress(_fraction: number, _label: string): Promise<void> {
    /* no-op */
  }
  async clearProgress(): Promise<void> {
    /* no-op */
  }
  async log(_message: string): Promise<void> {
    /* no-op */
  }
  async notify(title: string, body: string): Promise<void> {
    if (process.platform === "darwin") {
      execArgs([
        "osascript",
        "-e",
        `display notification "${body}" with title "${title}"`,
      ]);
    } else {
      try {
        execArgs(["notify-send", title, body]);
      } catch {
        /* no notification backend available */
      }
    }
  }
}

// ─── Factories ──────────────────────────────────────────────────────────

function hasCmux(): boolean {
  try {
    execFileSync("cmux", ["ping"], { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function hasTmux(): boolean {
  return !!process.env.TMUX;
}

export function createDisplay(): StatusDisplay {
  if (process.env.CMUX_SOCKET_PATH || hasCmux()) {
    return new CmuxDisplay();
  }
  if (hasTmux()) {
    const notifyMode =
      (process.env.AGENT_NOTIFY_MODE as TmuxNotifyMode) || "auto";
    return new TmuxDisplay(notifyMode);
  }
  return new NoopDisplay();
}
