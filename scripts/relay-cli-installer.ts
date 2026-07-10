import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const launcherName = "pi-agent-channel-relay";
const managedMarker = "# pi-agent-channel relay CLI launcher";

export interface InstallOptions {
  binDir: string;
  relayManagerPath: string;
  force?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function launcherPath(binDir: string): string {
  return path.join(binDir, launcherName);
}

export function launcherContents(relayManagerPath: string): string {
  return `#!/bin/sh\n${managedMarker}\nexec bun ${shellQuote(relayManagerPath)} "$@"\n`;
}

export function installLauncher(options: InstallOptions): string {
  const destination = launcherPath(options.binDir);
  const contents = launcherContents(options.relayManagerPath);

  fs.mkdirSync(options.binDir, { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination, "utf8");
    if (existing === contents) return destination;
    if (!options.force) {
      throw new Error(
        `${destination} already exists and is not this package's launcher; rerun with --force to replace it`,
      );
    }
  }
  fs.writeFileSync(destination, contents, { mode: 0o755 });
  fs.chmodSync(destination, 0o755);
  return destination;
}

export function uninstallLauncher(
  options: Omit<InstallOptions, "force">,
): boolean {
  const destination = launcherPath(options.binDir);
  if (!fs.existsSync(destination)) return false;
  const existing = fs.readFileSync(destination, "utf8");
  if (existing !== launcherContents(options.relayManagerPath)) {
    throw new Error(
      `${destination} is not this package's launcher; refusing to remove it`,
    );
  }
  fs.unlinkSync(destination);
  return true;
}

function usage(command: "install" | "uninstall"): string {
  return command === "install"
    ? "Usage: bun run install-relay-cli [--force]"
    : "Usage: bun run uninstall-relay-cli";
}

function packagePaths(): Pick<InstallOptions, "binDir" | "relayManagerPath"> {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    binDir: path.join(os.homedir(), ".local", "bin"),
    relayManagerPath: path.join(scriptsDir, "relay-manager.ts"),
  };
}

export function runInstaller(args: string[]): number {
  const [command, ...rest] = args;
  if (command === "install") {
    if (rest.some((arg) => arg !== "--force")) {
      console.error(usage("install"));
      return 1;
    }
    try {
      const destination = installLauncher({
        ...packagePaths(),
        force: rest.includes("--force"),
      });
      console.log(`Installed ${destination}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === "uninstall") {
    if (rest.length > 0) {
      console.error(usage("uninstall"));
      return 1;
    }
    try {
      const removed = uninstallLauncher(packagePaths());
      console.log(
        removed
          ? "Removed relay CLI launcher"
          : "Relay CLI launcher is not installed",
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  console.error("Usage: relay-cli-installer.ts {install|uninstall} [--force]");
  return 1;
}

if (import.meta.main) process.exitCode = runInstaller(process.argv.slice(2));
