import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  checkExistingHome,
  checkTargetParent,
  createPrivateFolder,
  LocationTargetError,
  requireEmptyNewFolder,
  TARGET_NAME,
  verifyPrivateFolder,
} from "../src/location-target.ts";
import { systemPowerShell, windowsPowerShellEnv } from "../src/location-gate.ts";
import { mcpSocketPath } from "../src/mcp-socket.ts";
import { socketPath } from "../src/server.ts";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

let tmp: string;

beforeEach(async () => {
  if (isWindows) {
    tmp = join(
      win32.parse(process.env.SystemRoot ?? "C:\\Windows").root,
      `ah-target-${randomUUID()}`,
    );
    await createPrivateFolder(tmp);
  } else {
    // macOS tmpdir() sits behind the /var link, which the check rejects. Its real path is
    // already long, so keep the name short: the target's sockets must fit in `sun_path`.
    tmp = mkdtempSync(join(realpathSync.native(tmpdir()), "ah-"));
  }
}, 20_000);

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
    execFileSync("icacls", [path, "/grant", "*S-1-5-11:(OI)(CI)(RX,AD)"], { stdio: "ignore" });
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
    systemPowerShell() ?? "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: windowsPowerShellEnv({ TEST_ACL_PATH: path }),
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
    // Size the parent's name so the longer socket is exactly at the 103-byte limit, then one over.
    const limit = 103;
    const bytes = (name: string) =>
      Math.max(
        ...[socketPath, mcpSocketPath].map((path) =>
          Buffer.byteLength(path(join(tmp, name, TARGET_NAME)), "utf8"),
        ),
      );
    // A name of n bytes adds n plus its separator to the path without it.
    const fits = "p".repeat(limit - bytes("") - 1);
    expect(fits.length).toBeGreaterThan(0);
    expect(bytes(fits)).toBe(limit);

    const ok = join(tmp, fits);
    mkdirSync(ok);
    expect(await checkTargetParent(ok, [])).toBe(join(ok, TARGET_NAME));

    const parent = join(tmp, `${fits}p`);
    mkdirSync(parent);
    expect(bytes(`${fits}p`)).toBe(limit + 1);
    expect(await codeOf(checkTargetParent(parent, []))).toBe("socket-path-too-long");
  });
});

describe("checkExistingHome", () => {
  it("accepts a private folder on a local disk", async () => {
    const home = join(tmp, "home");
    mkdirSync(home, { mode: 0o700 });
    await expect(checkExistingHome(home)).resolves.toBeUndefined();
  });

  it("rejects a relative or missing folder", async () => {
    expect(await codeOf(checkExistingHome("relative/home"))).toBe("invalid");
    expect(await codeOf(checkExistingHome(join(tmp, "missing")))).toBe("invalid");
  });

  it("rejects a symlink or junction in the folder path", async () => {
    const real = join(tmp, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link, isWindows ? "junction" : "dir");
    expect(await codeOf(checkExistingHome(link))).toBe("link");
    expect(await codeOf(checkExistingHome(join(link, "inner")))).toBe("link");
  });

  it.runIf(isMac)("rejects a folder too long for macOS sockets", async () => {
    const home = join(tmp, "h".repeat(90));
    mkdirSync(home, { mode: 0o700 });
    expect(await codeOf(checkExistingHome(home))).toBe("socket-path-too-long");
  });
});

describe("target path permissions", () => {
  it.runIf(isWindows)(
    "accepts an exact-principal deny before the corresponding allow",
    async () => {
      const parent = join(tmp, "ordered");
      mkdirSync(parent);
      execFileSync("icacls", [parent, "/grant", "*S-1-5-11:(DC)"], { stdio: "ignore" });
      // Use a different group for the deny, then set the ordered DACL with the native API:
      // icacls /deny would remove the matching Allow bits and not exercise access ordering.
      const script = `
$ErrorActionPreference = 'Stop'
$path = $env:TEST_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'DeleteSubdirectoriesAndFiles', 'Deny'))
Set-Acl -LiteralPath $path -AclObject $acl`;
      execFileSync(
        systemPowerShell() ?? "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: windowsPowerShellEnv({ TEST_ACL_PATH: parent }),
          stdio: "ignore",
        },
      );
      const before = windowsAcl(parent);
      expect(
        before.rules.filter((rule) => rule.sid === "S-1-5-11").map((rule) => rule.type),
      ).toEqual(["Deny", "Allow"]);
      expect(await codeOf(checkTargetParent(parent, []))).toBe("ok");
      expect(windowsAcl(parent)).toEqual(before);
    },
    20_000,
  );
  it("rejects replacement authority on an ancestor without changing its permissions", async () => {
    const ancestor = join(tmp, "ancestor");
    const parent = join(ancestor, "nested");
    mkdirSync(parent, { recursive: true });
    if (isWindows) {
      execFileSync("icacls", [ancestor, "/grant", "*S-1-5-11:(DC)"], { stdio: "ignore" });
    } else {
      execFileSync("/bin/chmod", ["+a", "everyone allow delete_child", ancestor]);
    }
    const before = isWindows ? windowsAcl(ancestor) : macAclLines(ancestor);
    expect(await codeOf(checkTargetParent(parent, []))).toBe("not-private");
    expect(isWindows ? windowsAcl(ancestor) : macAclLines(ancestor)).toEqual(before);
    expect(lstatSync(join(parent, TARGET_NAME), { throwIfNoEntry: false })).toBeUndefined();
  }, 20_000);
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
  }, 20_000);
});

describe("requireEmptyNewFolder", () => {
  // createPrivateFolder calls this after the readback. A real mkdir-to-`chmod -N` race cannot
  // be forced in a test, so the check is tested on its own.
  it("refuses a new folder that already has entries and keeps them", () => {
    const folder = join(tmp, "AgentHerd");
    mkdirSync(join(folder, "run"), { recursive: true });
    writeFileSync(join(folder, "secrets.json"), "{}");
    let code = "ok";
    try {
      requireEmptyNewFolder(folder);
    } catch (error) {
      if (!(error instanceof LocationTargetError)) throw error;
      code = error.code;
    }
    expect(code).toBe("not-private");
    expect(lstatSync(join(folder, "secrets.json")).isFile()).toBe(true);
    expect(lstatSync(join(folder, "run")).isDirectory()).toBe(true);
  });

  it("accepts an empty folder", () => {
    const folder = join(tmp, "AgentHerd");
    mkdirSync(folder);
    expect(() => requireEmptyNewFolder(folder)).not.toThrow();
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
