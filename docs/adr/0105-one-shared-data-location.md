# 0105. Use one shared data location

Status: Accepted

## Context

Desktop and CLI users may need to keep large AgentHerd data on another local drive. An Electron-only preference would let the desktop and CLI silently use different stores. Moving a live store risks losing writes and exposing credentials.

## Decision

Keep one versioned location record and one SQLite admission gate in the user profile, outside the movable directory. Desktop main, the host process and the CLI resolve `AGENTHERD_HOME` first, then the record, then `~/.agentherd` if there is no record. Each holds a shared lease for the lifetime of its data access. A switch or recovery write needs the exclusive lease.

The desktop asks the owner to choose a parent and confirm a restart. The next startup applies the request before starting the host. AgentHerd creates `<parent>/AgentHerd` itself on a supported local volume and verifies owner-only access. A copy uses only supported data and commits the record after verification. The source stays intact. The renderer sends no filesystem paths to main; only the main window's main frame can invoke the location operations.

An unavailable or unreadable selection does not fall back silently. The owner can retry, select an existing AgentHerd directory (a real path that already holds `herd.db`), or explicitly return to a usable previous location without merging data. An unreadable record is not a source of recovery paths.

## Consequences

The desktop, host and CLI agree when all use this resolver. Older builds do not join the gate or discover the saved selection; stop them before a switch and upgrade them before sharing a store. A failed copy may leave an unused destination. AgentHerd does not remove it or the source.

See the [data directory design](../specs/2026-11-22-data-directory-design.md) for the platform and copy limits.
