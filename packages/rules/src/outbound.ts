// Leaving the Mac (ADR 0056): a step whose effect goes out of the owner's computer always asks
// the owner, unless the owner allowed that step for the task. Local work never asks.
// Coarse on purpose: a false hit costs one tap; a miss can push to production or speak for the
// owner.

import type { ToolCallInfo } from "@agentherd/protocol";
import { type PathContext, resolveWord } from "./paths.ts";
import { basename, programWords, splitCommand, UnparsedCommandError } from "./shell.ts";

/** Kinds of steps that leave the Mac. The owner can allow each for one task. */
export const OUTBOUND_STEPS = [
  "push",
  "pull-request",
  "merge",
  "comment",
  "publish",
  "deploy",
  "send",
  "edit",
] as const;
export type OutboundStep = (typeof OUTBOUND_STEPS)[number];

export interface OutboundResult {
  step: OutboundStep;
  /** English, short: what the command does. */
  reason: string;
}

const hit = (step: OutboundStep, reason: string): OutboundResult => ({ step, reason });

/** Subcommand words: the arguments that are not options. */
const plain = (args: readonly string[]) => args.filter((w) => !w.startsWith("-"));

function gh(args: readonly string[]): OutboundResult | undefined {
  const [group, verb] = plain(args);
  if (group === "pr") {
    if (verb === "create") return hit("pull-request", "opens a pull request");
    if (verb === "merge") return hit("merge", "merges a pull request");
    if (verb === "comment" || verb === "review")
      return hit("comment", "comments on a pull request");
    if (verb === "close" || verb === "edit" || verb === "ready" || verb === "reopen") {
      return hit("pull-request", "changes a pull request");
    }
  }
  if (group === "issue") {
    if (verb === "comment") return hit("comment", "comments on an issue");
    if (["create", "close", "edit", "reopen", "delete", "transfer"].includes(verb ?? "")) {
      return hit("comment", "changes an issue");
    }
  }
  if (group === "release" && ["create", "edit", "upload", "delete"].includes(verb ?? "")) {
    return hit("publish", "publishes a release");
  }
  if (group === "repo" && ["create", "delete", "edit", "rename", "archive"].includes(verb ?? "")) {
    return hit("publish", "changes a repository on GitHub");
  }
  if (group === "gist" && verb === "create") return hit("publish", "publishes a gist");
  if (group === "workflow" && verb === "run") return hit("deploy", "runs a GitHub workflow");
  if (group === "api") {
    // `gh api` only reads unless it sends a method or fields.
    const writes = args.some(
      (w, i) =>
        ((w === "-X" || w === "--method") && !/^get$/i.test(args[i + 1] ?? "")) ||
        /^--method=(?!get$)/i.test(w) ||
        ["-f", "-F", "--field", "--raw-field", "--input"].includes(w),
    );
    if (writes) return hit("comment", "writes to GitHub through its API");
  }
  return undefined;
}

function git(args: readonly string[]): OutboundResult | undefined {
  // `git -C dir push`: skip global options and their values.
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    i += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[i] as string) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === "push") return hit("push", "pushes to a remote");
  if (sub === "send-email") return hit("send", "sends mail");
  if (sub === "svn" && args[i + 1] === "dcommit") return hit("push", "pushes to a remote");
  return undefined;
}

const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function segmentHit(words: readonly string[]): OutboundResult | undefined {
  const program = basename(words[0] ?? "");
  const args = words.slice(1);
  const sub = plain(args);
  if (program === "git") return git(args);
  if (program === "gh") return gh(args);
  if (PUBLISHERS.has(program) && sub[0] === "publish") return hit("publish", "publishes a package");
  if (program === "yarn" && sub[0] === "npm" && sub[1] === "publish") {
    return hit("publish", "publishes a package");
  }
  if (program === "cargo" && sub[0] === "publish") return hit("publish", "publishes a crate");
  if (program === "twine" && sub[0] === "upload") return hit("publish", "publishes a package");
  if ((program === "poetry" || program === "uv" || program === "hatch") && sub[0] === "publish") {
    return hit("publish", "publishes a package");
  }
  if (program === "gem" && sub[0] === "push") return hit("publish", "publishes a gem");
  if (program === "docker" && sub[0] === "push") return hit("publish", "pushes an image");
  if (program === "vercel" || program === "netlify" || program === "flyctl" || program === "fly") {
    if (sub[0] === undefined || ["deploy", "--prod", "promote"].includes(sub[0])) {
      return hit("deploy", "deploys");
    }
  }
  if (
    program === "kubectl" &&
    ["apply", "delete", "rollout", "scale", "set"].includes(sub[0] ?? "")
  ) {
    return hit("deploy", "changes a cluster");
  }
  if (program === "helm" && ["install", "upgrade", "uninstall"].includes(sub[0] ?? "")) {
    return hit("deploy", "changes a cluster");
  }
  if (program === "terraform" && (sub[0] === "apply" || sub[0] === "destroy")) {
    return hit("deploy", "changes infrastructure");
  }
  if (program === "wrangler" && (sub[0] === "deploy" || sub[0] === "publish")) {
    return hit("deploy", "deploys");
  }
  if (program === "firebase" && sub[0] === "deploy") return hit("deploy", "deploys");
  if ((program === "mail" || program === "sendmail" || program === "mutt") && args.length > 0) {
    return hit("send", "sends mail");
  }
  if (program === "lark-cli") return larkCli(args);
  return undefined;
}

/** lark-cli verbs that only read (ADR 0059). Anything else writes. */
const LARK_READ =
  /^\+?(agenda|get|list|search|fetch|freebusy|suggestion|room-find|meeting|query|view|info|detail|read|export|download|preview|status|history-list|primary|instance_view|share_info)([-_].*)?$|-(download|preview|list|get|search)$/;
/** Files a new one of which lands in the owner's own space: making one passes. */
const LARK_NEW_FILE = new Set(["docs", "markdown", "sheets", "slides", "mindnotes", "base"]);
const LARK_LOCAL = new Set(["auth", "config", "schema", "skills", "help", "version", "completion"]);
const LARK_SENDS = new Set(["im", "mail", "calendar", "vc", "approval"]);

/** The official Feishu CLI (ADR 0059): reads and new files of the owner's pass; the rest asks. */
function larkCli(args: readonly string[]): OutboundResult | undefined {
  if (args.some((w) => w === "--help" || w === "-h" || w === "--dry-run")) return undefined;
  const sub = plain(args);
  const domain = sub[0];
  if (domain === undefined || LARK_LOCAL.has(domain)) return undefined;
  if (domain === "api") {
    return /^get$/i.test(sub[1] ?? "")
      ? undefined
      : hit("edit", "writes to Feishu through its API");
  }
  // `docs +fetch`, `calendar events create`: the verb is the last plain word that is not a value.
  const verbs = sub.slice(1, 3);
  if (
    verbs.length > 0 &&
    verbs.every((w) => !w.startsWith("+")) &&
    LARK_READ.test(verbs.at(-1) ?? "")
  ) {
    return undefined;
  }
  const verb = verbs.find((w) => w.startsWith("+")) ?? verbs.at(-1) ?? "";
  if (LARK_READ.test(verb)) return undefined;
  if (LARK_NEW_FILE.has(domain) && /^\+?create$/.test(verb)) return undefined;
  if (LARK_SENDS.has(domain)) return hit("send", `changes Feishu ${domain} for the owner`);
  return hit("edit", `changes Feishu ${domain}`);
}

/** Whether a tool call's effect leaves the owner's Mac, and which kind of step it is. */
export function outboundCheck(call: ToolCallInfo): OutboundResult | undefined {
  if (call.kind === "app") return appOutbound(call.command ?? "");
  if (call.command === undefined || call.command.trim() === "") return undefined;
  let segments: ReturnType<typeof splitCommand>;
  try {
    segments = splitCommand(call.command);
  } catch (error) {
    if (!(error instanceof UnparsedCommandError)) throw error;
    // A command we cannot read: ask only when it mentions a step that leaves the Mac.
    if (/\bgit\b[^\n]*\bpush\b/.test(call.command)) return hit("push", "pushes to a remote");
    if (/\bgh\s+pr\s+merge\b/.test(call.command)) return hit("merge", "merges a pull request");
    if (/\bpublish\b/.test(call.command)) return hit("publish", "publishes");
    return undefined;
  }
  for (const segment of segments) {
    const found = segmentHit(programWords(segment.words));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** App tools (Composio slugs such as GMAIL_SEND_EMAIL) that speak or publish for the owner. */
export function appOutbound(slug: string): OutboundResult | undefined {
  const s = slug.toUpperCase();
  if (/MERGE/.test(s)) return hit("merge", "merges");
  if (/(^|_)(SENDS?|REPLY|FORWARD|POSTS?|TWEET|PUBLISH|COMMENT|INVITE|SHARE)(_|$)/.test(s)) {
    return hit(
      /PUBLISH/.test(s) ? "publish" : /COMMENT/.test(s) ? "comment" : "send",
      "speaks for the owner",
    );
  }
  // A like, save or follow shows under the owner's name too (小红书 / 知乎, ADR 0058).
  if (/(^|_)(LIKE|FAVORITE|FOLLOW|UPVOTE|VOTE_UP)(_|$)/.test(s)) {
    return hit("comment", "acts in public for the owner");
  }
  if (/CREATE_(A_)?PULL_REQUEST|CREATE_(AN_)?ISSUE/.test(s)) {
    return hit(/PULL/.test(s) ? "pull-request" : "comment", "writes on GitHub");
  }
  return undefined;
}

/** What one `git push` updates on the remote (ADR 0064). */
export interface PushPlan {
  /** Where it runs, after `cd` and `git -C`; null when that is unknown. */
  dir: string | null;
  /** Remote branches named on the command line. */
  branches: string[];
  /** It sends the branch checked out where it runs: no refspec, or `HEAD`. */
  current: boolean;
  /** Set when it does more than update branches by name: what else it does. */
  wide?: string;
}

/** Push options that do more than update the named branches. */
const PUSH_WIDE: Record<string, string> = {
  "--all": "pushes every branch",
  "--branches": "pushes every branch",
  "--mirror": "mirrors every ref",
  "--tags": "pushes tags",
  "--follow-tags": "pushes tags",
  "--delete": "deletes on the remote",
  "-d": "deletes on the remote",
  "--prune": "deletes remote branches",
  "--repo": "names the remote with --repo",
};
/** Push options whose value is the next word. */
const PUSH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

function gitPush(args: readonly string[], here: string | null, ctx: PathContext): PushPlan | null {
  let dir = here;
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const w = args[i] as string;
    if (w === "-C") {
      dir = dir === null ? null : resolveWord(args[i + 1] ?? "", { ...ctx, cwd: dir });
      i += 2;
      continue;
    }
    if (w === "-c" || w === "--git-dir" || w === "--work-tree") {
      if (w !== "-c") dir = null;
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=") || w.startsWith("--work-tree=")) dir = null;
    i += 1;
  }
  if (args[i] !== "push") return null;
  const plan: PushPlan = { dir, branches: [], current: false };
  const positional: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    const w = args[j] as string;
    if (w === "--") {
      positional.push(...args.slice(j + 1));
      break;
    }
    if (!w.startsWith("-")) {
      positional.push(w);
      continue;
    }
    const wide =
      PUSH_WIDE[w.split("=")[0] as string] ??
      (/^-[a-zA-Z]{2,}$/.test(w) && w.includes("d") ? PUSH_WIDE["-d"] : undefined);
    if (wide !== undefined) plan.wide ??= wide;
    if (PUSH_VALUE.has(w)) j += 1;
  }
  // The first plain word is the remote; the rest are refspecs.
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) plan.current = true;
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, "");
    if (s === "HEAD" || s === "@") {
      plan.current = true;
      continue;
    }
    const colon = s.lastIndexOf(":");
    if (colon === 0) {
      plan.wide ??= "deletes on the remote";
      continue;
    }
    const name = (colon === -1 ? s : s.slice(colon + 1)).replace(/^refs\/heads\//, "");
    if (name === "" || name === "HEAD" || name.startsWith("refs/") || name.includes("*")) {
      plan.wide ??= `pushes ${spec}`;
      continue;
    }
    plan.branches.push(name);
  }
  return plan;
}

/**
 * The `git push` commands in a command line and where each goes (ADR 0064); undefined when the
 * line cannot be read.
 */
export function pushPlans(command: string, ctx: PathContext): PushPlan[] | undefined {
  let segments: ReturnType<typeof splitCommand>;
  try {
    segments = splitCommand(command);
  } catch (error) {
    if (error instanceof UnparsedCommandError) return undefined;
    throw error;
  }
  let here: string | null = ctx.cwd;
  const plans: PushPlan[] = [];
  for (const segment of segments) {
    const words = programWords(segment.words);
    const program = basename(words[0] ?? "");
    const args = words.slice(1);
    if (program === "cd") {
      here = here === null ? null : resolveWord(args[0] ?? "~", { ...ctx, cwd: here });
      continue;
    }
    if (program !== "git") continue;
    const plan = gitPush(args, here, ctx);
    if (plan !== null) plans.push(plan);
  }
  return plans;
}

/** Words that ask for a step (ADR 0064). Coarse: they only show the owner said something like it. */
const STEP_WORDS: Record<OutboundStep, RegExp> = {
  push: /推(?!荐|进|理|断|测|广|迟|敲|动|导|论|销|算|翻|开|卸|辞|出|移|演|举|行|崇)|push|上传到\s*(github|gitlab|远程)/gi,
  "pull-request": /(?<![a-z])prs?(?![a-z])|pull[\s-]?requests?|合并请求|拉取请求/gi,
  merge: /合并(?!请求)|合入|合进|合到|merge(?![\s-]?requests?)/gi,
  comment: /评论|回复|留言|回帖|答复|点赞|赞同|关掉|关闭|review|comment|reply/gi,
  publish: /发布|发版|发包|上架|publish|release/gi,
  deploy: /部署|上线|deploy/gi,
  send: /发(给|送|邮件|消息|信息|微信|飞书|私信)|邮件|私信|转发|e-?mail|mail|send|forward/gi,
  edit: /文档|表格|日程|日历|会议|知识库|notion|wiki|(?<![a-z])docs?(?![a-z])|sheets?|calendar/gi,
};

/** A word right before a match that says not to (「别合并」, "don't push"). */
const NEGATED =
  /(不要|不用|不必|无需|没有|不|别|勿|没|don't|do not|never|not|no)\s*(开个?|提个?|发个?|去|再)?\s*$/i;

/**
 * The steps leaving the Mac that these words ask for (ADR 0064). A step the Herder allows for a
 * task must be one of them, in the owner's words or in a decision they kept.
 */
export function stepsSaidIn(text: string): OutboundStep[] {
  const found: OutboundStep[] = [];
  for (const step of OUTBOUND_STEPS) {
    for (const m of text.matchAll(STEP_WORDS[step])) {
      if (!NEGATED.test(text.slice(Math.max(0, m.index - 6), m.index))) {
        found.push(step);
        break;
      }
    }
  }
  return found;
}
