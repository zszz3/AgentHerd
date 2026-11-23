import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentEnv,
  availableProfiles,
  codexAppClis,
  codexPackageRoots,
  commandCandidates,
  findAgent,
  localClaude,
  nativeClaude,
  resolveProfile,
  searchPath,
} from "../src/profiles.ts";

describe("findAgent", () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it("prefers AGENTHERD_CODEX", () => {
    expect(
      findAgent(
        "codex",
        { AGENTHERD_CODEX: "/x/codex-acp", PATH: "/usr/bin" },
        has("/usr/bin/codex-acp"),
        "darwin",
      ),
    ).toBe("/x/codex-acp");
  });
  it("reads Path case-insensitively from plain env objects on Windows", () => {
    expect(findAgent("pi", { Path: "C:\\Tools" }, has("C:\\Tools\\pi.cmd"), "win32")).toBe(
      "C:\\Tools\\pi.cmd",
    );
  });
  it("then searches PATH in order", () => {
    expect(findAgent("codex", { PATH: "/a:/b" }, has("/b/codex-acp"), "darwin")).toBe(
      "/b/codex-acp",
    );
  });
  it("returns undefined when it is not installed", () => {
    expect(findAgent("codex", { PATH: "" }, has(), "darwin")).toBeUndefined();
  });
  it("finds Claude Code's adapter, and knows no DSH (ADR 0067, 0069)", () => {
    expect(findAgent("claude", { PATH: "/b" }, has("/b/claude-agent-acp"), "darwin")).toBe(
      "/b/claude-agent-acp",
    );
    expect(findAgent("dsh", { PATH: "/b" }, has("/b/dsh"), "darwin")).toBeUndefined();
  });
});

describe("resolveProfile", () => {
  it("builds the Codex profile in read-only mode", () => {
    const p = resolveProfile("codex", {
      configured: [],
      find: (id) => (id === "codex" ? "/x/codex-acp" : undefined),
      agentEnv: () => ({}),
    });
    expect(p.command).toEqual(["/x/codex-acp"]);
    expect(p.env).toEqual({ INITIAL_AGENT_MODE: "read-only", NO_BROWSER: "1" });
  });
  it("lets a config.json profile replace a built-in one", () => {
    const mine = { id: "codex", name: "Mine", command: ["codex-acp"], env: {}, exporter: null };
    expect(resolveProfile("codex", { configured: [mine], find: () => undefined })).toBe(mine);
  });
  it("explains how to get Codex when it is missing", () => {
    expect(() => resolveProfile("codex", { configured: [], find: () => undefined })).toThrow(
      /AGENTHERD_CODEX/,
    );
  });
  it("requires a script for the mock profile", () => {
    expect(() => resolveProfile("mock", { configured: [] })).toThrow(/--script/);
    expect(resolveProfile("mock", { configured: [], script: "/s.yaml" }).command).toContain(
      "/s.yaml",
    );
  });
  it("lists known profiles for an unknown id", () => {
    expect(() => resolveProfile("dsh", { configured: [] })).toThrow(
      /known: mock, pi, codex, claude, antigravity\)/,
    );
  });
});

describe("availableProfiles", () => {
  it("lists configured profiles, then installed agents, then mock with a script", () => {
    const custom = { id: "x", name: "X", command: ["x"], env: {}, exporter: null };
    const ids = availableProfiles({
      configured: [custom],
      script: "/s.yaml",
      find: (id) => (id === "codex" ? "/bin/codex-acp" : undefined),
      agentEnv: () => ({}),
    }).map((p) => p.id);
    expect(ids).toEqual(["x", "codex", "mock"]);
  });

  it("skips agents that are not installed and mock without a script", () => {
    expect(availableProfiles({ configured: [], find: () => undefined })).toEqual([]);
  });

  it("a configured profile wins over the built-in one", () => {
    const mine = { id: "codex", name: "My Codex", command: ["d"], env: {}, exporter: null };
    const list = availableProfiles({
      configured: [mine],
      find: (id) => (id === "codex" ? "/bin/codex-acp" : undefined),
      agentEnv: () => ({}),
    });
    expect(list).toEqual([mine]);
  });
});

describe("pi", () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it("finds Pi from AGENTHERD_PI, then PATH", () => {
    expect(findAgent("pi", { AGENTHERD_PI: "/x/pi", PATH: "/b" }, has("/b/pi"), "darwin")).toBe(
      "/x/pi",
    );
    expect(findAgent("pi", { PATH: "/a:/b" }, has("/b/pi"), "darwin")).toBe("/b/pi");
    expect(findAgent("pi", { PATH: "/a" }, has(), "darwin")).toBeUndefined();
  });

  it("runs Pi behind the bundled bridge, with the chosen model in env", () => {
    const p = resolveProfile("pi", {
      configured: [],
      find: () => "/b/pi",
      piModelEnv: { AGENTHERD_PI_MODEL: "{}", AGENTHERD_PI_KEY: "k" },
    });
    expect(p.command.slice(1)).toEqual([
      expect.stringMatching(/pi-acp[\\/]bin[\\/]pi-acp\.ts$/),
      "--pi",
      "/b/pi",
    ]);
    expect(p.env).toMatchObject({ AGENTHERD_PI_MODEL: "{}", AGENTHERD_PI_KEY: "k" });
  });

  it("explains where to get Pi", () => {
    expect(() => resolveProfile("pi", { configured: [], find: () => undefined })).toThrow(
      /desktop app.*AGENTHERD_PI/,
    );
  });

  it("is listed before Codex", () => {
    const ids = availableProfiles({
      configured: [],
      find: (id) => ({ codex: "/bin/codex-acp", pi: "/bin/pi" })[id],
      agentEnv: () => ({}),
    }).map((p) => p.id);
    expect(ids).toEqual(["pi", "codex"]);
  });
});

describe("findAgent on Windows", () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);
  const PATH = "C:\\a;C:\\nodejs";

  it("finds npm's .cmd shim, not the shell script beside it", () => {
    const found = findAgent(
      "codex",
      { PATH },
      has("C:\\nodejs\\codex-acp", "C:\\nodejs\\codex-acp.cmd"),
      "win32",
    );
    expect(found).toBe("C:\\nodejs\\codex-acp.cmd");
  });
  it("finds an .exe", () => {
    expect(findAgent("pi", { PATH }, has("C:\\a\\pi.exe"), "win32")).toBe("C:\\a\\pi.exe");
  });
});

describe("Codex app on Windows", () => {
  // `reg query HKCU\...\AppModel\Repository\Packages /s /v PackageRootFolder`, shortened.
  const KEY =
    "HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
  const OUTPUT = [
    "",
    `${KEY}\\Microsoft.WindowsCalculator_11.2502.2.0_x64__8wekyb3d8bbwe`,
    "    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2502.2.0_x64__8wekyb3d8bbwe",
    "",
    `${KEY}\\OpenAI.Codex_26.927.100.0_x64__2p2nqsd0c76g0`,
    "    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.927.100.0_x64__2p2nqsd0c76g0",
    "",
    `${KEY}\\OpenAI.Codex_26.1027.6604.0_x64__2p2nqsd0c76g0`,
    "    PackageRootFolder    REG_SZ    D:\\Apps\\OpenAI.Codex_26.1027.6604.0_x64__2p2nqsd0c76g0",
    "",
    "End of search: 3 match(es) found.",
  ].join("\r\n");
  const NEW = "D:\\Apps\\OpenAI.Codex_26.1027.6604.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe";

  it("reads the app's package folders, newest first", () => {
    expect(codexPackageRoots(OUTPUT)).toEqual([
      "D:\\Apps\\OpenAI.Codex_26.1027.6604.0_x64__2p2nqsd0c76g0",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.927.100.0_x64__2p2nqsd0c76g0",
    ]);
  });
  it("points at the CLI inside each folder", () => {
    expect(codexAppClis("win32", () => OUTPUT)[0]).toBe(NEW);
    expect(codexAppClis("darwin", () => OUTPUT)).toEqual([]);
    expect(
      codexAppClis("win32", () => {
        throw new Error("ERROR");
      }),
    ).toEqual([]);
  });
  it("hands the first installed CLI to codex-acp unless CODEX_PATH is set", () => {
    const clis = () => ["C:\\gone\\codex.exe", NEW];
    const exists = (p: string) => p === NEW;
    expect(agentEnv("codex", {}, exists, "win32", clis)).toEqual({ CODEX_PATH: NEW });
    expect(agentEnv("codex", { CODEX_PATH: "C:\\mine.exe" }, exists, "win32", clis)).toEqual({});
    expect(agentEnv("codex", {}, () => false, "win32", clis)).toEqual({});
    expect(agentEnv("dsh", {}, exists, "win32", clis)).toEqual({});
  });
  it("puts it in the Codex profile", () => {
    const profiles = availableProfiles({
      configured: [],
      find: (id) => (id === "codex" ? "C:\\rt\\codex-acp\\dist\\index.js" : undefined),
      agentEnv: (id): Record<string, string> => (id === "codex" ? { CODEX_PATH: NEW } : {}),
    });
    expect(profiles.map((p) => p.id)).toEqual(["codex"]);
    expect(profiles[0]?.env).toMatchObject({ CODEX_PATH: NEW, INITIAL_AGENT_MODE: "read-only" });
  });
});

describe("commandCandidates", () => {
  it("tries each PATHEXT extension on Windows", () => {
    expect(commandCandidates("C:\\b", "pi", "win32", ".EXE;.CMD")).toEqual([
      "C:\\b\\pi.exe",
      "C:\\b\\pi.cmd",
    ]);
  });
  it("keeps a name that already has an extension", () => {
    expect(commandCandidates("C:\\b", "pi.exe", "win32", ".EXE;.CMD")).toEqual(["C:\\b\\pi.exe"]);
  });
  it("uses the bare name elsewhere", () => {
    expect(commandCandidates("/b", "pi", "linux")).toEqual(["/b/pi"]);
  });
});

describe("searchPath", () => {
  it("keeps PATH and adds the usual install folders without duplicates on POSIX", () => {
    const path = searchPath(
      { PATH: ["/usr/bin", "/opt/homebrew/bin"].join(posix.delimiter) },
      "darwin",
      "/Users/me",
    ).split(posix.delimiter);
    expect(path.slice(0, 2)).toEqual(["/usr/bin", "/opt/homebrew/bin"]);
    expect(path).toContain("/usr/local/bin");
    expect(path.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("includes Windows npm, pnpm, scoop, and nodejs dirs and reads Path case-insensitively", () => {
    const path = searchPath(
      {
        Path: ["C:\\Tools", "C:\\Users\\me\\AppData\\Roaming\\npm"].join(win32.delimiter),
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      "win32",
      "C:\\Users\\me",
    ).split(win32.delimiter);
    expect(path[0]).toBe("C:\\Tools");
    expect(path).toContain("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(path).toContain("C:\\Users\\me\\AppData\\Local\\pnpm");
    expect(path).toContain("C:\\Users\\me\\scoop\\shims");
    expect(path).toContain("C:\\Program Files\\nodejs");
    expect(path.filter((d) => d === "C:\\Users\\me\\AppData\\Roaming\\npm")).toHaveLength(1);
  });
});

describe("localClaude", () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it("finds POSIX Claude CLI paths even when tested from Windows", () => {
    expect(localClaude({}, has("/Users/me/.local/bin/claude"), "darwin", "/Users/me")).toBe(
      "/Users/me/.local/bin/claude",
    );
  });

  it("finds Windows native Claude CLI install locations", () => {
    expect(
      localClaude({}, has("C:\\Users\\me\\.local\\bin\\claude.exe"), "win32", "C:\\Users\\me"),
    ).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(
      localClaude(
        { LOCALAPPDATA: "D:\\Local" },
        has("D:\\Local\\Programs\\claude\\claude.exe"),
        "win32",
        "C:\\Users\\me",
      ),
    ).toBe("D:\\Local\\Programs\\claude\\claude.exe");
  });

  it("starts the exe behind npm's shim on Windows", () => {
    // `spawn` cannot start a .cmd without a shell, so the owner's own CLI has to be the exe.
    const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
    const shim = `${dir}\\claude.cmd`;
    const exe = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(localClaude({ PATH: dir }, has(shim, exe), "win32", "C:\\Users\\me")).toBe(exe);
    // No exe beside the shim (another install layout): the shim is still what there is.
    expect(localClaude({ PATH: dir }, has(shim), "win32", "C:\\Users\\me")).toBe(shim);
    // An exe on PATH is already startable and stays as it is.
    expect(nativeClaude("C:\\tools\\claude.exe", () => true)).toBeUndefined();
  });
});
