import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexHomeToml, withCodexHome } from "../src/codex-home.ts";

const config = {
  model: "claude-opus-5-5",
  model_provider: "agentherd",
  model_providers: {
    agentherd: {
      name: "AgentHerd",
      base_url: "https://relay.example/v1",
      env_key: "AGENTHERD_CODEX_KEY",
      wire_api: "responses",
    },
  },
};

describe("Codex home", () => {
  it("names the run's provider as the current one, without a key", () => {
    expect(codexHomeToml(config)).toBe(
      [
        'model_provider = "agentherd"',
        "",
        "[model_providers.agentherd]",
        'name = "AgentHerd"',
        'base_url = "https://relay.example/v1"',
        'env_key = "AGENTHERD_CODEX_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
    );
    expect(() => codexHomeToml({ model_provider: "x" })).toThrow(/no provider/);
  });

  it("sets CODEX_HOME for a run with CODEX_CONFIG, the same directory for the same provider", () => {
    const home = mkdtempSync(join(tmpdir(), "ah-codex-home-"));
    const env = { CODEX_CONFIG: JSON.stringify(config), AGENTHERD_CODEX_KEY: "sk-secret" };
    const a = withCodexHome(home, env);
    const b = withCodexHome(home, { ...env });
    expect(a.CODEX_HOME).toBe(b.CODEX_HOME);
    expect(a.CODEX_HOME?.startsWith(join(home, "run", "codex-"))).toBe(true);
    const file = readFileSync(join(a.CODEX_HOME ?? "", "config.toml"), "utf8");
    expect(file).toContain('model_provider = "agentherd"');
    expect(file).not.toContain("sk-secret");
    expect(withCodexHome(home, { OTHER: "1" })).toEqual({ OTHER: "1" });
  });
});
