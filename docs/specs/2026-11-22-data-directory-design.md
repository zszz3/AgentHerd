# Choose and migrate the AgentHerd data directory

- Status: proposed for maintainer review (revised: app-created private folder, copy at next startup)
- Issue: [#157](https://github.com/zszz3/AgentHerd/issues/157)

## Problem and scope

Owners on Windows and macOS need to keep AgentHerd data on another local volume without setting an environment variable. Windows normally places it under the user profile, which is often on `C:`. The desktop app shows the active directory, but cannot change it.

Add one shared setting for the desktop, host and CLI. Let owners start with an empty directory or copy existing data. Keep the default at `~/.agentherd`. Do not move the app installation or Electron's own UI preferences. Do not move Git worktrees, merge two data directories, or promise that an external agent can resume its own session after a move.

## Options

| Option | Trade-off |
| --- | --- |
| Desktop-only setting | Fewer changes, but CLI commands could keep writing to the old directory. |
| Shared setting, start empty only | Solves placement for new data, but owners must move credentials and history themselves. |
| Shared setting with an optional copy | Keeps desktop and CLI together and preserves supported data. Requires exclusive access, a private folder and recovery. **Chosen.** |

Two simplifications over the first draft:

- **The app creates the data folder.** Folders that owners create on a second Windows drive usually inherit broad access (for example `Authenticated Users: Modify` on the drive root). Requiring the picked folder to be private would reject the main use case. Instead the owner picks a parent folder, and the app creates an `AgentHerd` folder inside it with owner-only access.
- **The copy runs at the next startup, before any host starts.** Stopping a live host and proving every writer has drained is hard to get right. A restart already closes every participating writer, and the admission gate proves it.

## Owner flow

1. Open **Settings → About → Data directory**. The row shows the directory the app actually uses. If `AGENTHERD_HOME` is set, show that it overrides the setting and disable changes in the app.
2. Choose **Change…**. The main process opens a native folder picker. The owner picks a parent folder on a local disk; the data will live in `<parent>/AgentHerd`, which must not exist yet. Canceling changes nothing.
3. Confirm the old and new paths and choose **Start empty** or **Copy existing data**. The confirmation explains that the app restarts, running tasks stop as on a normal quit, the old files remain, older AgentHerd builds and CLI commands must be closed, and an empty directory opens with no accounts or history. If copy is unavailable (for example, Git worktrees exist), say why.
4. The app records the request and restarts (on Windows it relaunches rather than closing to the tray). On startup, before the host starts, it creates the folder, copies if asked, and commits the new location. The window shows progress while copying. On failure it keeps the old location and shows why.

## Shared location and startup

Resolve the location in `packages/host` and use that resolver from the desktop main process, the host utility process and the CLI. Precedence is `AGENTHERD_HOME`, the saved selection, then `~/.agentherd` when there is no saved selection. Save a versioned, per-user record at `~/.agentherd-location.json`, independently of Electron and the movable directory. The record holds the active path, the previous location for recovery, and retained roots to protect after a move. It contains no credentials. Write a private temporary sibling and atomically rename it over the record.

A pending change is a separate request file, `~/.agentherd-location-request.json`, holding the target parent and the mode. Writing it changes nothing by itself. Only the startup step, holding the exclusive gate, reads it, deletes it, and applies it. A request that cannot be applied is dropped with an error shown to the owner; it is never retried silently.

Check a saved location before opening SQLite, starting a host, or creating default files. If the record is invalid or the directory is missing or inaccessible, do not create a replacement at that path or fall back to the default. The desktop offers retry after reconnecting the volume, and, if the record names a usable previous location, an explicit return to it. If the record is unreadable, the owner must pick a known existing AgentHerd directory; never infer a location from an unreadable record. Recovery does not merge data written since the switch; warn about that before restoring the previous location. The CLI reports a nonzero error and points to desktop recovery. Environment overrides keep their precedence and do not change the saved selection.

## Exclusive access

Use a shared admission gate outside the movable directory (`~/.agentherd-location.lock.sqlite`, an OS-released SQLite lock, no timeouts). Every participating process takes a shared lease before resolving and opening the data directory and keeps it until it stops writing: the desktop main process, the host utility process, CLI `start`, one-off CLI commands including `status`. Applying a pending request takes the exclusive lease. Getting it proves no participating process is running; if it is busy (for example a CLI `agentherd start` is running), drop the request, keep the current location, and tell the owner which kind of process to close.

Older builds and their CLI commands do not take the gate; the confirmation tells the owner to close them. The startup step also refuses to apply a request if a host still answers on the current location's socket.

## Private target folder

The picked parent must be on a supported local disk: fixed NTFS on Windows, APFS or HFS+ on macOS. Reject network locations, volume roots as the data folder, symlinks or Windows reparse points in the path, and any overlap between the current data directory (and retained roots) and the new folder in either direction. Check the macOS byte limit for both local socket paths.

The app creates `<parent>/AgentHerd` itself and sets owner-only access before writing anything into it:

- Windows: a protected DACL (inheritance removed) granting full control to the current user, `SYSTEM` and `Administrators`, owner set to the current user.
- macOS: mode `0700`, owned by the current user, with no ACL entries.

Read the permissions back and refuse to continue if they differ. Require a directory chain that prevents other ordinary accounts from replacing any path component, including the new folder. Read or traverse access and the ability to create unrelated siblings are not by themselves reasons to refuse. Check ownership and the platform's rename, delete, and permission-changing rights before creating the target; if the app cannot establish that the chain is protected, refuse and ask the owner to pick a protected location. Never change the permissions of any folder the app did not create. The check does not defend against administrators, the current user, or a later change by a trusted owner.

## Copy

Inventory data produced by the current app before implementing the copy. Include settings, secrets, the SQLite database, AgentHerd-owned history and installed plugins. Copy the database with SQLite (`VACUUM INTO` or the backup API) so committed WAL content is included. Preserve persistent agent session data under `run/`; omit sockets, PIDs, QR codes and other named transient files, not the entire directory. Reject unexpected links and special files rather than following or silently skipping them. Define fixed data-home paths where their owning runtime packages can use them, and make those same declarations available to migration. Include both containers and fixed children (for example, the desktop log directory and its host log). Classify declarations as persistent, transient, or SQLite-managed; the classification controls copy behavior, not what the runtime can read or write. Do not maintain a second list of names in migration or register arbitrary third-party filenames. If an ordinary source entry resolves to a declared path on the destination, refuse the copy before publishing the record. Use the actual filesystem lookup on both sides rather than assuming a volume's case rules. Do not change the source.

A non-empty `worktrees` directory blocks copying; start empty stays available. Rebase structured scratch workspace paths (task, session and item working directories under the old `tasks` tree) to the new root; do not rewrite arbitrary text, project paths, or external agent files.

Create `<parent>/AgentHerd` exclusively and verify that it is private and empty before copying directly into it. Refuse if the folder already exists, even if it is private and empty. Do not publish the directory by rename: on macOS an ordinary rename can replace an existing empty directory. Verify the copied data (database `quick_check`, required files present, permissions still private), then commit the location record last. On failure or interruption, the old directory remains selected and intact. A partial destination may remain; tell the owner to choose another parent or inspect and remove the unused folder before retrying. The app does not automatically delete either directory.

## Boundaries

- Electron main owns the picker, the request file and the restart. The renderer uses a typed preload bridge and never passes filesystem paths or receives credentials.
- The host package owns location resolution, admission, the private folder and the copy; it does not import Electron. Do not change the host wire protocol or the permission decision flow.
- Continue guarding the default, active and retained data directories and the location files in both the task pipeline and Herder path checks. Match resolved roots, not the basename `.agentherd`. For existing declared paths, use filesystem identity for alternate spellings, including when the requested child does not yet exist. If a declared location metadata file is absent, ask the owner about case variants of its reserved name in the same profile directory. This fallback does not apply to data roots or unrelated files. If the identity of a retained directory cannot be read, keep the normal rule flow for targets that can be ruled out. Ask the owner to approve targets that could still refer to that directory, and explain that its identity could not be checked. Use filesystem type and identity evidence to rule out candidates where possible, including a known regular file that cannot identify a directory. Keep the distinction between literal command text and actual unresolved path operands; a fixed literal used only as display text is not a reason to ask. Continue checking explicitly declared paths even when the command cannot be parsed. Do not treat access errors as a missing directory or persist directory identities in the location record. This does not restore unrelated built-in guards to the task pipeline. Do not log secret contents.
- Record the architecture decision and update the [architecture](../spec/02-architecture.md), [security](../spec/06-security.md) and [delivery](../spec/07-delivery.md) specs with the implementation.

## Acceptance checks

Run the same automated cases on Windows and macOS with temporary directories and fake credentials:

- The desktop and CLI agree on the saved path; `AGENTHERD_HOME` still wins. Cancel and invalid selection change nothing. Missing, corrupt and disconnected selections do not create a new default store.
- Start empty and copy both restart into `<parent>/AgentHerd`. After a copy, settings, history and credentials work, scratch paths point at the new root, no transient state is carried forward, and the old directory is unchanged.
- On volumes with different name lookup rules, refuse an ordinary source entry that would become a declared runtime path, including at a nested log path. Verify that a genuine app log and unrelated data retain their contents in a successful copy, and that a refusal leaves the source and active record unchanged.
- An unreadable retained directory prompts only for targets that cannot be ruled out. A known unrelated regular file and a fixed display-only command literal do not prompt; an explicit protected path still goes through the guard if command parsing fails.
- The new folder is owner-only even when the parent grants broad access.
- A running CLI, a live host on the old location, worktrees (for copy), interrupted copy, disk-full and permission failures leave the active record unchanged.
- Reject network or unsupported filesystems, links or reparse points, overlap, an existing `AgentHerd` folder, and paths too long for macOS sockets. The guard covers a custom path and the retained source, not just `~/.agentherd`.
- Exercise the picker, restart and recovery on both platforms, including a non-system drive on Windows. Report manual checks that did not run separately from automated results.
