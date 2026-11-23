import { execFileSync } from "node:child_process";
import {
  type BigIntStats,
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { isAbsolute, join, normalize, parse, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LocationMode = "shared" | "exclusive";

export interface LocationLease {
  readonly mode: LocationMode;
  release(): void;
}

export const gateFile = ".agentherd-location.lock.sqlite";
/** Exclusive leases that are not released yet, so a writer can prove it holds one. */
const liveExclusive = new WeakSet<LocationLease>();

export function isLiveExclusiveLease(lease: LocationLease): boolean {
  return liveExclusive.has(lease);
}
const createSentinel = "CREATE TABLE location_gate (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)";

function gateFailure(reason: string): Error {
  return new Error(`Cannot use the AgentHerd location gate: ${reason}`);
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function asLocationGateError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.startsWith("Cannot use the AgentHerd location gate:")
  ) {
    return error;
  }
  if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") {
    const primary = error.errcode & 0xff; // SQLite encodes extended results above the low byte.
    if (primary === 5 || primary === 6) {
      return new Error(
        "The AgentHerd data location is in use. Close other AgentHerd processes and retry.",
      );
    }
    return gateFailure(
      `SQLite rejected the gate (result ${error.errcode}). Check the gate and profile permissions before retrying.`,
    );
  }
  return gateFailure("check that your local user profile and its gate are accessible, then retry.");
}

function checkUnixAccess(stats: BigIntStats, directory: boolean): void {
  const uid = process.getuid?.();
  const forbidden = directory ? 0o022n : 0o077n;
  if (uid === undefined || stats.uid !== BigInt(uid) || (stats.mode & forbidden) !== 0n) {
    throw gateFailure(
      "use a profile owned by you, with no group or other write access and a private gate file.",
    );
  }
}

function checkMacAcl(path: string, isRollbackJournal = false): boolean {
  let acl: string;
  try {
    acl = execFileSync("/bin/ls", ["-blde", path], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch (error) {
    // Initialization can commit and unlink just the rollback journal between
    // lstat and ls. A missing executable, timeout or other ACL error is fatal.
    if (
      isRollbackJournal &&
      error instanceof Error &&
      !("code" in error) &&
      "status" in error &&
      error.status === 1 &&
      "signal" in error &&
      error.signal === null &&
      "stderr" in error &&
      error.stderr === `ls: ${path}: No such file or directory\n` &&
      lstatSync(path, { throwIfNoEntry: false }) === undefined
    ) {
      return false;
    }
    throw error;
  }
  // macOS home folders can carry this default deny-only ACE. No allow ACE is
  // needed for the gate; on macOS an allow ACE can grant access past mode bits.
  if (
    acl
      .split("\n")
      .slice(1)
      .some((line) => line !== "" && !/^\s*\d+: group:everyone deny delete\s*$/.test(line))
  ) {
    throw gateFailure("check your profile and gate for unexpected access control entries.");
  }
  return true;
}

// Inspect metadata only. Node's mode on Windows does not report NTFS permissions.
// Use a fixed system executable and pass literal paths as data, not PowerShell code.
const windowsProfileCheck = `
$ErrorActionPreference = 'Stop'
$paths = $env:AGENTHERD_GATE_PATHS | ConvertFrom-Json
$sidType = [System.Security.Principal.SecurityIdentifier]
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($paths[0]))
if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { exit 2 }
foreach ($path in $paths) {
  try {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
    $acl = Get-Acl -LiteralPath $path
  } catch [System.Management.Automation.ItemNotFoundException] {
    # SQLite can delete its rollback journal as initialization completes.
    if (!$path.EndsWith('.sqlite-journal') -or $path -eq $paths[0]) { exit 2 }
    continue
  }
  if ($acl.GetOwner($sidType).Value -ne $sid -or !$acl.AreAccessRulesCanonical) { exit 2 }
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { exit 2 }
  foreach ($ace in $acl.GetAccessRules($true, $true, $sidType)) {
    if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Value -in $trusted) { continue }
    if ($ace.IdentityReference.Value -eq 'S-1-3-0' -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    # Stock profiles may grant traversal alone to an AppContainer, without inheritance.
    if ($item.PSIsContainer -and $ace.InheritanceFlags -eq 'None' -and $ace.PropagationFlags -eq 'None' -and
        (([int]$ace.FileSystemRights -band (-bnot 1048608)) -eq 0)) { continue }
    exit 2
  }
}
`;

function checkWindowsProfile(root: string, paths: string[]): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw gateFailure("Windows system tools are unavailable; check your Windows installation.");
  }
  try {
    execFileSync(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsProfileCheck, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, AGENTHERD_GATE_PATHS: JSON.stringify([root, ...paths]) },
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      },
    );
  } catch {
    throw gateFailure(
      "use a protected user profile on a local fixed NTFS volume. Check the profile and gate ACLs.",
    );
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function checkProfile(root: string): void {
  if (!isAbsolute(root) || !samePath(realpathSync.native(root), root)) {
    throw gateFailure("use a real, absolute user profile path, not a link or an alias.");
  }
  const stats = lstatSync(root, { bigint: true });
  if (!stats.isDirectory() || root === parse(root).root) {
    throw gateFailure("the user profile must be a real directory, not a volume root.");
  }
  switch (process.platform) {
    case "win32": {
      const drive = parse(root).root;
      if (!/^[a-z]:\\$/i.test(drive) || lstatSync(drive, { bigint: true }).dev !== stats.dev) {
        throw gateFailure("use a local fixed NTFS profile, not a network or mounted path.");
      }
      break;
    }
    case "darwin": {
      checkUnixAccess(stats, true);
      checkMacAcl(root);
      // Require a local disk of a supported type, not just a writable mount.
      const fs = execFileSync("/bin/df", ["-P", "-Y", root], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C" },
      });
      if (!/^\/dev\/disk\d+(?:s\d+)*\s+(?:apfs|hfs)\s/.test(fs.split("\n")[1] ?? "")) {
        throw gateFailure("use a local APFS or HFS+ user profile.");
      }
      break;
    }
    case "linux": {
      checkUnixAccess(stats, true);
      // Linux statfs magic values for local filesystems with POSIX byte-range locks.
      const supported = [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1];
      if (!supported.includes(statfsSync(root).type >>> 0)) {
        throw gateFailure("use a supported local Linux filesystem for your user profile.");
      }
      break;
    }
    default:
      throw gateFailure("this platform cannot verify user profile locking.");
  }
}

function checkGateFile(path: string, isRollbackJournal = false): BigIntStats | undefined {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (isFsError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw gateFailure("the gate and its journal must be regular files without links.");
  }
  if (process.platform !== "win32") checkUnixAccess(stats, false);
  if (process.platform === "darwin" && !checkMacAcl(path, isRollbackJournal)) return undefined;
  return stats;
}

const createPosixGate = `
const { closeSync, openSync } = require("node:fs");
let fd;
try {
  fd = openSync(process.argv[1], "wx", 0o600);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
if (fd !== undefined) closeSync(fd);
`;

function createGateFile(path: string): void {
  if (process.platform === "win32") {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (isFsError(error, "EEXIST")) return;
      throw error;
    }
    closeSync(fd);
    return;
  }
  // A worker in this PID can acquire SQLite's POSIX locks as soon as the
  // inode exists. Its locks must not be dropped by the creator's close().
  execFileSync(process.execPath, ["-e", createPosixGate, "--", path], {
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    stdio: "ignore",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}

function prepareGatePath(root: string): { path: string; identity: BigIntStats } {
  checkProfile(root);
  const path = join(root, gateFile);
  const journal = `${path}-journal`;
  // Reject WAL sidecars before SQLite has a chance to open them.
  if (checkGateFile(`${path}-wal`) || checkGateFile(`${path}-shm`)) {
    throw gateFailure("the gate must use a DELETE rollback journal, not WAL.");
  }
  const existing = checkGateFile(path);
  const journalExists = checkGateFile(journal, true);
  if (process.platform === "win32") {
    checkWindowsProfile(root, [...(existing ? [path] : []), ...(journalExists ? [journal] : [])]);
  }
  if (!existing) createGateFile(path);
  const identity = existing ?? checkGateFile(path);
  if (!identity || identity.dev !== lstatSync(root, { bigint: true }).dev) {
    throw gateFailure("the gate must be on the same volume as the user profile.");
  }
  if (!existing && process.platform === "win32") checkWindowsProfile(root, [path]);
  return { path, identity };
}

// This check is always inside the transaction that acquired the SQLite read lock.
function hasSentinel(db: DatabaseSync): boolean {
  if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
    throw gateFailure("the gate must use a DELETE rollback journal, not WAL.");
  }
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema LIMIT 2").all();
  if (version === 0 && schema.length === 0) return false;
  const table = schema[0];
  if (
    version === 1 &&
    schema.length === 1 &&
    table?.type === "table" &&
    table.name === "location_gate" &&
    table.sql === createSentinel
  ) {
    const rows = db.prepare("SELECT id, v FROM location_gate LIMIT 2").all();
    if (rows.length === 1 && rows[0]?.id === 1 && rows[0].v === 1) return true;
  }
  throw gateFailure(
    "the gate has an incompatible sentinel. Stop AgentHerd and inspect the gate before retrying.",
  );
}

function ensureRollbackGate(db: DatabaseSync, mode: LocationMode): void {
  const begin = mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN";
  db.exec(begin);
  if (hasSentinel(db)) return;

  db.exec("ROLLBACK");
  db.exec("BEGIN EXCLUSIVE");
  if (!hasSentinel(db)) {
    db.exec(
      `${createSentinel}; INSERT INTO location_gate (id, v) VALUES (1, 1); PRAGMA user_version = 1`,
    );
  }
  db.exec("COMMIT");

  db.exec(begin);
  if (!hasSentinel(db))
    throw gateFailure("the initialized sentinel disappeared; check the gate before retrying.");
}

/** Acquire before resolving the data location; release only after all leased work ends. */
export function acquireLocationLease(root: string, mode: LocationMode): LocationLease {
  let db: DatabaseSync | undefined;
  try {
    if (!samePath(normalize(root), root)) {
      throw gateFailure("use a canonical user profile path without relative segments.");
    }
    const { path, identity } = prepareGatePath(root);
    const connection = new DatabaseSync(path);
    db = connection;
    connection.exec("PRAGMA busy_timeout = 0; PRAGMA trusted_schema = OFF");
    ensureRollbackGate(connection, mode);
    const after = lstatSync(path, { bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      after.dev !== identity.dev ||
      after.ino !== identity.ino
    ) {
      throw gateFailure("the gate file changed identity; check the user profile before retrying.");
    }
    let released = false;
    const lease: LocationLease = {
      mode,
      release() {
        if (released) return;
        released = true;
        liveExclusive.delete(lease);
        try {
          connection.exec("ROLLBACK");
        } finally {
          connection.close();
        }
      },
    };
    if (mode === "exclusive") liveExclusive.add(lease);
    return lease;
  } catch (error) {
    db?.close();
    throw asLocationGateError(error);
  }
}
