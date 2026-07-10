import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  installLauncher,
  launcherContents,
  launcherPath,
  uninstallLauncher,
} from "./relay-cli-installer";

const tempDirs: string[] = [];

function fixture(): { binDir: string; relayManagerPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-channel-cli-"));
  tempDirs.push(root);
  return {
    binDir: path.join(root, ".local", "bin"),
    relayManagerPath: path.join(root, "scripts", "relay-manager.ts"),
  };
}

afterEach(() => {
  while (tempDirs.length > 0)
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("relay CLI launcher", () => {
  test("installs an executable launcher for the package relay manager", () => {
    const options = fixture();
    const destination = installLauncher(options);

    expect(destination).toBe(launcherPath(options.binDir));
    expect(fs.readFileSync(destination, "utf8")).toBe(
      launcherContents(options.relayManagerPath),
    );
    expect(fs.statSync(destination).mode & 0o111).not.toBe(0);
  });

  test("is idempotent for its existing launcher", () => {
    const options = fixture();
    installLauncher(options);

    expect(installLauncher(options)).toBe(launcherPath(options.binDir));
  });

  test("refuses to replace another executable without force", () => {
    const options = fixture();
    fs.mkdirSync(options.binDir, { recursive: true });
    fs.writeFileSync(
      launcherPath(options.binDir),
      "#!/bin/sh\necho user launcher\n",
    );

    expect(() => installLauncher(options)).toThrow("already exists");
    expect(() => installLauncher({ ...options, force: true })).not.toThrow();
  });

  test("removes only its own launcher", () => {
    const options = fixture();
    installLauncher(options);

    expect(uninstallLauncher(options)).toBe(true);
    expect(fs.existsSync(launcherPath(options.binDir))).toBe(false);
    expect(uninstallLauncher(options)).toBe(false);
  });

  test("refuses to remove another launcher", () => {
    const options = fixture();
    fs.mkdirSync(options.binDir, { recursive: true });
    fs.writeFileSync(
      launcherPath(options.binDir),
      "#!/bin/sh\necho user launcher\n",
    );

    expect(() => uninstallLauncher(options)).toThrow("refusing to remove");
  });
});
