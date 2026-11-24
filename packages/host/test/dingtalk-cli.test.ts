import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dingtalkCli, runDws } from "../src/dingtalk-cli.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentherd-dws-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function runFixture(
  source: string,
  args: string[] = [],
  stdin?: string,
  signal = new AbortController().signal,
) {
  return runDws(
    { executable: process.execPath, stateDir: dir },
    {
      args: ["-e", source, "--", ...args],
      ...(stdin === undefined ? {} : { stdin }),
    },
    signal,
    true,
  );
}

it("passes literal argv and stdin in an isolated environment", async () => {
  vi.stubEnv("DWS_TEST_NAMESPACE", "outside");
  vi.stubEnv("UNRELATED_TOKEN", "outside");
  const source = `const fs = require('node:fs'); console.log(JSON.stringify({
    args: process.argv.slice(1), input: fs.readFileSync(0, 'utf8'), cwd: fs.realpathSync.native(process.cwd()),
    config: process.env.DWS_CONFIG_DIR, storage: process.env.DWS_KEYCHAIN_DIR,
    leaked: Boolean(process.env.DWS_TEST_NAMESPACE || process.env.UNRELATED_TOKEN)
  }));`;
  await expect(runFixture(source, ["--text=$test & copy"], "@file.txt\n纯文本")).resolves.toEqual({
    args: ["--text=$test & copy"],
    input: "@file.txt\n纯文本",
    cwd: realpathSync.native(dir),
    config: join(dir, "config"),
    storage: join(dir, "credentials"),
    leaked: false,
  });
});

it.each([
  ["failed", "console.log(JSON.stringify({ok:true})); process.exitCode=1"],
  ["output_limit", 'console.log("x".repeat(2200000))'],
  ["invalid_response", 'console.log("FAKE_PRIVATE_OUTPUT")'],
])("rejects %s without surfacing subprocess output", async (code, source) => {
  await expect(runFixture(source)).rejects.toMatchObject({ code });
});

it("classifies a login lock access denial without echoing the provider output", async () => {
  const source = `console.error(JSON.stringify({error: {actions: ['dws auth --help'], category: 'auth', code: 2, message: 'dingtalk login failed: 本地登录态无法安全更新: acquiring file lock: creating config dir for lock: FAKE_PRIVATE_PATH: Access is denied.'}}, null, 2)); process.exitCode = 2;`;
  await expect(
    runDws(
      { executable: process.execPath, stateDir: dir },
      { args: ["-e", source] },
      AbortSignal.timeout(3000),
      false,
      undefined,
      "login",
    ),
  ).rejects.toMatchObject({
    code: "login_storage_denied",
    message:
      "钉钉无法写入本地授权目录，浏览器未打开。请检查系统是否允许钉钉组件写入 AgentHerd 数据目录，再点连接。",
  });
});

it("keeps a later authorization persistence failure unknown even if the lock open was denied", async () => {
  const source = `console.error(JSON.stringify({error: {category: 'auth', code: 2, message: 'dingtalk login failed: 保存授权失败: acquiring file lock: opening lock file: FAKE_PRIVATE_PATH: Access is denied.'}})); process.exitCode = 2;`;
  await expect(
    runDws(
      { executable: process.execPath, stateDir: dir },
      { args: ["-e", source] },
      AbortSignal.timeout(3000),
      false,
      undefined,
      "login",
    ),
  ).rejects.toMatchObject({ code: "failed" });
});

it("checks current policy after filesystem preparation and before launching DWS", async () => {
  const stateDir = join(dir, "policy-check");
  const cli = dingtalkCli({ executable: join(dir, "dws-missing"), stateDir });
  const deny = new Error("explicit deny");
  const check = vi.fn(() => {
    expect(existsSync(stateDir)).toBe(true);
    throw deny;
  });
  await expect(
    cli.run({ corpId: "corp", userId: "user" }, { args: [] }, AbortSignal.timeout(1000), check),
  ).rejects.toBe(deny);
  expect(check).toHaveBeenCalledTimes(1);
});

it("reports missing executable without exposing its path", async () => {
  const cli = dingtalkCli({ executable: join(dir, "dws-missing"), stateDir: dir });
  await expect(cli.status(new AbortController().signal)).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("does not restore authorization after an interrupted reset across CLI instances", async () => {
  const options = { executable: join(dir, "dws-missing"), stateDir: dir };
  const cli = dingtalkCli(options);
  await cli.markResetPending();
  await expect(cli.reset(AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
  const restarted = dingtalkCli(options);
  await expect(restarted.status(new AbortController().signal)).rejects.toMatchObject({
    code: "reset_pending",
  });
});

it("aborts a stalled process and rejects its result", async () => {
  await expect(
    runFixture("setInterval(() => {}, 100)", [], undefined, AbortSignal.timeout(150)),
  ).rejects.toMatchObject({ code: "cancelled" });
});
