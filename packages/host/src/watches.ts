// Everything AgentHerd watches, as the app's 「监听」 list shows it (ADR 0058): pull requests
// tasks opened, mail watches, new GitHub work, and the owner's platforms. Pausing keeps a watch
// but stops looking; platform watches are switched off instead of removed.

import {
  GITHUB_POLL_MINUTES,
  type Herd,
  INTAKE_POLL_MINUTES,
  MAIL_POLL_MINUTES,
  prKey,
  SOCIAL_KINDS,
  SOCIAL_POLL_MINUTES,
  type SocialKind,
} from "@agentherd/core";
import type { SocialPlatform, SocialView, WatchView } from "./api.ts";

const SOCIAL_LABELS: Record<SocialPlatform, Record<SocialKind, string>> = {
  xiaohongshu: { mentions: "评论和@", likes: "赞和收藏", follows: "新增关注" },
  zhihu: { mentions: "评论、回答和@", likes: "赞同和喜欢", follows: "新增关注" },
};

export function watchViews(herd: Herd, socials: SocialView[]): WatchView[] {
  const { store } = herd;
  const out: WatchView[] = [];
  for (const w of store.prWatches()) {
    const title = store.task(w.taskId)?.task.title;
    out.push({
      id: `pr:${prKey(w)}`,
      kind: "pr",
      title: `${w.repo.split("/")[1] ?? w.repo} #${w.number}${title ? ` ${title}` : ""}`,
      detail: `${w.closed === undefined ? "CI、评审和合并" : w.closed === "merged" ? "已合并，还看评论" : "已关闭，还看评论"}，每 ${GITHUB_POLL_MINUTES} 分钟看一次`,
      paused: w.paused === true,
      removable: true,
      createdAt: w.createdAt,
      activeAt: w.activeAt,
    });
  }
  for (const w of store.mailWatches()) {
    out.push({
      id: `mail:${w.id}`,
      kind: "mail",
      title: w.about,
      detail: `Gmail（${w.query}），每 ${MAIL_POLL_MINUTES} 分钟看一次`,
      paused: w.paused === true,
      removable: true,
      createdAt: w.createdAt,
    });
  }
  for (const w of store.intakeWatches()) {
    const what = w.kind === "issues" ? "分给你的 issue" : "等你评审的 PR";
    out.push({
      id: `intake:${w.id}`,
      kind: "intake",
      title: w.about,
      detail: `${w.repo ?? "所有仓库"}${w.label ? ` · ${w.label}` : ""} 上${what}${w.auto ? (w.trial === true ? `，直接开任务（试运行中，已试 ${w.trials ?? 0} 条）` : "，直接开任务") : ""}，每 ${INTAKE_POLL_MINUTES} 分钟看一次`,
      paused: w.paused === true,
      removable: true,
      createdAt: w.createdAt,
    });
  }
  for (const s of socials) {
    if (!s.enabled) continue;
    for (const kind of SOCIAL_KINDS) {
      const activeAt = herd.socials?.activeAt(s.platform);
      out.push({
        id: `social:${s.platform}:${kind}`,
        kind: "social",
        title: `${s.name} · ${SOCIAL_LABELS[s.platform][kind]}`,
        detail:
          s.state === "ready" ? `每 ${SOCIAL_POLL_MINUTES} 分钟左右看一次通知` : "登录后开始看",
        paused: !s.watch[kind],
        removable: false,
        ...(activeAt === undefined ? {} : { activeAt }),
      });
    }
  }
  return out;
}

function parse(id: string): { kind: string; rest: string } {
  const at = id.indexOf(":");
  if (at < 0) throw new Error(`no such watch: ${id}`);
  return { kind: id.slice(0, at), rest: id.slice(at + 1) };
}

export function pauseWatch(herd: Herd, id: string, paused: boolean): void {
  const { store } = herd;
  const { kind, rest } = parse(id);
  if (kind === "pr") {
    const w = store.prWatches().find((x) => prKey(x) === rest);
    if (w === undefined) throw new Error(`no such watch: ${id}`);
    store.savePrWatch({ ...w, paused });
  } else if (kind === "mail") {
    const w = store.mailWatches().find((x) => x.id === rest);
    if (w === undefined) throw new Error(`no such watch: ${id}`);
    store.saveMailWatch({ ...w, paused });
  } else if (kind === "intake") {
    const w = store.intakeWatches().find((x) => x.id === rest);
    if (w === undefined) throw new Error(`no such watch: ${id}`);
    store.saveIntakeWatch({ ...w, paused });
  } else if (kind === "social") {
    const [platform, what] = rest.split(":") as [SocialPlatform, SocialKind];
    if (herd.socials === undefined || !SOCIAL_KINDS.includes(what)) {
      throw new Error(`no such watch: ${id}`);
    }
    herd.socials.setWatch(platform, what, !paused);
    return;
  } else {
    throw new Error(`no such watch: ${id}`);
  }
  store.audit("watch.paused", { id, paused });
}

export function deleteWatch(herd: Herd, id: string): void {
  const { store } = herd;
  const { kind, rest } = parse(id);
  if (kind === "pr") {
    const w = store.prWatches().find((x) => prKey(x) === rest);
    if (w === undefined) throw new Error(`no such watch: ${id}`);
    store.deletePrWatch(w);
  } else if (kind === "mail") {
    store.deleteMailWatch(rest);
  } else if (kind === "intake") {
    store.deleteIntakeWatch(rest);
  } else {
    throw new Error(`${id} cannot be removed; switch it off`);
  }
  store.audit("watch.removed", { id });
}
