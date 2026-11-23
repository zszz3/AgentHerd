// The folder a data location change moves to (docs/specs/2026-11-22-data-directory-design.md,
// "Private target folder"). The owner picks a parent; the app creates `<parent>/AgentHerd` with
// owner-only access, because folders on a second drive usually inherit broad access.

import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { isFsError, isMacLocalDisk, systemPowerShell } from "./location-gate.ts";
import { mcpSocketPath } from "./mcp-socket.ts";
import { socketPath } from "./server.ts";

export const TARGET_NAME = "AgentHerd";

export type LocationTargetCode =
  | "not-local"
  | "link"
  | "exists"
  | "overlap"
  | "socket-path-too-long"
  | "not-private"
  | "invalid";

export class LocationTargetError extends Error {
  readonly code: LocationTargetCode;

  constructor(code: LocationTargetCode, message: string) {
    super(message);
    this.name = "LocationTargetError";
    this.code = code;
  }
}

/** macOS `sun_path` holds 104 bytes including the terminating NUL. */
const maxMacSocketBytes = 103;
const toolTimeoutMs = 10_000;
const maxToolOutput = 64 * 1024;
/** FileSystemRights.FullControl. */
const fullControl = 2032127;
/** InheritanceFlags ContainerInherit | ObjectInherit. */
const inheritAll = 3;
const windowsTrusted = ["S-1-5-18", "S-1-5-32-544"];

// Embedded, not a shipped .ps1: Electron main bundles this module into one file, so a script next
// to the source would be missing at run time. Paths go in as environment data, never as code.
const windowsScript = `
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$path = $env:AGENTHERD_TARGET_PATH
function Out-Result($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 3)); exit 0 }
switch ($env:AGENTHERD_TARGET_MODE) {
  'check' {
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { Out-Result @{ check = 'not-local' } }
    $item = Get-Item -LiteralPath $path -Force
    while ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Out-Result @{ check = 'link' } }
      $item = $item.Parent
    }
    Out-Result @{ check = 'ok' }
  }
  'create' {
    if (Test-Path -LiteralPath $path) { Out-Result @{ exists = $true } }
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($user)
    foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        (New-Object System.Security.Principal.SecurityIdentifier $sid),
        'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    [void][IO.Directory]::CreateDirectory($path, $security)
  }
  'verify' { }
  default { exit 2 }
}
$item = Get-Item -LiteralPath $path -Force
$acl = Get-Acl -LiteralPath $path
Out-Result @{
  user = $user.Value
  owner = $acl.GetOwner($sidType).Value
  protected = $acl.AreAccessRulesProtected
  directory = $item.PSIsContainer
  reparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  rules = @(foreach ($r in $acl.GetAccessRules($true, $true, $sidType)) {
    @{
      sid = $r.IdentityReference.Value
      type = [string]$r.AccessControlType
      rights = [int]$r.FileSystemRights
      inheritance = [int]$r.InheritanceFlags
      propagation = [int]$r.PropagationFlags
      inherited = $r.IsInherited
    }
  })
}
`;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        env,
        timeout: toolTimeoutMs,
        maxBuffer: maxToolOutput,
        windowsHide: true,
      },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
    child.stdin?.end();
  });
}

async function runWindows(mode: "check" | "create" | "verify", path: string): Promise<unknown> {
  const powershell = systemPowerShell();
  if (!powershell) {
    throw new LocationTargetError("invalid", "Windows system tools are unavailable.");
  }
  let out: string;
  try {
    out = await run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsScript, "utf16le").toString("base64"),
      ],
      { ...process.env, AGENTHERD_TARGET_MODE: mode, AGENTHERD_TARGET_PATH: path },
    );
    return JSON.parse(out) as unknown;
  } catch {
    throw new LocationTargetError("invalid", "Windows could not check the folder.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnerOnlyWindows(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.rules)) return false;
  const { user, owner, rules } = value;
  if (typeof user !== "string" || !user.startsWith("S-1-")) return false;
  if (owner !== user || value.protected !== true || value.directory !== true) return false;
  if (value.reparse !== false || rules.length !== 3) return false;
  const sids = rules.map((rule) =>
    isRecord(rule) &&
    rule.type === "Allow" &&
    rule.rights === fullControl &&
    rule.inheritance === inheritAll &&
    rule.propagation === 0 &&
    rule.inherited === false
      ? rule.sid
      : undefined,
  );
  const expected = [user, ...windowsTrusted].sort();
  return JSON.stringify([...sids].sort()) === JSON.stringify(expected);
}

async function verifyMac(path: string): Promise<boolean> {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o7777) !== 0o700) {
    return false;
  }
  // `-e` lists ACL entries on the lines after the entry itself.
  const out = await run("/bin/ls", ["-lde", path], { ...process.env, LC_ALL: "C" });
  const lines = out.split("\n").filter((line) => line !== "");
  return lines.length === 1 && /^drwx------@?\s/.test(lines[0] ?? "");
}

/** Case rules of the supported platforms: NTFS and default APFS ignore case. */
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

function within(root: string, path: string): boolean {
  const r = fold(root);
  const p = fold(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

function canonical(path: string): string[] {
  const resolved = resolve(path);
  try {
    return [resolved, realpathSync.native(resolved)];
  } catch (error) {
    if (isFsError(error, "ENOENT")) return [resolved];
    throw error;
  }
}

/** Validates the picked parent and returns `<parent>/AgentHerd` (not created). */
export async function checkTargetParent(
  parent: string,
  protectedPaths: readonly string[],
): Promise<string> {
  if (!isAbsolute(parent) || normalize(parent) !== parent) {
    throw new LocationTargetError("invalid", "Pick an absolute folder path.");
  }
  const { root } = parse(parent);
  if (process.platform === "win32" && !/^[a-z]:\\$/i.test(root)) {
    throw new LocationTargetError("not-local", "Pick a folder on a local drive.");
  }
  let current = root;
  for (const part of parent
    .slice(root.length)
    .split(sep)
    .filter((p) => p !== "")) {
    current = join(current, part);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats) throw new LocationTargetError("invalid", "The picked folder does not exist.");
    if (stats.isSymbolicLink()) {
      throw new LocationTargetError("link", "The picked folder path contains a link.");
    }
    if (!stats.isDirectory()) {
      throw new LocationTargetError("invalid", "The picked path is not a folder.");
    }
  }
  if (current === root) throw new LocationTargetError("invalid", "Pick a folder, not a drive.");

  const notLocal = new LocationTargetError(
    "not-local",
    "Pick a folder on a local NTFS drive (Windows) or APFS/HFS+ disk (macOS).",
  );
  if (process.platform === "win32") {
    const result = await runWindows("check", parent);
    if (isRecord(result) && result.check === "not-local") throw notLocal;
    if (isRecord(result) && result.check === "link") {
      throw new LocationTargetError("link", "The picked folder path contains a reparse point.");
    }
    if (!isRecord(result) || result.check !== "ok") {
      throw new LocationTargetError("invalid", "Windows gave an unexpected answer.");
    }
  } else if (process.platform === "darwin") {
    if (!isMacLocalDisk(parent)) throw notLocal;
  } else {
    throw notLocal;
  }

  const target = join(parent, TARGET_NAME);
  const targets = [target, join(realpathSync.native(parent), TARGET_NAME)];
  for (const path of protectedPaths) {
    for (const p of canonical(path)) {
      if (targets.some((t) => within(p, t) || within(t, p))) {
        throw new LocationTargetError("overlap", "The new folder overlaps AgentHerd data.");
      }
    }
  }
  if (lstatSync(target, { throwIfNoEntry: false })) {
    throw new LocationTargetError("exists", `${TARGET_NAME} already exists in the picked folder.`);
  }
  if (
    process.platform === "darwin" &&
    [socketPath(target), mcpSocketPath(target)].some(
      (p) => Buffer.byteLength(p, "utf8") > maxMacSocketBytes,
    )
  ) {
    throw new LocationTargetError("socket-path-too-long", "Pick a folder with a shorter path.");
  }
  return target;
}

/** Creates `path` (must not exist) with owner-only access and reads it back. */
export async function createPrivateFolder(path: string): Promise<void> {
  const exists = new LocationTargetError("exists", `${path} already exists.`);
  if (lstatSync(path, { throwIfNoEntry: false })) throw exists;
  if (process.platform === "win32") {
    const result = await runWindows("create", path);
    if (isRecord(result) && result.exists === true) throw exists;
    if (!isOwnerOnlyWindows(result)) {
      throw new LocationTargetError("not-private", "The new folder is not owner-only.");
    }
    return;
  }
  if (process.platform !== "darwin") {
    throw new LocationTargetError("not-local", "Only Windows and macOS can create the folder.");
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (isFsError(error, "EEXIST")) throw exists;
    throw error;
  }
  // Drop ACL entries inherited from the parent, only on the folder this call just created.
  await run("/bin/chmod", ["-N", path], process.env);
  await verifyPrivateFolder(path);
}

/** Reads back permissions of a folder this app created. */
export async function verifyPrivateFolder(path: string): Promise<void> {
  const ok =
    process.platform === "win32"
      ? isOwnerOnlyWindows(await runWindows("verify", path))
      : process.platform === "darwin" && (await verifyMac(path));
  if (!ok) throw new LocationTargetError("not-private", "The folder is not owner-only.");
}
