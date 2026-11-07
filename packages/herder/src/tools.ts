// The Herder's tools (docs/spec/04-herder.md §1). None of them answers an item, runs a command
// or writes a file.

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HerderHost, OwnerImage, Task } from "@agentherd/core";
import type { AgentTool, AgentToolResult } from "@agentherd/herder-loop";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { agentForModel } from "./agent-models.ts";
import { lessonsText, ownerPrefsText, pastLessons } from "./memory.ts";
import { placeModels, TIERS, type TierPlacement, tiersText } from "./model-guide.ts";
import { findProjects, foundText, nameKey } from "./project-find.ts";
import { composeTaskPrompt, HERDER_LABEL } from "./prompt.ts";

/** What the current Herder turn is about. */
export interface TurnContext {
  kind: "owner" | "answer" | "event";
  /** The owner's words this turn may pass on: the message, or the one the answer belongs to. */
  ownerText: string;
  /**
   * What the owner typed: the message, or for an answer the message it belongs to (a tapped
   * button is not their words). Memory evidence must come from it (ADR 0038).
   */
  typedText: string;
  /** The owner's images this turn; tasks started or messaged for the owner get them. */
  images: OwnerImage[];
  asked: boolean;
  notified: boolean;
  /**
   * Folders the owner typed or picked with a button this turn, and the one project project_find
   * matched by a name in the owner's words (ADR 0043). session_start runs only in one of them
   * (ADR 0035): a folder from earlier turns or the Herder's own guess is never used.
   */
  pickedDirs: string[];
}

/** The answer that lets the owner type their own (ADR 0035). */
/** Whether the owner's words name the project (case, `-`, `_` and spaces ignored). */
export function namedBy(typed: string, name: string): boolean {
  const key = nameKey(name.trim().replace(/^.*[\\/]/, ""));
  return key !== "" && nameKey(typed).includes(key);
}

export function otherOption(locale: string): string {
  return locale === "en" ? "Other" : "其他";
}

// `~`, `/` or a Windows drive (`C:\`) starts a path; it ends at whitespace or punctuation.
const PATH_RE = /(?:^|[\s"'`(（「：])((?:~|\/|[A-Za-z]:[\\/])[^\s"'`)）」，。；;,!?！？]*)/g;

function homePath(raw: string): boolean {
  return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\");
}

/** Absolute and `~/` paths in the owner's words, resolved. */
export function pathsIn(text: string, home: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const raw = (m[1] ?? "").replace(/[.:：]+$/, "");
    if (raw === "" || raw === "/" || !(homePath(raw) || isAbsolute(raw))) continue;
    const dir = homePath(raw) ? resolve(join(home, raw.slice(1))) : resolve(raw);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * The folders an answer to `ask` picks: the whole answer when it is one path (a button can
 * hold a path with spaces, like `项目 2`), and the paths in it.
 */
export function pathsInAnswer(answer: string, home: string): string[] {
  const whole = answer.trim();
  const out = homePath(whole)
    ? [resolve(join(home, whole.slice(1)))]
    : isAbsolute(whole)
      ? [resolve(whole)]
      : [];
  for (const p of pathsIn(answer, home)) if (!out.includes(p)) out.push(p);
  return out;
}

/** Same folder; Windows and macOS paths ignore case. */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `part` appears in `whole`, ignoring whitespace differences. */
export function isVerbatim(part: string, whole: string): boolean {
  const p = normalize(part);
  return p !== "" && normalize(whole).includes(p);
}

/** Open tasks whose id starts with the query, or whose title has every word of it. */
export function findTasks(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  const byId = tasks.filter((t) => t.id.startsWith(q));
  if (byId.length > 0) return byId;
  const words = q.split(/\s+/).filter((w) => w !== "");
  return tasks.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
}

/** A directory from an absolute path or `~/path`. Names go through project_find and the owner. */
export function resolveProject(host: HerderHost, project: string): string {
  const p = project.trim();
  if (homePath(p)) return resolve(join(host.userHome, p.slice(1)));
  if (isAbsolute(p)) return resolve(p);
  throw new Error(
    `"${p}" is not a path; call project_find with the name and ask the owner to pick the folder`,
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function oneTask(host: HerderHost, query: string): Task {
  const matches = findTasks(host.openTasks(), query);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new Error(`no open task matches "${query}"`);
  throw new Error(
    `several open tasks match "${query}": ${matches.map((t) => t.id.slice(0, 8)).join(", ")}`,
  );
}

/** The owner's connected apps, when there are any. */
function appLines(host: HerderHost): string[] {
  const apps = host.apps?.() ?? [];
  if (apps.length === 0) return [];
  return [
    `Connected apps (agents other than Pi use them through their agentherd tools): ${apps.join(", ")}`,
  ];
}

/** The owner's mail watches, when mail can be watched (ADR 0048). */
function mailLines(host: HerderHost): string[] {
  if (host.mailWatches === undefined) return [];
  const watches = host.mailWatches();
  return [
    "Mail watches (AgentHerd tells the owner about new matching mail every few minutes):",
    ...(watches.length === 0
      ? ["(none)"]
      : watches.map(
          (w) => `- ${w.id.slice(0, 8)} "${w.about}" query=${w.query} since=${w.createdAt}`,
        )),
  ];
}

/** A mail watch by id prefix or words of what it is about. */
function oneWatch(host: HerderHost, query: string): { id: string; about: string } {
  const q = normalize(query);
  const watches = host.mailWatches?.() ?? [];
  const found = watches.filter(
    (w) =>
      w.id.startsWith(query.trim()) ||
      normalize(w.about).includes(q) ||
      normalize(w.query).includes(q),
  );
  const only = found[0];
  if (found.length === 1 && only !== undefined) return only;
  if (found.length === 0) throw new Error(`no mail watch matches "${query}"`);
  throw new Error(
    `several mail watches match "${query}": ${found.map((w) => `${w.id.slice(0, 8)} "${w.about}"`).join(", ")}`,
  );
}

/** Ended tasks listed by session_list, newest first. */
export const ENDED_TASKS_LISTED = 15;

/** An open task, or else an ended one (session_prompt starts it again, ADR 0039). */
function anyTask(host: HerderHost, query: string): Task {
  const open = findTasks(host.openTasks(), query);
  if (open.length === 1 && open[0] !== undefined) return open[0];
  if (open.length > 1) return oneTask(host, query);
  const ended = findTasks(
    [...host.tasks()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    query,
  );
  if (ended.length === 1 && ended[0] !== undefined) return ended[0];
  if (ended.length === 0) throw new Error(`no task matches "${query}"`);
  throw new Error(
    `several tasks match "${query}": ${ended
      .slice(0, 5)
      .map((t) => `${t.id.slice(0, 8)} "${t.title}"`)
      .join(", ")}`,
  );
}

function taskLine(t: Task): string {
  return `- ${t.id.slice(0, 8)} [${t.stage}] "${t.title}" project=${t.project} agent=${t.agent} last="${t.lastReport}" updated=${t.updatedAt}`;
}

const sessionStartSchema = obj({
  project: opt(
    str({
      description:
        "Project folder: an absolute or ~/ path the owner typed or picked this turn, or the one project_find matched. Omit for work that needs no project.",
    }),
  ),
  profile: opt(
    str({
      description:
        "Only when the owner names an agent (e.g. dsh). Omit otherwise: AgentHerd picks the agent from the model.",
    }),
  ),
  name: str({
    description:
      'A short name for the task, 4 to 12 words or about 6 to 15 Chinese characters, in the owner\'s language: what the agent does, e.g. "pi-desktop：梳理可做的 issue". Shown on every report.',
  }),
  ownerText: str({ description: "The owner's request, copied exactly from their message" }),
  addedContext: opt(str({ description: "Anything you add, sent below the owner's words" })),
  model: opt(
    str({
      description:
        "Model name from session_list (e.g. deepseek-v4-pro); AgentHerd uses the first service offering it that answers. service/model picks one service. Omit to select from AgentHerd's configured models in tier order.",
    }),
  ),
});
const taskSchema = obj({ task: str({ description: "Task id prefix or words of its title" }) });
const promptSchema = obj({
  task: str({ description: "Task id prefix or words of its title" }),
  text: str({
    description: "Text for the agent; the owner's words copied exactly if they are theirs",
  }),
  name: opt(
    str({ description: "A new short name for the task, only when this changes what it works on" }),
  ),
});
const askSchema = obj({
  question: str(),
  options: arr(str(), { minItems: 1, maxItems: 4 }),
});
const notifySchema = obj({ text: str() });
const findSchema = obj({
  name: str({ description: "The project's name as the owner said it, e.g. pi-desktop" }),
});
const emptySchema = obj({});
const mailWatchSchema = obj({
  about: str({
    description:
      'What the owner wants to hear about, in their words, e.g. "导师的邮件". Shown on every notice.',
  }),
  query: str({
    description:
      "A Gmail search for that mail, e.g. from:prof@uni.edu, subject:offer, is:important, or in:inbox for all new mail.",
  }),
});
const mailUnwatchSchema = obj({
  watch: str({ description: "Mail watch id prefix or words of what it is about" }),
});

export function herderTools(
  host: HerderHost,
  turn: () => TurnContext,
  modelTiers?: () => TierPlacement,
): AgentTool[] {
  const tools = [
    {
      name: "session_list",
      label: "List tasks",
      description: "Tasks (open and ended), agent profiles, models and the active relay.",
      parameters: emptySchema,
      execute: async () => {
        const open = host.openTasks();
        const openIds = new Set(open.map((t) => t.id));
        const ended = host
          .tasks()
          .filter((t) => !openIds.has(t.id))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, ENDED_TASKS_LISTED);
        const lines = [
          "Open tasks:",
          ...(open.length === 0 ? ["(none)"] : open.map(taskLine)),
          "Ended tasks, newest first (kept across restarts; session_prompt continues one in the same folder and model):",
          ...(ended.length === 0 ? ["(none)"] : ended.map(taskLine)),
          `Agents: AgentHerd picks one from the model (GPT models run in Codex, the rest in Pi). Installed: ${host
            .profiles()
            .map((p) => `${p.id} (${p.name})`)
            .join(", ")}`,
          "Models (name: services offering it, in order of preference):",
          ...modelLines(host, modelTiers),
          `Relay: ${host.relayTaskId()?.slice(0, 8) ?? "none"}`,
          ...appLines(host),
          ...mailLines(host),
        ];
        return ok(lines.join("\n"));
      },
    },
    {
      name: "decisions_list",
      label: "Recent decisions",
      description: "Recent approval decisions (by rules or by the owner). Read only.",
      parameters: emptySchema,
      execute: async () => {
        const rows = host.decisions(20);
        if (rows.length === 0) return ok("(no decisions)");
        return ok(
          rows.map((d) => `- ${d.createdAt} ${d.source} ${d.action}: ${d.reason}`).join("\n"),
        );
      },
    },
    {
      name: "session_start",
      label: "Start a task",
      description: "Starts an agent session in a project with the owner's request.",
      parameters: sessionStartSchema,
      execute: async (
        _id: string,
        args: {
          project?: string;
          name: string;
          profile?: string;
          ownerText: string;
          addedContext?: string;
          model?: string;
        },
      ) => {
        const t = turn();
        if (t.kind === "event") throw new Error("tasks start only when the owner asks");
        if (!isVerbatim(args.ownerText, t.ownerText)) {
          throw new Error("ownerText must be the owner's words copied exactly from their message");
        }
        const named = args.profile?.trim() || undefined;
        const ids = host.profiles().map((p) => p.id);
        if (named !== undefined && !ids.includes(named)) {
          throw new Error(`unknown profile "${named}"`);
        }
        const models = host
          .models()
          .filter((m) =>
            named === undefined ? m.agents.includes(agentForModel(m.ref, ids)) : true,
          );
        const tiers = modelTiers?.() ?? placeModels(modelsByName(models).map((m) => m.name));
        const preferred = TIERS.flatMap((tier) => tiers[tier]).find((entry) =>
          models.some(
            (m) =>
              m.ref.slice(m.ref.indexOf("/") + 1) === entry.model &&
              (named === undefined ? m.agents.length > 0 : m.agents.includes(named)),
          ),
        );
        const asked = args.model?.trim() || preferred?.model;
        if (asked === undefined) {
          throw new Error("no configured model can run this task; configure models in AgentHerd");
        }
        const picked = await pickService(host, asked, named, tiers, models);
        const model = picked.ref;
        const profile = named ?? agentForModel(model, ids);
        const given = args.project?.trim() || undefined;
        const cwd = given === undefined ? undefined : resolveProject(host, given);
        if (cwd !== undefined && !t.pickedDirs.some((d) => samePath(d, cwd))) {
          throw new Error(
            `the owner did not pick ${cwd} in this message; call project_find and ask the owner to pick the folder`,
          );
        }
        if (cwd !== undefined && !isDirectory(cwd)) throw new Error(`${cwd} is not a directory`);
        const lessons =
          host.memory === undefined
            ? []
            : await pastLessons(
                host.memory,
                `${args.name.trim()}\n${args.ownerText}`,
                host.embedder,
                host.memoryComplete,
              );
        const added = [
          args.addedContext?.trim() ?? "",
          ownerPrefsText(host.memory),
          lessonsText(lessons),
        ]
          .filter((s) => s !== "")
          .join("\n\n");
        const prompt = composeTaskPrompt(args.ownerText.trim(), added === "" ? undefined : added);
        const title = args.name.trim() || args.ownerText.trim();
        const taskId =
          t.images.length === 0
            ? await host.startTask(profile, cwd, title, prompt, model)
            : await host.startTask(profile, cwd, title, prompt, model, t.images);
        const switched =
          picked?.switched === undefined
            ? ""
            : `\nModel switched: ${picked.switched}. Tell the owner in one line.`;
        const gave =
          lessons.length === 0
            ? ""
            : `\nGave the agent ${lessons.length} past record(s): ${lessons.map((l) => l.abstract).join("; ")}`;
        const where = cwd === undefined ? "a folder of its own (no project)" : cwd;
        return ok(
          `started task ${taskId.slice(0, 8)} in ${where} with ${profile}, ${model}${switched}${gave}`,
        );
      },
    },
    {
      name: "session_prompt",
      label: "Message a task",
      description:
        "Sends text to a task. The owner's words go unchanged; other text is labeled as yours. An ended task (also one from before a restart) is started again in its folder with its model, then gets the text.",
      parameters: promptSchema,
      execute: async (_id: string, args: { task: string; text: string; name?: string }) => {
        const t = turn();
        if (t.kind === "event") throw new Error("only the owner can message tasks; use notify");
        const task = anyTask(host, args.task);
        const verbatim = isVerbatim(args.text, t.ownerText);
        const name = args.name?.trim();
        if (name !== undefined && name !== "") host.renameTask(task.id, name);
        const text = verbatim
          ? `${"[Owner's message]"}\n${args.text.trim()}`
          : `${HERDER_LABEL}\n${args.text.trim()}`;
        if (t.images.length === 0) host.promptTask(task.id, text);
        else host.promptTask(task.id, text, t.images);
        const reopened = host.openTasks().some((o) => o.id === task.id)
          ? ""
          : " (it had ended; AgentHerd starts its agent again first)";
        return ok(
          `sent to ${task.id.slice(0, 8)}${verbatim ? "" : " (labeled as from the Herder)"}${reopened}`,
        );
      },
    },
    {
      name: "session_cancel",
      label: "Cancel a turn",
      description: "Cancels the running turn of a task. The task stays open.",
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can cancel");
        const task = oneTask(host, args.task);
        await host.cancelTurn(task.id);
        return ok(`cancelled the turn of ${task.id.slice(0, 8)}`);
      },
    },
    {
      name: "session_end",
      label: "End a task",
      description:
        'Closes a task for good when the owner says it is finished or no longer wanted ("可以结束了", "不用了"). The agent stops; the task stays in the list as ended and can be continued later with session_prompt. To stop only what it is doing now, use session_cancel.',
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can end a task");
        const task = oneTask(host, args.task);
        await host.endTask(task.id);
        return ok(`ended ${task.id.slice(0, 8)}`);
      },
    },
    {
      name: "relay_start",
      label: "Relay to a task",
      description: "Owner messages go straight to this task until /end.",
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can start a relay");
        const task = oneTask(host, args.task);
        await host.startRelay(task.id);
        return ok(`relay to ${task.id.slice(0, 8)} started`);
      },
    },
    {
      name: "relay_end",
      label: "End the relay",
      description: "Ends the active relay.",
      parameters: emptySchema,
      execute: async () => {
        await host.endRelay();
        return ok("relay ended");
      },
    },
    {
      name: "project_find",
      label: "Find a project",
      description:
        "Finds project folders (git repositories under the owner's home) by name. One project with the name the owner used: start there. Otherwise ask the owner to pick; never pick yourself.",
      parameters: findSchema,
      execute: async (_id: string, args: { name: string }) => {
        const found = findProjects(host.userHome, args.name);
        const t = turn();
        const only = found.exact.length === 1 ? found.exact[0] : undefined;
        // Only a name the owner typed this turn picks a folder by itself (ADR 0043).
        const unique =
          only !== undefined && t.kind !== "event" && namedBy(t.typedText, args.name)
            ? only
            : undefined;
        if (unique !== undefined) t.pickedDirs.push(unique);
        return ok(foundText(args.name, found, unique));
      },
    },
    {
      name: "ask",
      label: "Ask the owner",
      description:
        "Asks the owner one question with suggested answers as buttons; AgentHerd adds an 「其他」 button for typing their own. End your turn after it.",
      parameters: askSchema,
      execute: async (_id: string, args: { question: string; options: string[] }) => {
        const other = otherOption(host.locale);
        const options = args.options.map((o) => o.trim()).filter((o) => o !== "" && o !== other);
        const all = [...options.slice(0, 4), other];
        host.recordTurn("ask", `${args.question}\n${all.map((o) => `- ${o}`).join("\n")}`);
        await host.ask(args.question, all);
        turn().asked = true;
        return ok("asked; the answer comes as a new message");
      },
    },
    {
      name: "notify",
      label: "Tell the owner",
      description: "Sends a short message to the owner.",
      parameters: notifySchema,
      execute: async (_id: string, args: { text: string }) => {
        await host.say(args.text);
        turn().notified = true;
        return ok("sent");
      },
    },
  ];
  const all = tools.map((t) => t as unknown as AgentTool);
  if (host.watchMail !== undefined) {
    all.push(...mailTools(host, turn).map((t) => t as unknown as AgentTool));
  }
  return all;
}

/** Mail watches exist only because the owner asked (ADR 0048). */
function mailTools(host: HerderHost, turn: () => TurnContext) {
  return [
    {
      name: "mail_watch",
      label: "Watch mail",
      description:
        "Only when the owner asks to be told about some mail (e.g. 「导师来邮件提醒我」): from now on AgentHerd checks Gmail every few minutes and tells the owner about new mail matching the search. Never start one on your own.",
      parameters: mailWatchSchema,
      execute: async (_id: string, args: { about: string; query: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can ask for mail watches");
        const watch = await host.watchMail?.(args.about, args.query);
        if (watch === undefined) throw new Error("mail cannot be watched here");
        return ok(
          `watching mail ${watch.id.slice(0, 8)} "${watch.about}" (query: ${watch.query}); tell the owner in one short line`,
        );
      },
    },
    {
      name: "mail_unwatch",
      label: "Stop watching mail",
      description: "Stops a mail watch when the owner no longer wants those notices.",
      parameters: mailUnwatchSchema,
      execute: async (_id: string, args: { watch: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can stop mail watches");
        const watch = oneWatch(host, args.watch);
        host.unwatchMail?.(watch.id);
        return ok(`stopped watching "${watch.about}"`);
      },
    },
  ];
}

/** The owner's models grouped by name: services in list order, agents that can run any of them. */
export function modelsByName(
  models: { ref: string; agents: string[] }[],
): { name: string; refs: string[]; services: string[]; agents: string[] }[] {
  const out = new Map<
    string,
    { name: string; refs: string[]; services: string[]; agents: string[] }
  >();
  for (const m of models) {
    const slash = m.ref.indexOf("/");
    const service = m.ref.slice(0, slash);
    const name = m.ref.slice(slash + 1);
    const entry = out.get(name) ?? { name, refs: [], services: [], agents: [] };
    entry.refs.push(m.ref);
    entry.services.push(service);
    for (const a of m.agents) if (!entry.agents.includes(a)) entry.agents.push(a);
    out.set(name, entry);
  }
  return [...out.values()];
}

/** A model to run and, when it is not the one asked for, why it was swapped. */
export interface PickedModel {
  ref: string;
  /** Set when AgentHerd moved away from what was asked; the Herder tells the owner. */
  switched?: string;
}

/**
 * The `service/model` to run. Tries, in order, each answering a test call first: what was asked
 * (one service, or every service offering the name), other services offering the same name, the
 * other models of its tier, then the other tiers. Only models the agent can run count.
 */
/**
 * Refs to try for `asked`, in order: `asked` itself (one service, or every service offering the
 * name), other services offering the same name, the other models of its tier, then the other
 * tiers. Only models `profile` can run; with no profile, any model an agent can run (AgentHerd then
 * picks the agent from the model, ADR 0031). Throws when the name is unknown or nothing can run it.
 */
export function fallbackOrder(
  models: readonly { ref: string; agents: string[] }[],
  asked: string,
  profile: string | undefined,
  tiers?: TierPlacement,
): string[] {
  const nameOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
  const exact = models.find((m) => m.ref === asked);
  const name = exact !== undefined ? nameOf(exact.ref) : asked;
  const same = models.filter((m) => nameOf(m.ref) === name);
  if (same.length === 0) throw new Error(`unknown model "${asked}"; see session_list`);
  const runs = (m: { agents: string[] } | undefined) =>
    m !== undefined && (profile === undefined ? m.agents.length > 0 : m.agents.includes(profile));
  if (!same.some(runs)) {
    const can = [...new Set(same.flatMap((m) => m.agents))].join(", ") || "no agent";
    throw new Error(
      `${profile === undefined ? "no agent" : `agent "${profile}"`} cannot run ${asked} (can: ${can})`,
    );
  }
  const order: string[] = [];
  const add = (ref: string) => {
    if (!order.includes(ref)) order.push(ref);
  };
  if (exact !== undefined) add(exact.ref);
  for (const m of same) add(m.ref);
  const byName = (n: string) => models.filter((m) => nameOf(m.ref) === n).map((m) => m.ref);
  if (tiers !== undefined) {
    const home = TIERS.find((t) => tiers[t].some((e) => e.model === name));
    const rest = TIERS.filter((t) => t !== home);
    for (const tier of home === undefined ? rest : [home, ...rest]) {
      for (const e of tiers[tier]) for (const ref of byName(e.model)) add(ref);
    }
  }
  return order.filter((ref) => runs(models.find((m) => m.ref === ref)));
}

async function pickService(
  host: HerderHost,
  asked: string,
  profile: string | undefined,
  tiers: TierPlacement | undefined,
  models: ReturnType<HerderHost["models"]>,
): Promise<PickedModel> {
  const runnable = fallbackOrder(models, asked, profile, tiers);
  const failures: string[] = [];
  for (const ref of runnable) {
    const check = await host.checkModel(ref);
    if (check.ok) {
      if (failures.length === 0) return { ref };
      return { ref, switched: `${failures.join("; ")}; switched to ${ref}` };
    }
    failures.push(`${ref} failed (${check.message})`);
  }
  throw new Error(`no model answers: ${failures.join("; ")}`);
}

function modelLines(host: HerderHost, modelTiers?: () => TierPlacement): string[] {
  const models = modelsByName(host.models());
  if (models.length === 0) return ["(none; configure models in AgentHerd before starting a task)"];
  const lines = models.map(
    (m) =>
      `- ${m.name}: ${m.services.join(", ")}${m.agents.length === 0 ? " (no agent can run it)" : ""}`,
  );
  const placement = modelTiers?.();
  const guide = placement === undefined ? "" : tiersText(placement);
  if (guide) lines.push(guide);
  return lines;
}
