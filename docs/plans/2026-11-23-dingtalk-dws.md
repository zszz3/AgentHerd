## DingTalk Workspace CLI Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: load the `subagent-driven-development` skill (recommended) or the `executing-plans` skill with the `skill` tool to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AgentHerd owner connect one DingTalk organization in the official browser authorization flow and let task agents use a curated office toolkit.

**Architecture:** The host runs a pinned DWS process with private credentials and binds each prepared operation to its connected account generation. The existing task MCP combines the provider catalog with WeCom and other providers; core requires a fresh owner confirmation on Feishu for every DingTalk write.

**Tech Stack:** Node ≥22.18, TypeScript, pnpm 11.18.0, Vitest, Electron, DingTalk Workspace CLI v1.0.69.

**Spec:** [DingTalk office tools in AgentHerd](../specs/2026-11-23-dingtalk-dws-design.md). Read `AGENTS.md`, the repo baseline and glossary, and ADRs 0041 and 0103 first.

## Global Constraints

- Work only in `G:/CodeProject/AgentHerd-dingtalk` on `feat/dingtalk-dws`, based on WeCom `ea4683667a225c275a9ef5d5b44f5b75ed2f99df`. Leave the parallel WeCom checkout and branch alone. Align with merged `origin/main` before opening a standalone PR.
- Official DingTalk browser authorization: click Connect, scan with mobile DingTalk, select the organization, return to AgentHerd. No embedded QR, device flow, password, self-built app credentials, credential-bearing MCP URL, or tool access from the Herder.
- A single selected user/org, explicit provider/profile binding, no credential fallback and no raw CLI, paths, file transfer, DMs, attachments, or general video meeting history. Provider data stays in task tool results; credentials never enter renderer, logs, storage records, approval, or agent context.
- Each write needs fresh owner approval on Feishu; preflight validates the exact target, present a bounded redacted preview, deny on approval or policy uncertainty, and never retry a write automatically after an uncertain outcome.
- Use pinned official binaries only. Verify Windows development/staging and macOS bundle paths; Windows installer is not part of this repo baseline. No real tenant write without the owner's separate confirmation.
- Examples run in PowerShell. `pnpm` below means the pinned 11.18.0; in this DSH workspace without `pnpm` on PATH set `function pnpm { node 'C:/Users/28694/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs' @args }` first. Check `pnpm --version` (expected `11.18.0`).

## Review Focus

- A cancel while browser auth is completing must not publish a late account or erase a later account (Task 2, deferred-login test).
- Someone changes the selected account while the Feishu card is pending; the old write must not start (Task 2 identity-drift test and Task 4 end-to-end test).
- A message begins with a CLI option or body looks like a local-file instruction; it must remain inert or be rejected before any file access (Task 3 literal-text and document tests).
- A provider response reports partial rows or exits with valid-looking JSON after a write timeout; never mistake either for complete success or retry the write (Tasks 1 and 3).
- A renderer read begun before cancel returns later; it must not overwrite the final disconnected state (Task 5 deferred-status test).

## File Map

| Area | Files |
| --- | --- |
| Pinned executable and process | `apps/desktop/scripts/fetch-dws.ts`, `apps/desktop/package.json`, `packages/host/src/dingtalk-cli.ts`, `packages/host/test/dingtalk-cli.test.ts` |
| User/org lifecycle | `packages/host/src/dingtalk-account.ts`, `packages/host/test/dingtalk-account.test.ts`, `packages/host/src/api.ts` |
| Curated commands and normalized results | `packages/host/src/dingtalk-tools.ts`, `packages/host/test/dingtalk-tools.test.ts` |
| Task policy and routing | `packages/core/src/app-calls.ts`, `packages/core/src/mcp-gateway.ts`, `packages/host/src/host.ts`, `packages/host/test/dingtalk-approval.e2e.test.ts` |
| Desktop and delivery | `apps/desktop/src/main/host-process.ts`, `apps/desktop/src/renderer/src/pages/ConnectionsPage.tsx`, `apps/desktop/src/renderer/src/components/DingTalkSection.tsx`, `apps/desktop/src/renderer/src/dev-bridge.ts`, `apps/desktop/scripts/package-mac.ts`, `.github/workflows/ci.yml`, `docs/spec/09-agent-tools.md`, `docs/spec/07-delivery.md`, `docs/adr/0105-dingtalk-office-tools-use-dws.md`, `docs/adr/README.md` |

---

### Task 1: Pin the executable and test the process boundary

**Files:** Create `apps/desktop/scripts/fetch-dws.ts`, `packages/host/src/dingtalk-cli.ts`, `packages/host/test/dingtalk-cli.test.ts`; modify `apps/desktop/package.json` and the root `.gitignore` for the generated `apps/desktop/dws/` directory.

**Interfaces:** Produces `DingTalkIdentity = Readonly<{ corpId: string; userId: string; corpName?: string; userName?: string }>`; `DingTalkCommand = Readonly<{ args: readonly string[]; stdin?: string }>`; `DingTalkCliPort` below. `dingtalkCli(options: { executable: string; stateDir: string }): DingTalkCliPort` is the production factory.

- [ ] **Step 1: Write the failing process contract tests.** In a temp directory use Node as the executable of the runner test seam with a fixture source passed via `-e` (not a shell). Use fake auth values only. Drive timeout/cancel via `AbortSignal`; assert on the static error code, never the raw child text. Test nonzero exit with JSON stdout, output over 2 MiB, non-JSON on a JSON command, missing executable, no inherited `DWS_*`, and exact stdin/argv. The central assertions are:

```ts
await expect(runFixture('console.log(JSON.stringify({ok:true})); process.exitCode=1'))
  .rejects.toMatchObject({ code: 'failed' });
await expect(runFixture('console.log("x".repeat(2200000))'))
  .rejects.toMatchObject({ code: 'output_limit' });
await expect(runFixture('console.log("FAKE_PRIVATE_OUTPUT")'))
  .rejects.toMatchObject({ code: 'invalid_response' });
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run packages/host/test/dingtalk-cli.test.ts`. Expected: missing adapter/test seam, then the new assertions fail until the process boundary is implemented.

- [ ] **Step 3: Implement the pinned CLI and staging.** Keep argument construction and raw JSON on the host side. Use this contract:

```ts
export interface DingTalkCliPort {
  status(signal: AbortSignal): Promise<DingTalkIdentity | undefined>;
  login(signal: AbortSignal): Promise<void>;
  reset(signal: AbortSignal): Promise<void>;
  run(identity: DingTalkIdentity, command: DingTalkCommand, signal: AbortSignal): Promise<unknown>;
}

// Each process receives the platform environment needed for browser/credential storage,
// not arbitrary DWS overrides or unrelated application secrets.
const profile = `${identity.corpId}:${identity.userId}`;
const argv = [...command.args, `--profile=${profile}`, '--format=json'];
```

  Use `spawn` with `shell: false`, private `cwd`, `windowsHide: true`, stdin piped and ended, stderr discarded, and stdout piped and capped at 2 MiB for JSON commands; discard stdout for login/reset. Deadline: 30 s for status/reset and business calls, 5 min for browser authorization. Kill on abort and settle on `close` before cleanup; reject process/stream errors and avoid double settlement. Decode only one JSON value with a known envelope; never include raw error text, argv, stdout, or stderr in thrown errors. Parse `auth status --readonly --format=json`: verified absent login returns undefined, malformed/indeterminate status fails closed, authenticated status requires the exact corp/user pair. `auth login --format=json` opens the browser itself, and `auth reset` clears only the app namespace; never call `auth logout` on disconnect. Set both `DWS_CONFIG_DIR` and `DWS_KEYCHAIN_DIR` to dedicated absolute subdirectories of `stateDir`; macOS still uses its normal Keychain for encryption. All business calls pass the explicit profile, never the default profile. Verify the `corp_id:user_id` selector on the pinned CLI before using it and reject unsupported selector values rather than guessing.

  Stage `dws[.exe]` in `apps/desktop/dws/`; `fetch-dws` chooses exactly one of the hashes below, checks SHA-256 before extraction, copies only the known executable entry from a fresh temp directory, and retains upstream license/NOTICE where supplied. Use `Expand-Archive` on Windows and `tar` on macOS via structured arguments. Reject unknown platforms/architectures, redirect/auth surprises, missing/alternate binary entries and non-matching digest. Publish to the staging directory only after `<exe> --version` identifies the pin; do not fall back to PATH or unversioned `latest`. Use the [upstream v1.0.69 release manifest](https://api.github.com/repos/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tags/v1.0.69):

```ts
const assets = {
  'darwin-x64': ['dws-darwin-amd64.tar.gz', '4ab7511b7481531195a0d2d6cb16df9546e9513f3d375a165fd1afc892b0e559'],
  'darwin-arm64': ['dws-darwin-arm64.tar.gz', 'b7dbea8653bcdaa78934f7e632ed8cb7835ba1647b58ddc9b09c6981fc5560d8'],
  'win32-x64': ['dws-windows-amd64.zip', '9684b525e836943f41ea6ca03404b2221a25c6ebe63f569487bd06b732574b48'],
  'win32-arm64': ['dws-windows-arm64.zip', '770372e261b2892e148fa7e8ecf129f20bda760016ca5b03facef03ba83d7ae3'],
} as const;
```

- [ ] **Step 4: Verify GREEN and smoke the public binary on Windows.** Run `pnpm exec vitest run packages/host/test/dingtalk-cli.test.ts`, `pnpm --filter @agentherd/desktop fetch-dws`, and `& .\apps\desktop\dws\dws.exe --version`. Expected: green tests, pinned asset staged, version identifies v1.0.69. Run `auth status --readonly --format=json` and `auth reset` only with two fresh test namespaces, compare isolated state (including Windows registry namespace, no credential dump), and inspect `schema`/leaf help for Task 3 without signing in. Do not reset the default user's namespace. Test tampered hash rejection with a fake archive or injected fetch. Record what the packaging job or Windows smoke actually observed.

- [ ] **Step 5: Commit.** Stage the Task 1 files and run `git diff --cached --check`, then `git commit -m 'feat(apps): pin the DingTalk Workspace CLI'`. Expected: clean whitespace check and only runner/staging changes in the commit.

### Task 2: Bind account lifecycle and approvals to one identity

**Files:** Create `packages/host/src/dingtalk-account.ts` and `packages/host/test/dingtalk-account.test.ts`; modify `packages/host/src/api.ts` to add the public view type (add RPC entries in Task 5).

**Interfaces:** Consumes `DingTalkCliPort` and `DingTalkCommand` (Task 1). Produces `DingTalkAccount` below; Task 3 consumes `bind` for both approval preflight and read operations.

- [ ] **Step 1: Write the failing lifecycle tests.** Construct `new DingTalkAccount(cli)` with fake `status`, `login`, `run`, `reset`. A deferred login must be awaited during cleanup; deliberately make the fake ignore the abort until it resolves. Also simulate restore, failed reset, duplicate login, host shutdown preserving saved auth, and an expiry/account change after preparation. Use assertions like:

```ts
await expect(account.startLogin()).resolves.toMatchObject({state: 'connecting'});
const cancellation = account.cancelLogin();
finishLogin(); // deferred fake login completion, even though its signal was aborted
await expect(cancellation).resolves.toMatchObject({state: 'disconnected'});
expect(cli.reset).toHaveBeenCalledTimes(1);
expect(await account.view()).not.toHaveProperty('corpName');

const run = await account.bind();
cli.status.mockResolvedValue({corpId: 'other-corp', userId: 'same-user'});
await expect(run({args: ['calendar', 'event', 'create']})).rejects.toThrow();
expect(cli.run).not.toHaveBeenCalled();
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run packages/host/test/dingtalk-account.test.ts`. Expected: account module absent, followed by failures until lifecycle guards are implemented.

- [ ] **Step 3: Implement the smallest account contract.** Follow WeCom's generation pattern without the QR callback or CLI catalog discovery:

```ts
export interface DingTalkView {
  state: 'disconnected' | 'connecting' | 'connected' | 'failed';
  corpName?: string;
  userName?: string;
  error?: string;
  capabilities: {id: string; name: string; toolCount: number}[];
}
export type BoundDingTalkRun = (command: DingTalkCommand) => Promise<unknown>;
// DingTalkAccount constructor(cli: DingTalkCliPort)
// view(), startLogin(), cancelLogin(), disconnect(): Promise<DingTalkView>
// bind(): Promise<BoundDingTalkRun>; stop(): Promise<void>
```

  Serialize initial restore, login and reset; allow one outstanding login and expose its immediate status. Check verified status after login and immediately before dispatch. `bind` closes over the current generation signal and exact corpId/userId; check the signal before and after awaiting status, reject mismatch and invalidate the catalog rather than adopting the new profile automatically, then dispatch once using the explicit profile. Disconnect first revokes the in-memory generation, waits for old process/lifecycle work to quiesce, then resets only the private namespace; failed reset keeps tools off and blocks reconnect until a successful disconnect. Stop aborts in-flight activity, drains it and preserves authorized credentials for restart. Do not publish sensitive or control characters via display labels, and do not serialize the bound identity into UI/application state. Put connected tool counts alongside the static tool catalog in Task 3, not a duplicate registry.

- [ ] **Step 4: Verify GREEN.** Run `pnpm exec vitest run packages/host/test/dingtalk-account.test.ts packages/host/test/dingtalk-cli.test.ts`. Expected: green; late completion, repeated connect, stale profile, reset failure and stop cases dispatch no write.

- [ ] **Step 5: Commit.** Stage `packages/host/src/api.ts` and the Task 2 source/test, run `git diff --cached --check`, then `git commit -m 'feat(apps): bind DingTalk operations to the connected account'`. Expected: whitespace clean; account state is independently testable.

### Task 3: Implement the fixed task catalog and approval preflight

**Files:** Create `packages/host/src/dingtalk-tools.ts` and `packages/host/test/dingtalk-tools.test.ts`; modify `packages/host/src/dingtalk-account.ts` for category counts from the catalog if needed; place the counts behind a one-way import (catalog may depend on a type-only account import).

**Interfaces:** Consumes `Pick<DingTalkAccount, 'bind' | 'view'>` (Task 2). Produces `dingtalkTools(account: Pick<DingTalkAccount, 'bind' | 'view'>): AppTools` and `DINGTALK_CAPABILITIES: DingTalkView['capabilities']`. Use the `AppTools` contract in `packages/core/src/mcp-gateway.ts`; `describe` uses toolkit `builtin:dingtalk`, with the read-only bit derived from the same catalog as execution.

- [ ] **Step 1: Write the failing catalog and argv tests.** Give a fake account a bound command recorder and route a verified group detail response, then drive the actual `preflight` and frozen `execute`. Assert that no send occurs until execution. Parameterize every read row below for exact argv and one page, test defaults and returned cursor, add malformed/oversized/denied provider responses, and check a structured partial provider result never becomes a complete result. Pin the following invariants:

```ts
const args = {groupId: 'cidExample', text: '--file=private.txt'};
const prepared = await tools.preflight?.('dingtalk_group_send_text', args);
expect(commands.map((c) => c.args[1])).toEqual(['+conversation-info']);
args.text = 'changed after confirmation';
await prepared?.execute();
expect(commands.at(-1)?.args).toEqual([
  'chat', '+messages-send', '--as=user', '--group=cidExample',
  '--msg-type=text', '--text=--file=private.txt',
]);
await expect(tools.preflight?.('dingtalk_doc_fetch', {nodeId: '../private.txt'}))
  .rejects.toThrow();
await expect(tools.preflight?.('dingtalk_doc_create', {
  title: 'Test', text: '![private](./private.png)',
})).rejects.toThrow();
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run packages/host/test/dingtalk-tools.test.ts`. Expected: catalog module absent, then failing validation and fixed-operation assertions until implemented.

- [ ] **Step 3: Implement the catalog.** Match the [pinned DWS tag](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/v1.0.69) and the staged command schemas. Commands below omit runner-added profile and JSON format. Keep one closed schema (`additionalProperties: false`) and one typed parser per input shape; static transport flags only as `--flag=value`. If a pin's leaf differs, update exact flags plus the fixture to match documented reality, not a runtime probe or fallback. No `--page-all`.

| Slug suffix (prefix `dingtalk_`) | Public arguments | Fixed operation |
| --- | --- | --- |
| `calendar_list` | `start`, `end`, `cursor?` | `calendar event list --start=… --end=…` and its native cursor |
| `doc_search` | `query`, `limit?`, `cursor?` | `doc +search --query=…` with its bounded page |
| `doc_fetch` | `nodeId` | `doc +fetch --node=…` full body, checked output bound |
| `group_find` | `query`, `limit?`, `cursor?` | `chat +my-groups --limit=… --cursor=…`; filter current page locally by display name, retain cursor and mark page partial while a next page exists |
| `group_history` | `groupId`, `limit?`, `cursor?` | Verify group as for send, then `chat +chat-messages --group=… --no-reactions --limit=… --page-token=…` |
| `group_search_messages` | `groupId`, `query`, `limit?`, `cursor?` | Verify group as for send, then `chat +search-msg --group=… --query=… --limit=… --cursor=…` |
| `minutes_search` | `query`, `limit?`, `cursor?` | `minutes +search --scope=all --query=… --limit=… --cursor=…` |
| `minutes_summary` | `minutesId` | `minutes +detail --id=… --artifacts=summary` (not the dual-mode `+summary`) |
| `minutes_transcript` | `minutesId`, `cursor?` | `minutes +transcript --id=… --single-page --cursor=…` |
| `group_send_text` | `groupId`, `text` | Read `chat +conversation-info --group=…`, require matching ID, verified group type and a display name, then prepare `chat +messages-send --as=user --group=… --msg-type=text --text=…` |
| `calendar_create` | `title`, `start`, `end` | `calendar event create --title=… --start=… --end=…`; primary calendar only, no implicit attendees or rooms |
| `doc_create` | `title`, `text` | `doc +create --name=… --content=-` with stdin, default destination only |

  Impose trimmed nonempty text/titles, no control chars in identifiers/flags, max 120 chars for query, 200 for title, 2,000 for a group message, and 16 KiB for document stdin. Preserve the approved actual text, including line breaks; do not use Shell or Markdown send. Identifiers are bounded opaque tokens, not URLs or paths (can contain the provider's documented `:`, `-`, `_`, `=`, `+` and `/` characters for group IDs only if upstream actually emits them; never permit file-shaped input to `--node`). Validate real RFC3339 dates with explicit numeric offset or `Z`, reject invalid days before `Date.parse`, and require `end > start`. Constrain optional page size to 1–50, default 20 where supplied, and bounded opaque cursor. Decode only the success/partial shape documented by the exact leaf and publish rows/results plus cursor/partial indicators where present; reject unknown response formats and map upstream forbidden/domain denial to a static message about org and CLI permissions. Preflight checks an exact tool slug, captures the account generation runner, and builds immutable command values; for writes expose redacted target, title, exact times, and ≤160-character preview as appropriate. `call` rejects direct write invocations; return the write closure only through `preflight` for Task 4. Reuse the repo's approval redaction before rendering preview. For document creation treat input as inline text only: conservatively reject Markdown image/link and raw HTML/resource constructs and `@file`-style directive lines; verify the pinned stdin path with fake data and code/schema, never use `+import`, command-generated paths or temporary body files. If the stdin parser can load media even from this restricted text, do not enable that write until there is a verified inline-only path.

```ts
const command: DingTalkCommand = Object.freeze({
  args: Object.freeze(['chat', '+messages-send', '--as=user',
    `--group=${groupId}`, '--msg-type=text', `--text=${text}`]),
});
return {approvalArguments: {target: verifiedGroupName, groupId, preview},
  execute: () => run(command)};
```

- [ ] **Step 4: Verify GREEN.** Run `pnpm exec vitest run packages/host/test/dingtalk-tools.test.ts packages/host/test/dingtalk-account.test.ts`. Expected: exactly nine read and three write slugs for a connected account; no advertised slugs when disconnected; unknown fields/paths/direct writes fail; each committed closure uses the original validated immutable args once.

- [ ] **Step 5: Commit.** Stage only Task 3, run `git diff --cached --check`, then `git commit -m 'feat(apps): expose curated DingTalk task tools'`. Expected: whitespace clean, catalog independent of Electron and approval UI.

### Task 4: Enforce Feishu owner approval in the task gateway

**Files:** Modify `packages/core/src/app-calls.ts`, `packages/core/src/mcp-gateway.ts`, `packages/host/src/host.ts`; create `packages/host/test/dingtalk-approval.e2e.test.ts`.

**Interfaces:** Consumes `dingtalkTools(account): AppTools` (Task 3) and `DingTalkAccount` (Task 2); `Host` owns the account, using an injected `DingTalkCliPort` in tests and a pinned executable path from `AGENTHERD_DWS` in the desktop host. Without a resolved path expose unavailable/disconnected state without starting a CLI. Produces task MCP routes only; Task 5 connects the account to the desktop RPC methods.

- [ ] **Step 1: Write the failing gateway tests.** Start real `Herd`/task MCP like `packages/host/test/wecom-approval-provenance.e2e.test.ts`, but supply `dingtalkTools(account)` with a fake DingTalk CLI. With an auto-mode/allow rule, dispatch the three writes via `herd.mcp`, wait for the approval card, then use `FakeChannel.tap`; parameterize assertions across all three. Check negative cases: local positive taps/text, non-owner, rejected card, deny initially, new deny after card, forged `COMPOSIO_MULTI_EXECUTE_TOOL` route, stale disconnect/reconnect, and identity changed without a status refresh. Test WeCom behavior unchanged with its existing suite. Test a status/read that obeys an explicit deny without invoking a write:

```ts
const {item, result} = await call('dingtalk_group_send_text', {groupId: 'cidExample', text: 'Hello'});
expect(item.lines?.[0]?.body ?? item.body).toContain('Example group');
await pet.press(item.itemId, 'allow');
await channel.tap(item.itemId, 'allow', 'someone-else');
expect(writes).toEqual([]);
await channel.tap(item.itemId, 'allow');
expect((await result)?.result).not.toMatchObject({isError: true});
expect(writes).toEqual([['chat', '+messages-send', '--as=user', '--group=cidExample',
  '--msg-type=text', '--text=Hello']]);
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run packages/host/test/dingtalk-approval.e2e.test.ts`. Expected: DingTalk is not registered or can be auto-approved, then all new safety assertions become enforced.

- [ ] **Step 3: Wire the guarded path.** In `app-calls.ts` keep today's built-in WeCom behavior and add DingTalk to the same strict policy, retaining provider-specific diagnostics. Use the condition in initial dispatch and in approval resolution, require trusted Feishu owner provenance for positive approval, check current denies again, and fail closed when preflight is missing rather than running a generic call. Desk deny/skip stays available. In the gateway reserve the built-in `dingtalk_` prefix alongside `wecom_` for Composio meta execution (single underscores are the built-in namespace; preserve plugin filtering). In `host.ts` include the provider in the existing task Apps combiner, never the Herder AppTools adapter; if rebasing onto the current WeCom summary change, report connected categories only in the existing Herder app-availability view. Stop the account on host shutdown, without invoking auth reset.

```ts
const needsOwnerDecision = (call: AppCall): boolean =>
  !isReadOnly(call.hints) &&
  (call.toolkit === 'builtin:wecom' || call.toolkit === 'builtin:dingtalk');
// Evaluate explicit deny first; the owner decision takes precedence over allow/auto.
// An allowed execution still requires fresh channel provenance and a current preflight.
```

  Use the existing read-only metadata location in `AppCall`/`AppToolInfo` rather than creating a parallel policy field. Keep the existing one-shot approval routing and never add a retry around execution. Tests assert expired/denied results and zero sends, not just internal flags.

- [ ] **Step 4: Verify GREEN.** Run `pnpm exec vitest run packages/host/test/dingtalk-approval.e2e.test.ts packages/host/test/wecom-approval-provenance.e2e.test.ts packages/core/test` and `pnpm check`. Expected: DingTalk and WeCom/control-channel policy suites green; checks pass or report an unchanged baseline issue with exact evidence.

- [ ] **Step 5: Commit.** Stage only Task 4 and run `git diff --cached --check`, then `git commit -m 'feat(apps): require Feishu owner approval for DingTalk writes'`. Expected: no desktop code or WeCom branch touched.

### Task 5: Deliver desktop connection and verification

**Files:** Modify `packages/host/src/api.ts`, `packages/host/src/host.ts`, `apps/desktop/src/main/host-process.ts`, `apps/desktop/src/renderer/src/pages/ConnectionsPage.tsx`, `apps/desktop/src/renderer/src/dev-bridge.ts`, `apps/desktop/scripts/package-mac.ts`, `.github/workflows/ci.yml`, `docs/spec/09-agent-tools.md`, `docs/spec/07-delivery.md`, `docs/adr/README.md`; create `apps/desktop/src/renderer/src/components/DingTalkSection.tsx`, `apps/desktop/test/dingtalk-connection.test.ts`, and `docs/adr/0105-dingtalk-office-tools-use-dws.md`.

**Interfaces:** Host API adds `dingtalk`, `startDingTalkLogin`, `cancelDingTalkLogin`, and `disconnectDingTalk`, all `(): Promise<DingTalkView>`. `DingTalkRow({view, onView}: {view: DingTalkView | undefined; onView: (next: DingTalkView) => void})` follows the existing connections row style. `applyDingTalkView` is a small pure renderer-local revision check used by the async row and unit tested below.

- [ ] **Step 1: Write failing RPC and stale-state tests.** Verify the routing allowlist, no QR or tokens in the view, and stale browser login status ignored after Cancel (no need for a real tenant). The renderer test imports the row's pure revision function; emulate the race with two deferred promises in completion order:

```ts
expect(applyDingTalkView(2, 1, {state: 'connected', capabilities: []})).toBeUndefined();
expect(applyDingTalkView(2, 2, {state: 'disconnected', capabilities: []}))
  .toMatchObject({state: 'disconnected'});
expect(HOST_METHODS).toEqual(expect.arrayContaining([
  'dingtalk', 'startDingTalkLogin', 'cancelDingTalkLogin', 'disconnectDingTalk',
]));
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run apps/desktop/test/dingtalk-connection.test.ts`. Expected: missing renderer/RPC implementation.

- [ ] **Step 3: Implement desktop visibility and packaging.** Add API entries and the four methods to `HOST_METHODS` and browser dev bridge without exposing arbitrary IPC. In `host-process.ts`, set `AGENTHERD_DWS` for the host utility process from the known dev staging directory or `Resources/dws/dws` in the Mac bundle; use `dws.exe` for Windows and no PATH search. A separately started host without staging shows unavailable, not a prompt to run arbitrary binaries. In `package-mac.ts` invoke `fetch-dws`, copy staged resources and include native `dws` in existing standalone signing before signing the whole app. CI builds verify staged pin on Windows and staged/signed path on the Mac target when available. No new Windows installer.

```ts
export function applyDingTalkView(current: number, started: number, next: DingTalkView) {
  return current === started ? next : undefined;
}
```

  Render `钉钉` in 账号, count ready/failed separately, follow WeCom's row spacing and buttons, and show account/org names and four capabilities only when connected. Explain `已在浏览器打开钉钉授权页，请用手机钉钉扫码并选择组织。` while connecting; offer `取消授权`; connected offers `断开连接`. Poll only while connecting and cancel the poll on unmount. Capture request revision before each status read/action and compare before applying a result (bump it synchronously at every new action, ignore old reads on unmount). Dev bridge uses fake display data only; no Node imports or auth material in renderer. Sync specs and ADR index; delivery tests document permissions, fake end-to-end and real-tenant limitations.

- [ ] **Step 4: Verify GREEN and compare to baseline.** Run `pnpm exec vitest run apps/desktop/test/dingtalk-connection.test.ts`, `pnpm check`, `pnpm --filter @agentherd/desktop build`, and `pnpm test`. Expected: new tests and desktop build green; baseline before product changes had 1,743 passed and three unrelated Windows Electron fixture failures (`apps-search.test.ts`, `pet-dock-controls.test.ts`, `pet-talk.test.ts`, all `Fixture exited abnormally (2147483651)` at `apps/desktop/test/search-fixture.ts:72:16`). Flag every new regression; do not hide the three by changing unrelated suites. Smoke `应用连接 → 账号` on desktop with fake account and record real app/pin/packaging scope; use macOS CI for bundle/signing if this Windows machine cannot verify it. A tenant smoke is separate: explicitly authorized test account, read-only first; each real write requires separate confirmation. If no tenant is provided report it as unverified.

- [ ] **Step 5: Commit and review integration.** Stage only Task 5 and run `git diff --cached --check`, then `git commit -m 'feat(desktop): connect DingTalk from the accounts page'`. Expected: checks recorded, new commit and no unstaged changes. Before delivery run a fresh whole-branch review, `git status --short --branch`, `git diff --check ea4683667a225c275a9ef5d5b44f5b75ed2f99df...HEAD` and the focused DingTalk/WeCom suites again. Expected: clean worktree/diff and all focused suites green. Check merge state with `git ls-remote --heads origin main feat/wecom-mcp`; expected: exact refs available for ancestry checks. If WeCom is not yet merged, keep the independent branch and report that a clean standalone PR awaits its merge; if it is merged (including squash merge), use the DingTalk-only commits when aligning to `origin/main`, rerun focused checks, then open a standalone PR following repo policy. Do not involve the WeCom checkout or force-update a remote branch.
