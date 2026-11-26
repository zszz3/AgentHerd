// The folder a data location change moves to (docs/specs/2026-11-22-data-directory-design.md,
// "Private target folder"). The owner picks a parent; the app creates `<parent>/AgentHerd` with
// owner-only access, because folders on a second drive usually inherit broad access.

import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import {
  isFsError,
  isMacLocalDisk,
  systemPowerShell,
  windowsCheckTimeoutMs,
  windowsPowerShellEnv,
} from "./location-gate.ts";
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
const toolTimeoutMs = windowsCheckTimeoutMs;
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
# TrustedInstaller owns the standard system volume root.
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Out-Result($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 3)); exit 0 }
switch ($env:AGENTHERD_TARGET_MODE) {
  'check' {
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { Out-Result @{ check = 'not-local' } }
    $chain = @()
    $item = Get-Item -LiteralPath $path -Force
    while ($null -ne $item) { $chain = @($item) + $chain; $item = $item.Parent }
    foreach ($item in $chain) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Out-Result @{ check = 'link' } }
      $security = Get-Acl -LiteralPath $item.FullName
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
      if ($null -eq $raw.DiscretionaryAcl -or $trusted -notcontains $raw.Owner.Value) { Out-Result @{ check = 'not-private' } }
      # DELETE_CHILD, WRITE_DAC, WRITE_OWNER, and GENERIC_ALL.
      $danger = 0x100C0040
      if ($null -ne $item.Parent) { $danger = $danger -bor 0x10000 } # DELETE (not a volume root)
      # A directory's data/attribute write rights can change reparse metadata on an empty
      # directory. Earlier components contain the next protected entry. FILE_ADD_SUBDIRECTORY
      # and read/traverse alone do not allow changing reparse metadata.
      if ($item.FullName -eq $chain[-1].FullName) { $danger = $danger -bor 0x40000102 }
      $denied = @{}
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) { Out-Result @{ check = 'not-private' } }
        # Inherit-only entries do not apply here. Existing descendants are checked below
        # in their own turn, and the newly created target has a protected DACL.
        if (([int]$ace.AceFlags -band 8) -ne 0) { continue }
        $sid = $ace.SecurityIdentifier.Value
        if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessDenied) {
          # Only an earlier Everyone or exact-SID deny proves a later allow cannot grant
          # those same bits. Do not infer group membership or expand generic rights.
          $denied[$sid] = [int]$denied[$sid] -bor ($ace.AccessMask -band 0x0FFFFFFF)
        } elseif ($trusted -notcontains $sid) {
          $blocked = [int]$denied['S-1-1-0'] -bor [int]$denied[$sid]
          if (($ace.AccessMask -band $danger -band (-bnot $blocked)) -ne 0) { Out-Result @{ check = 'not-private' } }
        }
      }
    }
    Out-Result @{ check = 'ok' }
  }
  'create' {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr Descriptor;
    public int InheritHandle;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  public static int Create(string path, byte[] descriptor) {
    var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject() };
      return CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
    } finally { pinned.Free(); }
  }
}
'@
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($user)
    foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        (New-Object System.Security.Principal.SecurityIdentifier $sid),
        'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    $code = [PrivateDirectory]::Create($path, $security.GetSecurityDescriptorBinaryForm())
    if ($code -eq 183 -or $code -eq 80) { Out-Result @{ exists = $true } }
    if ($code -ne 0) { throw "CreateDirectoryW failed ($code)" }
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
      windowsPowerShellEnv({ AGENTHERD_TARGET_MODE: mode, AGENTHERD_TARGET_PATH: path }),
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

function unsafeChain(): LocationTargetError {
  return new LocationTargetError(
    "not-private",
    "AgentHerd could not verify that other users cannot replace this folder path. Pick a protected folder.",
  );
}

async function checkMacChain(parent: string): Promise<void> {
  const root = parse(parent).root;
  const chain = [root];
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    chain.push(join(chain.at(-1) ?? root, part));
  }
  const mounts = await run("/sbin/mount", [], { ...process.env, LC_ALL: "C" });
  // Check each volume crossed by the path. A noowners mount can report the caller
  // as the owner regardless of the actual owner, so mode/ACL inspection is not enough.
  const devices = new Set<number>();
  for (const path of chain) {
    const stats = lstatSync(path);
    if (!devices.has(stats.dev)) {
      const df = await run("/bin/df", ["-P", "-Y", path], { ...process.env, LC_ALL: "C" });
      const device = /^(\/dev\/disk\d+(?:s\d+)*)\s+(?:apfs|hfs)\s/.exec(
        df.split("\n")[1] ?? "",
      )?.[1];
      const entries = device
        ? mounts.split("\n").filter((line) => line.startsWith(`${device} on `))
        : [];
      const options = / \((?:apfs|hfs)(, [^()]*)?\)$/.exec(entries[0] ?? "");
      if (entries.length !== 1 || !options || options[1]?.split(", ").includes("noowners"))
        throw unsafeChain();
      devices.add(stats.dev);
    }
    if (!stats.isDirectory() || (stats.uid !== 0 && stats.uid !== process.getuid?.()))
      throw unsafeChain();
    // All selected components have trusted owners. Sticky directories protect those
    // entries from other accounts, including when ordinary users can create siblings.
    const sticky = (stats.mode & 0o1000) !== 0;
    // An ACL may supply search permission even where the mode's search bit is off.
    if ((stats.mode & 0o022) !== 0 && !sticky) throw unsafeChain();
    const out = await run("/bin/ls", ["-blde", path], { ...process.env, LC_ALL: "C" });
    const [entry, ...rules] = out.trimEnd().split("\n");
    const header = /^d[\w-]{9}([@+])?\s/.exec(entry ?? "");
    if (!header || (header[1] === "+" && rules.length === 0)) throw unsafeChain();
    for (const [index, line] of rules.entries()) {
      const rule = /^\s*(\d+): (?:user|group):.+? (?:(?:inherited) )?(allow|deny) ([a-z_,]+)$/.exec(
        line,
      );
      if (!rule || Number(rule[1]) !== index) throw unsafeChain();
      const rights = (rule[3] ?? "").split(",");
      const safe = [
        "list",
        "search",
        "read",
        "execute",
        "add_file",
        "add_subdirectory",
        "readattr",
        "readextattr",
        "readsecurity",
        "file_inherit",
        "directory_inherit",
        "limit_inherit",
        "only_inherit",
        "synchronize",
      ];
      const alteration = [
        "delete",
        "delete_child",
        "writesecurity",
        "chown",
        "writeattr",
        "writeextattr",
        "write",
        "append",
      ];
      if (rights.some((right) => !safe.includes(right) && !alteration.includes(right)))
        throw unsafeChain();
      if (rule[2] === "allow" && rights.some((right) => alteration.includes(right)))
        throw unsafeChain();
    }
  }
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

/**
 * An absolute, existing folder on a supported local volume, reached without links, that other
 * users cannot replace or (for the folder itself) write to.
 */
async function checkFolderPath(parent: string): Promise<void> {
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
    // Validate both spellings if Windows resolves an alias (for example a DOS drive mapping).
    for (const spelling of new Set([parent, realpathSync.native(parent)])) {
      const result = await runWindows("check", spelling);
      if (isRecord(result) && result.check === "not-local") throw notLocal;
      if (isRecord(result) && result.check === "link") {
        throw new LocationTargetError("link", "The picked folder path contains a reparse point.");
      }
      if (isRecord(result) && result.check === "not-private") throw unsafeChain();
      if (!isRecord(result) || result.check !== "ok") {
        throw new LocationTargetError("invalid", "Windows gave an unexpected answer.");
      }
    }
  } else if (process.platform === "darwin") {
    if (!isMacLocalDisk(parent)) throw notLocal;
    await checkMacChain(parent);
  } else {
    throw notLocal;
  }
}

/** The host's sockets under `home` must fit macOS `sun_path`. */
function requireShortSockets(home: string): void {
  if (
    process.platform === "darwin" &&
    [socketPath(home), mcpSocketPath(home)].some(
      (p) => Buffer.byteLength(p, "utf8") > maxMacSocketBytes,
    )
  ) {
    throw new LocationTargetError("socket-path-too-long", "Pick a folder with a shorter path.");
  }
}

/** Validates the picked parent and returns `<parent>/AgentHerd` (not created). */
export async function checkTargetParent(
  parent: string,
  protectedPaths: readonly string[],
): Promise<string> {
  await checkFolderPath(parent);
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
  requireShortSockets(target);
  return target;
}

/**
 * Validates an existing AgentHerd directory picked for recovery with the same path checks as a
 * new parent. It is not checked for overlap or emptiness: it is meant to hold AgentHerd data.
 */
export async function checkExistingHome(home: string): Promise<void> {
  await checkFolderPath(home);
  requireShortSockets(home);
}

/** Creates `path` (must not exist) with owner-only access and reads it back. */
export async function createPrivateFolder(path: string): Promise<void> {
  const exists = new LocationTargetError("exists", `${path} already exists.`);
  if (process.platform === "win32") {
    const result = await runWindows("create", path);
    if (isRecord(result) && result.exists === true) throw exists;
    if (!isOwnerOnlyWindows(result)) {
      throw new LocationTargetError("not-private", "The new folder is not owner-only.");
    }
    requireEmptyNewFolder(path);
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
  requireEmptyNewFolder(path);
}

/**
 * A folder created a moment ago must still be empty once it is owner-only. On macOS, `mkdir`
 * applies the parent's inherited ACL entries until `chmod -N` runs, so another user could add
 * entries in that window; we cannot prove who created them, so the folder is left in place.
 */
export function requireEmptyNewFolder(path: string): void {
  if (readdirSync(path).length !== 0) {
    throw new LocationTargetError("not-private", "The new folder is not empty.");
  }
}

/** Reads back permissions of a folder this app created. */
export async function verifyPrivateFolder(path: string): Promise<void> {
  const ok =
    process.platform === "win32"
      ? isOwnerOnlyWindows(await runWindows("verify", path))
      : process.platform === "darwin" && (await verifyMac(path));
  if (!ok) throw new LocationTargetError("not-private", "The folder is not owner-only.");
}
