import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkTargetParent,
  createPrivateFolder,
  LocationTargetError,
  TARGET_NAME,
  verifyPrivateFolder,
} from "../src/location-target.ts";
import { mcpSocketPath } from "../src/mcp-socket.ts";
import { socketPath } from "../src/server.ts";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

let tmp: string;

beforeEach(() => {
  // The real path: macOS tmpdir() sits behind the /var link, which the check rejects.
  tmp = mkdtempSync(join(realpathSync.native(tmpdir()), "agentherd-target-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof LocationTargetError) return error.code;
    throw error;
  }
  return "ok";
}

/** The same path in another case; NTFS and default APFS treat both as one. */
function caseVariant(path: string): string {
  return path.toUpperCase();
}

/** Grants broad inheritable access on a folder this test created, like a second drive's root. */
function makeBroad(path: string): void {
  if (isWindows) {
    execFileSync("icacls", [path, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "ignore" });
  } else {
    execFileSync("/bin/chmod", [
      "+a",
      "everyone allow list,add_file,add_subdirectory,file_inherit,directory_inherit",
      path,
    ]);
  }
}

interface WindowsAcl {
  user: string;
  protected: boolean;
  rules: { sid: string; type: string; inherited: boolean }[];
}

function windowsAcl(path: string): WindowsAcl {
  const script = `
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $env:TEST_ACL_PATH
@{
  user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  protected = $acl.AreAccessRulesProtected
  rules = @(foreach ($r in $acl.GetAccessRules($true, $true, $sidType)) {
    @{ sid = $r.IdentityReference.Value; type = [string]$r.AccessControlType; inherited = $r.IsInherited }
  })
} | ConvertTo-Json -Compress -Depth 3`;
  const out = execFileSync(
    win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TEST_ACL_PATH: path },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return JSON.parse(out) as WindowsAcl;
}

function macAclLines(path: string): string[] {
  const out = execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8" });
  return out.split("\n").filter((line) => line !== "");
}

describe("checkTargetParent", () => {
  it("returns <parent>/AgentHerd without creating it", async () => {
    const target = await checkTargetParent(tmp, []);
    expect(TARGET_NAME).toBe("AgentHerd");
    expect(target).toBe(join(tmp, "AgentHerd"));
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("rejects a relative parent", async () => {
    expect(await codeOf(checkTargetParent("relative/parent", []))).toBe("invalid");
  });

  it("rejects a missing parent", async () => {
    expect(await codeOf(checkTargetParent(join(tmp, "missing"), []))).toBe("invalid");
  });

  it("rejects a parent that is a file", async () => {
    const file = join(tmp, "file");
    writeFileSync(file, "x");
    expect(await codeOf(checkTargetParent(file, []))).toBe("invalid");
  });

  it("rejects a symlink or junction in the parent path", async () => {
    const real = join(tmp, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link, isWindows ? "junction" : "dir");
    expect(await codeOf(checkTargetParent(link, []))).toBe("link");
    expect(await codeOf(checkTargetParent(join(link, "inner"), []))).toBe("link");
  });

  it("rejects an existing AgentHerd folder or file", async () => {
    mkdirSync(join(tmp, "AgentHerd"));
    expect(await codeOf(checkTargetParent(tmp, []))).toBe("exists");
    const other = join(tmp, "other");
    mkdirSync(other);
    writeFileSync(join(other, "AgentHerd"), "");
    expect(await codeOf(checkTargetParent(other, []))).toBe("exists");
  });

  it("rejects a target inside a protected root", async () => {
    const parent = join(tmp, "data", "nested");
    mkdirSync(parent, { recursive: true });
    const root = join(tmp, "data");
    expect(await codeOf(checkTargetParent(parent, [root]))).toBe("overlap");
    expect(await codeOf(checkTargetParent(parent, [join(parent, "AgentHerd")]))).toBe("overlap");
    if (isWindows || isMac) {
      expect(await codeOf(checkTargetParent(parent, [caseVariant(root)]))).toBe("overlap");
    }
  });

  it("rejects a protected root inside the target", async () => {
    const inside = join(tmp, "AgentHerd", "old");
    expect(await codeOf(checkTargetParent(tmp, [inside]))).toBe("overlap");
    if (isWindows || isMac) {
      expect(await codeOf(checkTargetParent(tmp, [caseVariant(inside)]))).toBe("overlap");
    }
  });

  it("accepts a sibling whose name only shares a prefix", async () => {
    const parent = join(tmp, "data");
    mkdirSync(parent);
    const target = await checkTargetParent(parent, [
      join(tmp, "data-old"),
      join(parent, "AgentHerd-old"),
    ]);
    expect(target).toBe(join(parent, "AgentHerd"));
  });

  it.runIf(isMac)("rejects a parent too long for macOS sockets", async () => {
    const parent = join(tmp, "p".repeat(80));
    mkdirSync(parent);
    const target = join(parent, "AgentHerd");
    expect(Buffer.byteLength(socketPath(target), "utf8")).toBeGreaterThan(103);
    expect(await codeOf(checkTargetParent(parent, []))).toBe("socket-path-too-long");

    const ok = join(tmp, "p".repeat(10));
    mkdirSync(ok);
    const okTarget = await checkTargetParent(ok, []);
    expect(Buffer.byteLength(socketPath(okTarget), "utf8")).toBeLessThanOrEqual(103);
    expect(Buffer.byteLength(mcpSocketPath(okTarget), "utf8")).toBeLessThanOrEqual(103);
  });
});

describe("createPrivateFolder", () => {
  it("creates an owner-only folder under a broadly accessible parent", async () => {
    const parent = join(tmp, "broad");
    mkdirSync(parent);
    makeBroad(parent);
    const target = await checkTargetParent(parent, []);

    await createPrivateFolder(target);
    await verifyPrivateFolder(target);
    const file = join(target, "secret.json");
    writeFileSync(file, "{}");

    if (isWindows) {
      const folder = windowsAcl(target);
      expect(folder.protected).toBe(true);
      const trusted = [folder.user, "S-1-5-18", "S-1-5-32-544"].sort();
      expect(folder.rules.map((r) => r.sid).sort()).toEqual(trusted);
      expect(folder.rules.every((r) => r.type === "Allow" && !r.inherited)).toBe(true);
      const inner = windowsAcl(file);
      expect([...new Set(inner.rules.map((r) => r.sid))].sort()).toEqual(trusted);
      expect(inner.rules.every((r) => r.inherited)).toBe(true);
    } else {
      const stats = lstatSync(target);
      expect(stats.mode & 0o7777).toBe(0o700);
      expect(stats.uid).toBe(process.getuid?.());
      expect(macAclLines(target)).toHaveLength(1);
      expect(macAclLines(file)).toHaveLength(1);
    }
  });

  it("refuses an existing folder and leaves its permissions alone", async () => {
    const parent = join(tmp, "broad");
    mkdirSync(parent);
    makeBroad(parent);
    const existing = join(parent, "AgentHerd");
    mkdirSync(existing);
    const before = isWindows ? windowsAcl(existing) : macAclLines(existing);

    expect(await codeOf(createPrivateFolder(existing))).toBe("exists");
    expect(isWindows ? windowsAcl(existing) : macAclLines(existing)).toEqual(before);
  });
});

describe("verifyPrivateFolder", () => {
  it("rejects a folder that inherited broad access", async () => {
    const parent = join(tmp, "broad");
    mkdirSync(parent);
    makeBroad(parent);
    const plain = join(parent, "plain");
    mkdirSync(plain, { mode: 0o700 });
    expect(await codeOf(verifyPrivateFolder(plain))).toBe("not-private");
  });
});
