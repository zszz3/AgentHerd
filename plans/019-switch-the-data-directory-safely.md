## Data Directory Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: load the `subagent-driven-development` skill (recommended) or the `executing-plans` skill with the `skill` tool to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Windows and macOS owners move AgentHerd data to `<picked parent>/AgentHerd`, empty or copied, and have desktop and CLI use the same selection after a restart.

**Architecture:** The non-Electron host package owns the per-user location record, the request file, the admission gate, private folder creation and the copy. A change is a request applied at the next desktop startup under the exclusive gate, before any host starts. Electron main owns the picker, the request and the relaunch; the renderer only sees state and sanitized result codes. The record is committed last; the source is never removed.

**Tech Stack:** Node.js ≥22.18 (`node:sqlite`, `node:fs`, `node:child_process`), TypeScript, Electron 44, React, Vitest, pnpm 11.18.0, Windows PowerShell and macOS system tools.

**Spec:** [Data directory design](../docs/specs/2026-11-22-data-directory-design.md), revised to create the final private folder exclusively, copy at the next startup, and commit the location record last.

## Global Constraints

- Work in `feat/data-directory`; do not merge to `main`. No force push, `reset --hard`, or `--no-verify`.
- Precedence: `AGENTHERD_HOME` → saved selection → `~/.agentherd` only when no saved selection exists. No silent fallback, no silent retry. Settings cannot override the environment.
- Keep the original data. Do not merge directories, move Git worktrees, rewrite arbitrary text, change external agent config, the app installation or Electron UI preferences. Never change permissions of a folder the app did not create.
- No credential contents in logs, diagnostics, renderer messages or fixtures (visibly fake markers only). IPC carries no filesystem paths from the renderer.
- No Electron in headless packages, no new dependency, no host wire or `packages/protocol` changes. Strict TypeScript, repository English conventions.
- Minimal implementation: no speculative options, retries or fallbacks the spec does not require.
- Update the plan's row in `plans/README.md` as it changes state.

## Review Focus

1. A process that dies with a lease never wedges a change; a live process never loses its lease to a timer (Task 1, done).
2. Every participating process holds a shared lease for as long as it touches the data directory (Task 2).
3. The created folder is owner-only even under a broadly writable parent, and the app never touches permissions of anything it did not create (Task 3).
4. Any failure before the record is committed leaves the old location selected and intact; a request is applied once or dropped, never silently retried (Task 4).
5. A corrupt record never turns the default directory into an implicit recovery location (Tasks 2 and 5).

---

## Start here

- [x] Worktree, branch and baseline checked; `pnpm install --frozen-lockfile`, `pnpm check` and the host/CLI/rules tests recorded before product changes. Baseline: 3 desktop Electron fixtures fail locally with `Fixture exited abnormally (2147483651)` (environmental, unchanged on main).

## File map and ordering

1. Admission gate (`location-gate.ts`) — done. 2. Location record, request file and leases in every entry point (`data-location.ts`, CLI, host bin, desktop main and host child). 3. Private target folder (`location-target.ts`, `location-windows.ps1`). 4. Copy, apply-at-startup and guard coverage (`location-apply.ts`, rules/core/herder). 5. Desktop picker, relaunch, recovery, docs, E2E and PR. Each task depends on the previous ones. No live credentials in automated tests.

### Task 1: Add a crash-released admission gate

**Files:** Create `packages/host/src/location-gate.ts`, `packages/host/test/location-gate.test.ts`, `packages/host/test/fixtures/location-gate-child.ts`.

**Interfaces:** Produces `LocationMode = "shared" | "exclusive"`, `LocationLease { readonly mode: LocationMode; release(): void }`, `acquireLocationLease(root: string, mode: LocationMode): LocationLease`. `root` is a trusted per-user base from `os.homedir()`, not the movable directory or `AGENTHERD_HOME`. Linux may use this gate for headless CLI; directory switching stays Windows/macOS only.

- [x] Write a real two-process test. The child sends `held` over IPC after acquisition and waits for an explicit release or exit. Use the repo's Node child fixture conventions; register listeners before requesting progress. Never infer acquisition from a sleep.

```ts
const first = await holder(base, "shared");
const second = await holder(base, "shared");
expect(() => acquireLocationLease(base, "exclusive")).toThrowError(/in use/);
await first.release();
expect(() => acquireLocationLease(base, "exclusive")).toThrowError(/in use/);
await second.terminateAndWait();
const switcher = acquireLocationLease(base, "exclusive");
try {
  expect(await tryInChild(base, "shared")).toBe("busy");
} finally {
  switcher.release();
}
expect(await tryInChild(base, "shared")).toBe("held");
```

- [x] Run `pnpm exec vitest run packages/host/test/location-gate.test.ts`. Expected RED: missing `location-gate.ts`. Add simultaneous first use, double release, corrupted gate, and unsupported gate path tests. Test an exclusive child killed mid-operation as well as a killed reader.
- [x] Implement fixed `<base>/.agentherd-location.lock.sqlite`, 0600 at creation, in the user profile; reject nonregular or aliased objects and validate the profile volume supports locking. Keep the gate file for life (never unlink or replace it). Use SQLite rollback journal, not WAL; read and verify `PRAGMA journal_mode` is `delete`, with no in-place mode conversion on a live gate. Create one sentinel table/row on first use in a short `BEGIN EXCLUSIVE` transaction; a contender during initialization returns busy and does not bypass it. Treat a malformed or incompatible initialized file as a gate failure. Keep the transaction and `DatabaseSync` instance alive until all leased work finishes. Do not implement a PID timeout or TTL.

```ts
const db = new DatabaseSync(gatePath);
try {
  db.exec("PRAGMA busy_timeout = 0");
  ensureRollbackGate(db); // verifies journal mode and a versioned sentinel
  db.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN");
  db.prepare("SELECT v FROM location_gate WHERE id = 1").get();
  let released = false;
  return { mode, release() {
    if (released) return;
    released = true;
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  } };
} catch (error) {
  db.close();
  throw asLocationGateError(error); // SQLITE_BUSY/LOCKED → in use; other errors fail closed
}
```

  `ensureRollbackGate(db: DatabaseSync): void` queries the checked sentinel under a read. Only a valid empty SQLite gate with `user_version = 0` and no schema objects can be initialized (including an empty regular file left by interrupted first use). Recheck under `BEGIN EXCLUSIVE`, set `user_version = 1` and insert the sentinel in that same transaction. Refuse any other missing or incompatible sentinel. Do not acquire a write lock during every normal open. Translate SQLite errors by numeric result code (including extended codes), not localized text. On configuration where profile protection/local locking cannot be established, do not write data under a pretend lease: return an actionable error and stop if this blocks supported default installs. Gate contains no data or user-supplied SQL.
- [x] Run `pnpm exec vitest run packages/host/test/location-gate.test.ts`. Expected GREEN: all subprocess cases pass on both CI operating systems; a live reader coexists with another reader, not a switch. Commit `feat(host): add a shared data location gate`, why: OS releases locks even if a writer dies.

### Task 2: Share the location record and hold a lease in every entry point

**Files:** Create `packages/host/src/data-location.ts`, `packages/host/test/data-location.test.ts`, `packages/cli/test/location.test.ts` (untracked drafts of both tests exist from an interrupted attempt; review and reuse what fits, discard the rest). Modify `packages/host/src/location-gate.ts` (only to let `writeLocationRecord` recognise a live exclusive lease), `packages/host/src/index.ts`, `packages/host/package.json`, `packages/host/src/config.ts:61`, `packages/host/bin/host.ts`, `packages/cli/src/main.ts`, `apps/desktop/src/main/index.ts:35-36`, `apps/desktop/src/main/host-process.ts:35-68`.

**Interfaces:** Consumes `acquireLocationLease`. Produces:

```ts
export interface LocationContext { base: string; env: NodeJS.ProcessEnv }
export interface LocationRecord { version: 1; active: string; previous?: string; retained: string[] }
export interface LocationSnapshot {
  home: string;
  source: "env" | "saved" | "default";
  protectedPaths: readonly string[]; // home, default, previous, retained, record/request/gate files
}
export interface LocationRequest { version: 1; parent: string; mode: "empty" | "copy" }
export class LocationError extends Error { code: "record-corrupt" | "location-unavailable" }
export function locationContext(): LocationContext; // { base: os.homedir(), env: process.env }
export function resolveLocation(ctx: LocationContext): LocationSnapshot;
export function withLocation<T>(ctx: LocationContext, work: (s: LocationSnapshot) => T | Promise<T>): Promise<T>;
export function readLocationRecord(ctx: LocationContext): LocationRecord | undefined;
export function writeLocationRecord(ctx: LocationContext, record: LocationRecord, exclusive: LocationLease): void;
export function writeLocationRequest(ctx: LocationContext, request: LocationRequest): void;
export function takeLocationRequest(ctx: LocationContext): LocationRequest | "corrupt" | undefined;
```

Record `~/.agentherd-location.json`, request `~/.agentherd-location-request.json`. Export the module as `@agentherd/host/data-location` for Electron main.

- [ ] Write tests with fresh per-test bases (never the real profile): default when no record; saved path with Unicode and spaces; `AGENTHERD_HOME` wins even with a corrupt record; corrupt record and missing saved directory throw `LocationError` and create nothing; `writeLocationRecord` rejects a fabricated, released or shared lease; request round-trip and `takeLocationRequest` deletes the file (also when corrupt); CLI help touches no storage; CLI `status` waits for nothing and fails fast with "in use" while a child holds the exclusive lease, creating no `herd.db`; a rejected async command still releases its lease; the host bin keeps its lease until stopped.
- [ ] Run `pnpm exec vitest run packages/host/test/data-location.test.ts packages/cli/test/location.test.ts`. Expected RED: missing module.
- [ ] Implement. Read the record with a size bound, validate a plain v1 object with absolute paths; only `ENOENT` means "no record". The saved directory must exist and be a directory; do not create it. Write record and request by `openSync(tmp, "wx", 0o600)` + write + `fsyncSync` + `renameSync` over the target; never truncate in place. Recognise live exclusive leases with a module-local `WeakSet` maintained by the gate (added on acquire, removed on release). `agentherdHome(env)` stays as a compatibility wrapper around `resolveLocation`.
- [ ] Adopt in entry points. CLI: every command except help runs inside `withLocation`, including the whole of `start` up to `running.stop()` and outstanding Feishu QR writes. Host bin: acquire the shared lease before resolving and keep it until `running.stop()` finishes; on an unrecoverable startup or stop error exit the process (the OS releases the lease) instead of releasing while partial resources may still write. Desktop main: acquire a shared lease once at startup before touching the data directory, keep it until the owned host has stopped at quit; stop injecting `AGENTHERD_HOME` into the host child so it resolves on its own (an inherited real override still applies to both). Location errors exit CLI nonzero with "open AgentHerd to recover"; desktop recovery UI comes in Task 5 (until then show an error dialog and quit).
- [ ] Run `pnpm exec vitest run packages/host packages/cli` and `pnpm check`. Expected GREEN. Commit `feat(host): share the saved data location`, why: desktop and CLI must agree and every writer must hold the gate.

### Task 3: Create an owner-only target folder

**Files:** Create `packages/host/src/location-target.ts`, `packages/host/src/location-windows.ps1`, `packages/host/test/location-target.test.ts`. Modify `apps/desktop/scripts/package-mac.ts` or the Windows packaging only if the script is not shipped with the host files. Reuse the filesystem checks already in `packages/host/src/location-gate.ts` (export them rather than duplicate).

**Interfaces:**

```ts
export const TARGET_NAME = "AgentHerd";
export class LocationTargetError extends Error {
  code: "not-local" | "link" | "exists" | "overlap" | "socket-path-too-long" | "not-private" | "invalid";
}
/** Validates the picked parent and returns `<parent>/AgentHerd` (not created). */
export function checkTargetParent(parent: string, protectedPaths: readonly string[]): Promise<string>;
/** Creates `path` (must not exist) with owner-only access and reads it back. */
export function createPrivateFolder(path: string): Promise<void>;
/** Reads back permissions of a folder this app created. */
export function verifyPrivateFolder(path: string): Promise<void>;
```

- [ ] Test with real temporary directories on each CI OS: relative path, missing parent, a symlink/junction in the parent path, existing `AgentHerd`, target inside a protected root and a protected root inside the target (case variants on Windows/macOS), macOS socket length (`Buffer.byteLength(p, "utf8") <= 103` for both `socketPath` and `mcpSocketPath` of the target). Make a test-owned parent broadly accessible (Windows: grant `Authenticated Users` inheritable Modify on that test folder; macOS: `chmod +a "everyone allow list,add_file,add_subdirectory,file_inherit,directory_inherit"`), then `createPrivateFolder` and assert the result is owner-only and a file created inside inherits that.
- [ ] Run `pnpm exec vitest run packages/host/test/location-target.test.ts`. Expected RED: missing module.
- [ ] Implement. `checkTargetParent`: absolute, existing directory, `lstat` every component (reject symlinks; on Windows reject reparse points via the script), local fixed NTFS (Windows) or APFS/HFS+ (macOS), `realpath.native` containment check against each protected path in both directions with platform case rules, target must not exist, socket length on macOS. Windows `createPrivateFolder`: run the fixed script with the system `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> -LiteralPath <p>` via `execFile` (argument array, timeout, bounded output). The script creates the directory with `[IO.Directory]::CreateDirectory(path, $security)` where `$security` has `SetAccessRuleProtection($true, $false)`, owner = current user, and inheritable FullControl for the current user, `S-1-5-18`, `S-1-5-32-544` only; it then reads back and prints JSON. macOS: `mkdirSync(path, { mode: 0o700 })`, `chmod -N` on it (removes ACL entries inherited from the parent; only on the folder just created), then verify uid, mode `0700` and no ACL entries from `/bin/ls -lde`. Fail closed on any unexpected output.
- [ ] Run the target tests and `pnpm check`. Expected GREEN on Windows; macOS via CI. Commit `feat(host): create an owner-only data folder`, why: folders on a second drive inherit broad access.

### Task 4: Apply a requested change at startup, copy safely, guard every root

**Files:** Create `packages/host/src/location-apply.ts`, `packages/host/test/location-apply.test.ts`. Modify `packages/rules/src/guard.ts`, `packages/rules/test/guard.test.ts`, `packages/core/src/pipeline.ts`, `packages/herder/src/herder.ts` (path check), `packages/host/src/host.ts`, `packages/host/src/run.ts`, `packages/cli/src/main.ts` only to pass `protectedPaths` through. Export `./location-apply` from `packages/host/package.json`.

**Interfaces:**

```ts
export type ApplyFailure = "busy" | "host-running" | "env-override" | "invalid-target" | "worktrees" | "copy-failed" | "corrupt-request";
export type ApplyResult =
  | { kind: "none" }
  | { kind: "applied"; record: LocationRecord }
  | { kind: "failed"; code: ApplyFailure };
export function applyLocationRequest(ctx: LocationContext, progress: (files: number) => void): Promise<ApplyResult>;
export function canCopy(home: string): boolean; // false when worktrees/ is non-empty
```

`PathContext` gains `protectedPaths?: readonly string[]`; guard treats each like the existing `.agentherd` self-config entry (never authorises, only denies/escalates).

- [ ] Inventory what the current app writes under the data home (`packages/host/src/{config,host,claude-home,codex-home,plugins,runtimes,server,mcp-socket,feeds}.ts`, `packages/core/src/{workspace,store}.ts`) and write the transient list (`run/herd.sock`, `run/mcp.sock`, `run/qr.png`, other audited process markers) into the module. Record the inventory in the ledger.
- [ ] Write tests with a fixture home: fake secrets, a `herd.db` with a committed row only in its WAL, `run/claude/…` and `run/codex-x/…` session files, transient files, and task/session/item rows whose `cwd`/`workspace_json.cwd` sit under `<old>/tasks/…`, plus an external project path and a sibling with a colliding prefix. Cases: no request → `none`; copy → new record, WAL row present, `quick_check` ok, scratch paths rebased, external and colliding paths unchanged, transient files absent, source byte-identical, target owner-only; empty → empty private folder and new record; exclusive busy (child holds shared lease) → `busy`, request deleted, record unchanged; a host answering on the old socket → `host-running`; non-empty `worktrees` with copy → `worktrees`; an existing target (including a private empty target) → refused and untouched; a symlink or special file in the source → `copy-failed`, record unchanged; injected failure before record write → record unchanged, destination may remain unused; corrupt request → `corrupt-request`. Guard: protected custom and retained roots are denied before rule matching, sibling with same prefix is not, Windows case variants match, existing `.agentherd` guard unchanged.
- [ ] Run `pnpm exec vitest run packages/host/test/location-apply.test.ts packages/rules packages/core packages/herder`. Expected RED.
- [ ] Implement `applyLocationRequest`: try the exclusive lease; if busy, delete the request and return `busy`. Otherwise take the request, resolve the current snapshot (`env` source → `env-override`), refuse if `isHostRunning(socketPath(home))`, `checkTargetParent`. For copy, refuse if `!canCopy`. Both modes call `createPrivateFolder(target)` with an exclusive native create that fails if the final path already exists (including an empty folder). On Windows use `CreateDirectoryW` with the protected security descriptor at creation; on macOS use nonrecursive `mkdir` followed by private-folder verification. Add a regression that checks the Windows creator itself rejects an existing folder, without relying on the caller's existence check. For copy, walk the source with `lstat`, skip only listed transient names, reject links and special files, `copyFileSync(src, dst, COPYFILE_EXCL)` and create subdirectories with `0o700`; copy `herd.db` with `VACUUM INTO` (skip its `-wal`/`-shm`), then in the copy update scratch `cwd` columns and `workspace_json.cwd` whose path is strictly under `<old>/tasks` to `<target>/tasks/…` in one transaction, run `PRAGMA quick_check`, close; `verifyPrivateFolder(target)`. Then `writeLocationRecord` with `active: target`, `previous: old`, `retained` = unique old previous/retained/old active minus the new active. On failure or interruption leave the old location selected, never automatically remove the destination, and report that the owner can choose another parent or inspect and remove the unused folder before retrying. Pass `protectedPaths` from the snapshot through Host → Herd → pipeline and Herder, and the CLI one-off Herd.
- [ ] Run the four test groups and `pnpm check`. Expected GREEN. Commit `feat(host): apply data location changes at startup`, why: copying while nothing runs avoids proving a live host has drained.

### Task 5: Desktop picker, relaunch, recovery, docs and PR

**Files:** Create `apps/desktop/src/main/data-directory.ts`, `apps/desktop/src/shared/data-directory.ts`, `apps/desktop/src/renderer/src/components/DataDirectory.tsx`, `apps/desktop/test/data-directory.test.ts`, `apps/desktop/test/data-directory.e2e.test.ts` (fixture under `apps/desktop/test/fixtures/`). Modify `apps/desktop/src/main/index.ts`, `apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/dev-bridge.ts`, `apps/desktop/src/renderer/src/pages/SettingsPage.tsx`, `apps/desktop/src/renderer/src/App.tsx` (recovery and "moving data" screens without a host). Add `docs/adr/NNNN-one-shared-data-location.md` (next free number), update `docs/adr/README.md`, `docs/spec/02-architecture.md`, `docs/spec/06-security.md`, `docs/spec/07-delivery.md`, `plans/README.md`.

**Interfaces:** Preload `dataDirectory.status(): Promise<DataDirectoryView>`, `dataDirectory.change(): Promise<DataDirectoryResult>`, `dataDirectory.recover(choice: "retry" | "previous" | "pick"): Promise<DataDirectoryResult>`, `dataDirectory.onProgress(cb: (files: number) => void): () => void`. `DataDirectoryView = { state: "ready" | "override" | "unavailable" | "moving" | "failed"; home?: string; previous?: string; canCopy: boolean; failure?: ApplyFailure }`. `DataDirectoryResult = { ok: true; state: "cancelled" | "restarting" | "recovered" } | { ok: false; code: string }`. IPC names `app:data-directory`, `app:change-data-directory`, `app:recover-data-directory`, `app:data-directory-progress`; accept calls only from the main window's main frame with no path arguments.

- [ ] Write controller tests (ports injected, no Electron import in the controller): cancel changes nothing; env override disables change; copy hidden when `canCopy` is false; confirm writes the request and calls relaunch+quit; startup with a request applies it before the host starts and shows progress; failed apply shows the reason and continues on the old location; unavailable saved location shows recovery and never starts a host; recovery "previous" and "pick" write the record under the exclusive lease. E2E: real temp profile and fake secrets, injected dialog answers at the main-process boundary, two process lifecycles, then a fresh CLI resolves the same home and the old folder is unchanged.
- [ ] Run `pnpm exec vitest run apps/desktop/test/data-directory.test.ts apps/desktop/test/data-directory.e2e.test.ts`. Expected RED. Use the fixture launch conventions of `apps/desktop/test/pet-dock-controls.test.ts`; record local Electron startup failures separately from behaviour.
- [ ] Implement. Startup order in main: create the window → `applyLocationRequest` (progress over IPC, "moving data" screen) → acquire the shared lease → `resolveLocation` (on `LocationError` show recovery, no host) → existing host start. Change: `dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })`, `checkTargetParent` for early feedback, native confirm showing old path, `<parent>/AgentHerd`, mode buttons and the warnings from the spec; then `writeLocationRequest`, `app.relaunch()`, `app.quit()` (not `win.close()`). Recovery holds no shared lease, takes the exclusive lease to write the record, then continues startup. Show sanitized messages only.
- [ ] Add `E2E-DATA-DIRECTORY` to `docs/spec/07-delivery.md` (existing data → change → empty or copy → restart → CLI agrees → old data kept; busy/failed → selection unchanged; disconnected volume → retry or recovery). ADR: one record and one gate outside the movable directory, request applied at startup, app-created owner-only folder, limits for older builds. Update architecture and security specs.
- [ ] Run `pnpm check`, `pnpm test`, `pnpm --filter @agentherd/desktop build`, `git diff --check`; record totals and the known local Electron fixture failures. Manually, with fake data only: Windows from `C:` profile to a folder on another NTFS drive, copy and empty, restart, CLI agrees, disconnect/retry if possible. macOS not available locally — mark manual macOS as not run.
- [ ] Commit `feat(desktop): let owners change the data directory`. Request a whole-branch review (ordering, permissions, leases, guard). Push the branch, open a PR with `.github/pull_request_template.md`, `Closes #157`, no merge; watch `gh pr checks <n>` and report the exact status and remaining manual checks.

## Stop conditions

- An accepted design fact is false (gate placement, shipped script path, permission creation or readback, copy compatibility). Record the evidence and ask before changing guarantees.
- A check fails twice after a targeted fix, or a scratch reference cannot be rebased safely. Stop and report the smallest reproducible case; do not bypass the gate or loosen permissions.
- Source data is never cleanup material. Tests delete only temp fixtures they created.
