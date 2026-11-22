# Choose and migrate the AgentHerd data directory

- Status: proposed for maintainer review
- Issue: [#157](https://github.com/zszz3/AgentHerd/issues/157)

## Problem and scope

Owners on Windows and macOS need to keep AgentHerd data on another local volume without setting an environment variable. Windows normally places it under the user profile, which is often on `C:`. The desktop app shows the active directory, but cannot change it.

Add one shared setting for the desktop, host and CLI. Let owners start with an empty directory or copy existing data. Keep the default at `~/.agentherd`. Do not move the app installation or Electron's own UI preferences. Do not move Git worktrees, merge two data directories, or promise that an external agent can resume its own session after a move.

## Options

| Option | Trade-off |
| --- | --- |
| Desktop-only setting | Fewer changes, but CLI commands could keep writing to the old directory. |
| Shared setting, start empty only | Solves placement for new data, but owners must move credentials and history themselves. |
| Shared setting with an optional copy | Keeps desktop and CLI together and preserves supported data. Requires exclusive access, permission checks, and recovery. **Chosen.** |

## Owner flow

1. Open **Settings → About → Data directory**. The row shows the directory the app actually uses. If `AGENTHERD_HOME` is set, show that it overrides the setting and disable changes in the app.
2. Choose **Change…**. The main process opens a native folder picker. Pick an empty, private directory on a supported local volume. Canceling does not change anything.
3. Confirm the old and new paths and choose **Start empty** or **Copy existing data**. The confirmation explains that the app restarts, the old files remain, and an empty directory opens with no accounts or history. If copy is unavailable, explain why before any files are written.
4. Show progress while copying and prevent a second change. Restart only after the new directory is ready and the shared setting has been committed. On Windows, restart the app rather than closing its window to the tray.

## Shared location and startup

Resolve the location in `packages/host` and use that resolver from the desktop main process and CLI. Precedence is `AGENTHERD_HOME`, the saved selection, then `~/.agentherd` when there is no saved selection. Save a versioned, per-user record at `~/.agentherd-location.json`, independently of Electron and the movable directory. The record holds the active path, the previous location for recovery, and retained roots to protect after a move. It contains no credentials. Write a private temporary sibling and atomically replace the record once the destination is ready.

Check a saved location before opening SQLite, starting a host, or creating default files. If the record is invalid or the directory is missing or inaccessible, do not silently create a replacement at that path or fall back to the default. The desktop offers retry after reconnecting the volume. If it can read a usable previous location from the record, it also offers an explicit return to that location. If the record is unreadable, the owner must choose a known existing AgentHerd directory in the recovery picker; never infer a location from an unreadable record. Recovery uses the same exclusive gate and path checks, but validates existing AgentHerd data instead of requiring an empty folder. The CLI reports a nonzero error and points to desktop recovery. Recovery does not merge data written since the switch. Warn about that before restoring the previous location. Existing environment overrides keep their precedence and do not change the saved selection.

## Safe switch

**Target.** Use the real path for identity and containment; use platform-appropriate comparison and detect aliases. Reject source/target overlap in either direction, volume roots, network locations, symlinks or Windows reparse points in the selected path, and nonempty directories. Require a supported local filesystem that can enforce private access. On macOS, check owner and effective permissions and create private files and directories. On Windows, check effective ACLs, including inheritance, on the destination before any credential bytes are written. A successful write probe is not a privacy check. Reject a path if privacy or local filesystem support cannot be established. Recheck target identity and permissions before writing and before switching. Validate the macOS byte limit for both local socket paths.

**Quiesce.** Do not use a socket connection failure as proof that no writer is running. Use a shared admission gate outside the movable directory: normal use takes a lease before resolving and opening the directory; an exclusive switch can proceed only when all normal leases have ended and blocks new access until the location is committed or the attempt is aborted. Use an OS-released lock or a process-owned broker that releases on disconnect; do not reclaim based on elapsed time alone. One-off CLI commands, including `status` (which opens the store), must participate as well as the host. The main process must pause new host starts and data operations while switching. Participating processes must not keep a stale location across the gate. Require the owner to close older builds and their CLI commands before switching; they do not honor the gate. Refuse to switch if a reachable external host is attached, even if it has no lease. The gate guarantees exclusion only for participating builds. If ownership or writer shutdown cannot be established, fail without changing the setting.

Stop only the desktop-owned host, and require confirmation that shutdown finished cleanly, including outstanding writes and closing the store. A forced kill or timeout is a failure, not a successful stop. Do not stop an external host. If an external writer or unfinished work prevents safe shutdown, keep using the current location and let the owner stop it or finish the work before applying either choice. A Git worktree blocks copying, but does not block starting empty once the app can safely restart. Confirm there is no unfinished task or unresolved dependency on a worktree in the copy. Check saved workspace records as well as the `worktrees` directory; empty directory scaffolding alone does not block migration.

**Copy.** Inventory data produced by the current app before implementing the copy. Include settings, secrets, the SQLite database and any required sidecars, AgentHerd-owned history and installed plugins. Preserve persistent agent session data under `run/`; omit sockets, PIDs, QR codes and other transient files, not the entire directory. Keep filesystem permissions private, reject unexpected links and unsupported special files rather than following or silently skipping them, and copy across volumes without changing the source. Rebase structured scratch workspace paths relative to the copied `tasks` tree; do not rewrite arbitrary text, project paths, or external agent files. Validate the copied store and ensure AgentHerd-owned references required to open it do not still depend on the old root. Reject the copy if a required reference cannot be relocated safely.

**Activate.** Create a private staging directory on the target volume and verify its effective permissions before copying. Validate the copy there. Publish into the still-empty target without overwriting files, and check the published directory's effective permissions before changing the setting. Do not assume a rename preserves privacy across inherited ACLs. Commit the location record last. Before that point every failure or interruption leaves the old directory selected and intact. Restart the original service on a recoverable failure if the app stopped it and exclusive access has been released. Clean up only artifacts created by this attempt and only while their identity is known; do not delete the original or any pre-existing files. If interrupted after publishing but before changing the setting, report the unused copy and require an explicit choice to clear it or choose a different empty folder. After committing, an unavailable new directory uses the startup recovery flow rather than silently falling back.

## Boundaries

- Electron main owns the picker, validation and restart. The renderer uses a typed preload bridge. The bridge does not let the renderer pass arbitrary filesystem paths to copy or receive credentials. Commit requests refer to a selection made in the native picker.
- The host package owns location resolution, admission and the copy rules; it does not import Electron. Do not change the host wire protocol or the permission decision flow.
- Continue guarding the default, active and retained data directories in both the task pipeline and Herder path checks. Match the resolved root rather than the basename `.agentherd`. Protect the shared location record as well. Do not log secret contents or copy them through renderer messages.
- Record the architecture decision and update the [architecture](../spec/02-architecture.md), [security](../spec/06-security.md) and [delivery](../spec/07-delivery.md) specs with the implementation.

## Acceptance checks

Run the same automated cases on Windows and macOS. Verify these behaviors using temporary directories and fake credentials:

- The desktop and CLI agree on the saved path; `AGENTHERD_HOME` still wins. Cancel and invalid selection change nothing. Missing, corrupt and disconnected selections do not create a new default store.
- Start empty and copy both restart into the selected directory. After a supported copy, settings, history and credentials are readable only through their existing boundaries. The old directory remains unchanged. Scratch paths refer to the new root. No socket or transient state is carried forward.
- Running CLI writers, an external or uncleanly stopped host, or unfinished work prevent unsafe switching. Worktrees make copy unavailable; start empty remains available once the system is idle. Restart races, interrupted copy, disk-full and permission failures do not change the active record.
- Reject shared or unsupported destination filesystems, links or reparse points, overlapping and nonempty directories, and paths too long for macOS sockets. Verify the guard for a custom path and the retained source, not just `~/.agentherd`.
- Exercise the native picker, restart and recovery flow on both platforms, including a non-system drive on Windows. Report any manual checks that did not run separately from automated results.
