import { expect, it } from "vitest";
import { bundledAgents } from "../scripts/fetch-agents.ts";

it("only stages agents with a maintained release that ship by default", () => {
  expect(bundledAgents().map(({ id }) => id)).toEqual(["pi", "codex"]);
});
