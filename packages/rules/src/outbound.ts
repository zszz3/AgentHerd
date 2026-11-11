// Leaving the Mac (ADR 0056): a step whose effect goes out of the owner's computer always asks
// the owner, unless the owner allowed that step for the task. Local work never asks.
// Coarse on purpose: a false hit costs one tap; a miss can push to production or speak for the
// owner.

import type { ToolCallInfo } from "@agentherd/protocol";
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
  if (program === "lark-cli" && args.some((w) => /^\+?(send|reply|forward)/.test(w))) {
    return hit("send", "sends a message");
  }
  return undefined;
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
