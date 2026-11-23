import { type SpawnOptions, spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WecomCli } from "../src/wecom-cli.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentherd-wecom-test-"));
  configDir = join(root, "config");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function fixture(program: string, options: ConstructorParameters<typeof WecomCli>[1] = {}) {
  const start = vi.fn((_: string, args: readonly string[], spawnOptions: SpawnOptions) =>
    spawn(process.execPath, ["-e", program, "--", ...args], spawnOptions),
  );
  const cli = new WecomCli(configDir, {
    executable: () => process.execPath,
    spawn: start,
    ...options,
  });
  return { cli, start };
}

describe("WeCom CLI", () => {
  it("runs literal argv in a private working directory with an isolated environment", async () => {
    vi.stubEnv("WECOM_CLI_ACCESS_TOKEN", "fake-token");
    vi.stubEnv("wecom_cli_log_dir", root);
    vi.stubEnv("WECOM_CLI_CONFIG_DIR", join(root, "external"));
    const { cli, start } = fixture(`
      const fs = require('node:fs');
      console.log(JSON.stringify({
        args: process.argv.slice(1),
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^WECOM_CLI_/i.test(name))),
        dotenv: fs.readFileSync('.env', 'utf8'),
        cwd: process.cwd(),
      }));
    `);
    const args = ["calendar", "list", "--params", '{"value":"a ; & b"}'];
    const result = await cli.run(args);
    expect(result).toEqual({
      args,
      env: { WECOM_CLI_CONFIG_DIR: await realpath(configDir) },
      dotenv: "",
      cwd: expect.any(String),
    });
    const [, , opts] = start.mock.calls[0];
    expect(opts).toMatchObject({ shell: false, windowsHide: true });
    expect(opts.cwd).not.toBe(process.cwd());
    await expect(access(String(opts.cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["authorized", "unauthorized"])("recognizes exact %s status output", async (status) => {
    const { cli, start } = fixture(`console.log(${JSON.stringify(status)});`);
    await expect(cli.status()).resolves.toBe(status === "authorized");
    expect(start.mock.calls[0][1]).toEqual(["auth", "show", "--status"]);
  });

  it("rejects unknown status, invalid JSON and failures without revealing subprocess data", async () => {
    const invalid = fixture(`console.log('fake-credential');`);
    await expect(invalid.cli.status()).rejects.toThrow(
      /^WeCom CLI returned an invalid auth status\.$/,
    );
    await expect(invalid.cli.run(["calendar", "list"])).rejects.toThrow(
      /^WeCom CLI returned invalid JSON\.$/,
    );
    const failed = fixture(
      `console.log('fake-credential'); console.error('fake-credential'); process.exitCode = 1;`,
    );
    await expect(failed.cli.run(["calendar", "list"])).rejects.toThrow(
      /^WeCom CLI command failed\.$/,
    );
    const missing = new WecomCli(configDir, { executable: () => join(root, "no-such-binary") });
    await expect(missing.status()).rejects.toThrow(/^WeCom CLI could not start\.$/);
  });

  it("bounds stdout and terminates a timed out process before returning", async () => {
    const large = fixture(`process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);`, {
      maxOutputBytes: 64,
    });
    await expect(large.cli.run(["calendar", "list"])).rejects.toThrow(
      /^WeCom CLI output is too large\.$/,
    );
    expect(large.start.mock.results[0].value.killed).toBe(true);
    const hanging = fixture(`setInterval(() => {}, 1000);`, { commandTimeoutMs: 100 });
    await expect(hanging.cli.run(["calendar", "list"])).rejects.toThrow(/^WeCom CLI timed out\.$/);
    expect(hanging.start.mock.results[0].value.killed).toBe(true);
    await expect(access(String(hanging.start.mock.calls[0][2].cwd))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not spawn a pre-aborted command or expose an abort reason", async () => {
    const { cli, start } = fixture("throw new Error('unexpected spawn')");
    await expect(cli.status(AbortSignal.abort("fake-credential"))).rejects.toThrow(
      /^WeCom CLI was canceled\.$/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ["auth", "show"],
    ["calendar", "list", "--output=/external"],
    ["calendar", "list", "-oexternal"],
    ["doc", "download", "--output-dir", "/external"],
  ])("rejects auth and caller-selected file outputs before spawning: %j", async (...args) => {
    const { cli, start } = fixture("throw new Error('unexpected spawn')");
    await expect(cli.run(args)).rejects.toThrow(/^WeCom CLI arguments are not allowed\.$/);
    expect(start).not.toHaveBeenCalled();
  });

  it("publishes one complete PNG during login and cleans up the QR after success", async () => {
    const { cli, start } = fixture(
      `
      const fs = require('node:fs');
      const path = process.argv.at(-1);
      const png = Buffer.from(${JSON.stringify(PNG)}, 'base64');
      fs.writeFileSync(path, png.subarray(0, 20), { flag: 'wx' });
      setTimeout(() => fs.appendFileSync(path, png.subarray(20)), 50);
      const timer = setInterval(() => {
        if (fs.existsSync('confirmed')) clearInterval(timer);
      }, 20);
    `,
      { qrPollIntervalMs: 10, loginTimeoutMs: 5_000 },
    );
    const onQr = vi.fn(() => {
      void writeFile(join(String(start.mock.calls[0][2].cwd), "confirmed"), "");
    });
    await cli.login(onQr, new AbortController().signal);
    expect(onQr.mock.calls).toEqual([[`data:image/png;base64,${PNG}`]]);
    const [, args, opts] = start.mock.calls[0];
    expect(args.slice(0, -1)).toEqual([
      "auth",
      "init",
      "--noninteractive",
      "--no-browser",
      "--output-qrcode",
    ]);
    await expect(lstat(join(String(opts.cwd), String(args.at(-1))))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("kills login on cancellation and removes the credential-bearing QR file", async () => {
    const { cli, start } = fixture(
      `
      require('node:fs').writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(PNG)}, 'base64'));
      setInterval(() => {}, 1000);
    `,
      { qrPollIntervalMs: 10 },
    );
    const controller = new AbortController();
    const onQr = vi.fn(() => controller.abort("fake-credential"));
    await expect(cli.login(onQr, controller.signal)).rejects.toThrow(/^WeCom CLI was canceled\.$/);
    expect(onQr).toHaveBeenCalledTimes(1);
    expect(start.mock.results[0].value.killed).toBe(true);
    await expect(access(String(start.mock.calls[0][2].cwd))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("publishes the QR when login exits before the next polling tick", async () => {
    const { cli } = fixture(
      `
      require('node:fs').writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(PNG)}, 'base64'));
    `,
      { qrPollIntervalMs: 60_000 },
    );
    const onQr = vi.fn();
    await cli.login(onQr, new AbortController().signal);
    expect(onQr.mock.calls).toEqual([[`data:image/png;base64,${PNG}`]]);
  });

  it("rejects an oversized QR and a login that never publishes a QR", async () => {
    const oversized = fixture(
      `
      require('node:fs').writeFileSync(process.argv.at(-1), Buffer.alloc(4096));
      setInterval(() => {}, 1000);
    `,
      { qrPollIntervalMs: 10, maxQrBytes: 64 },
    );
    const onQr = vi.fn();
    await expect(oversized.cli.login(onQr, new AbortController().signal)).rejects.toThrow(
      /^WeCom CLI QR is too large\.$/,
    );
    expect(oversized.start.mock.results[0].value.killed).toBe(true);
    const hanging = fixture(`setInterval(() => {}, 1000);`, {
      qrPollIntervalMs: 10,
      loginTimeoutMs: 100,
    });
    await expect(hanging.cli.login(onQr, new AbortController().signal)).rejects.toThrow(
      /^WeCom CLI timed out\.$/,
    );
    expect(onQr).not.toHaveBeenCalled();
  });

  it("only deletes owned credential files on logout, which is idempotent", async () => {
    const external = join(root, "external");
    await mkdir(external);
    await mkdir(configDir);
    const credentialFiles = ["credentials.enc", "bot.enc", "token.enc", ".encryption_key"];
    for (const name of [...credentialFiles, "config.json"])
      await writeFile(join(configDir, name), "test sentinel");
    await writeFile(join(external, "credentials.enc"), "external sentinel");
    vi.stubEnv("WECOM_CLI_CONFIG_DIR", external);
    const cli = new WecomCli(configDir);
    await cli.logout();
    await cli.logout();
    for (const name of credentialFiles)
      await expect(access(join(configDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(configDir, "config.json"), "utf8")).toBe("test sentinel");
    expect(await readFile(join(external, "credentials.enc"), "utf8")).toBe("external sentinel");
  });

  it("blocks restoration after an interrupted local logout until cleanup succeeds", async () => {
    await mkdir(configDir);
    const credential = join(configDir, "credentials.enc");
    await mkdir(credential);
    const { cli } = fixture("console.log('authorized')");
    await expect(cli.logout()).rejects.toThrow();
    await rm(credential, { recursive: true });
    await writeFile(credential, "test sentinel");
    const { cli: restarted, start } = fixture("console.log('authorized')");
    await expect(restarted.status()).rejects.toThrow("WeCom CLI local disconnect is incomplete.");
    await expect(restarted.run(["calendar", "list"])).rejects.toThrow(
      "WeCom CLI local disconnect is incomplete.",
    );
    expect(start).not.toHaveBeenCalled();
    await restarted.logout();
    await expect(access(credential)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a redirected config directory without reading or removing external credentials", async () => {
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "credentials.enc"), "external sentinel");
    await symlink(external, configDir, "junction");
    const { cli, start } = fixture("throw new Error('unexpected spawn')");
    await expect(cli.logout()).rejects.toThrow(/^WeCom CLI configuration directory is not safe\.$/);
    await expect(cli.status()).rejects.toThrow(/^WeCom CLI configuration directory is not safe\.$/);
    expect(start).not.toHaveBeenCalled();
    expect(await readFile(join(external, "credentials.enc"), "utf8")).toBe("external sentinel");
  });
});
