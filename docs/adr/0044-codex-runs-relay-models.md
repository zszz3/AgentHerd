# ADR 0044: Codex runs any model of the owner's own OpenAI-compatible services

- Status: Accepted
- Date: 2026-11-07
- Amends: [ADR 0031](0031-pick-the-agent-from-the-model.md)

## Context

ADR 0031 let Codex run only GPT models, because Codex speaks only the Responses API and most
non-OpenAI endpoints offer Chat Completions alone. The owner wants every agent to run the models
in their AgentHerd list ("继续逐个适配：先放宽 Codex"). Their relay (`api.blueberrys.site`) answers
`POST /v1/responses`, streamed and not, for `claude-opus-5-5` and `gemini-3.8-flash`; relays of
this kind usually translate Responses for every model they carry.

Running Codex with such a model showed a second problem: the Codex CLI in the ChatGPT app (0.166)
refuses the turn with `modelProviderMismatch` — "This chat uses agentherd, but your current
provider is openai" — when the thread's provider (from `CODEX_CONFIG`) differs from the global
config's. codex-acp passes no `-c` options to `codex app-server` except hooks.

## Decision

- `codexCanRun(model)` (`packages/herder/src/agent-models.ts`): models on `openai-responses`;
  models on `openai-completions` that are GPT models or belong to a service pi-ai does not know
  (the owner's own OpenAI-compatible services). Built-in non-OpenAI providers (DeepSeek, Moonshot…)
  and Anthropic-format services stay Pi-only.
- The default agent does not change: GPT → Codex, the rest → Pi. Codex runs another model when the
  owner or the Herder names `codex`.
- Codex runs with a model get `CODEX_HOME=<home>/run/codex-<sha16>`, whose `config.toml` sets
  `model_provider = "agentherd"` and the same provider table (`packages/host/src/codex-home.ts`).
  It holds no key. These runs do not see the owner's own Codex sign-in, skills or MCP servers.
- A relay without Responses still fails the first turn, and the task moves to Pi (ADR 0031).

## Consequences

- Checked on Windows with codex-acp 2.5.0 and the ChatGPT app's Codex: `claude/claude-opus-5-5`
  and `gemini/gemini-3.8-flash` both answered. Codex warns "Model metadata for … not found" and
  uses fallback metadata.
- Codex sessions of these runs live under the AgentHerd home, one directory per provider; resuming
  a task with the same model finds them.
