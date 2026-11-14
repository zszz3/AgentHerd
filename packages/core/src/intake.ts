// New work from GitHub the owner asked to hear about (docs/spec/04-herder.md "New work",
// ADR 0052): issues assigned to the owner and pull requests waiting for their review. Nothing
// is watched until the owner asks the Herder; AgentHerd then searches GitHub with `gh` every
// few minutes, only while at least one watch exists. A new item is offered with
// 「开任务 / 忽略」; only a watch the owner made automatic starts work without asking, and only
// after its trial run, where the Herder just says what it would have started (ADR 0064).
import { randomUUID } from "node:crypto";
import type { AskView } from "@agentherd/protocol";
import type { Clock, Timer } from "./clock.ts";
import type { GhRun } from "./github-watch.ts";
import { type HerdContext, say } from "./herd-context.ts";
import type { IntakeOffer, IntakeWatch } from "./store.ts";

export const INTAKE_POLL_MINUTES = 5;
/** Watches at most; asking for more is refused. */
export const INTAKE_WATCHES_MAX = 10;
/** Buttons of an offer are this target followed by the offer id. */
export const INTAKE_TARGET = "intake:";
/** Items read per watch and look. */
const SEARCH_MAX = 30;
/** Offers the owner has not answered, kept per watch; older ones lose their buttons' effect. */
const OFFERS_MAX = 20;
const SEEN_MAX = 300;
const TITLE_MAX = 120;

export type IntakeKind = "issues" | "reviews";

/** One issue or pull request as a search found it. */
export interface IntakeItem {
  kind: IntakeKind;
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface IntakeOptions {
  run: GhRun;
  pollMinutes?: number;
  /**
   * Starts work for an item through the Herder; false when there is no Herder. With `trial`
   * the Herder only says what it would have started (ADR 0064).
   */
  start: (item: IntakeItem, auto: boolean, trial?: boolean) => boolean;
}

export interface IntakeRequest {
  kind: IntakeKind;
  /** `owner/name`; every repository when missing. */
  repo?: string;
  label?: string;
  /** What the owner wants to hear about, in their words. */
  about?: string;
  /** Start new items without asking (the owner said so). */
  auto?: boolean;
  /**
   * An automatic watch starts on a trial run (ADR 0064); false ends it, which only the owner
   * says. Missing keeps it as it is.
   */
  trial?: boolean;
}

function tidy(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The `gh search` arguments of a watch: open items assigned to, or waiting on, the owner. */
export function searchArgs(watch: Pick<IntakeWatch, "kind" | "repo" | "label">): string[] {
  const args =
    watch.kind === "issues"
      ? ["search", "issues", "--assignee=@me"]
      : ["search", "prs", "--review-requested=@me"];
  args.push("--state=open");
  if (watch.repo !== undefined) args.push("--repo", watch.repo);
  if (watch.label !== undefined) args.push("--label", watch.label);
  args.push("--json", "number,title,url,repository", "--limit", String(SEARCH_MAX));
  return args;
}

/** Runs a watch's search; `gh` answers a JSON list. */
export async function searchItems(run: GhRun, watch: IntakeWatch): Promise<IntakeItem[]> {
  const out = await run(searchArgs(watch));
  let list: unknown;
  try {
    list = JSON.parse(out === "" ? "[]" : out);
  } catch {
    throw new Error(`unexpected gh answer: ${tidy(out, 200)}`);
  }
  if (!Array.isArray(list)) throw new Error(`unexpected gh answer: ${tidy(out, 200)}`);
  return list
    .map(
      (x) =>
        x as {
          number?: number;
          title?: string;
          url?: string;
          repository?: { nameWithOwner?: string };
        },
    )
    .filter((x) => typeof x.url === "string" && typeof x.number === "number")
    .map((x) => ({
      kind: watch.kind,
      repo: x.repository?.nameWithOwner ?? "",
      number: x.number as number,
      title: tidy(x.title ?? "", TITLE_MAX) || "(no title)",
      url: x.url as string,
    }));
}

export class Intake {
  private readonly ctx: HerdContext;
  private readonly run: GhRun;
  private readonly start_: IntakeOptions["start"];
  private readonly clock: Clock;
  private readonly pollMs: number;
  private timer: Timer | undefined;
  private running = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(ctx: HerdContext, options: IntakeOptions) {
    this.ctx = ctx;
    this.run = options.run;
    this.start_ = options.start;
    this.clock = ctx.clock;
    this.pollMs = (options.pollMinutes ?? INTAKE_POLL_MINUTES) * 60_000;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancel();
  }

  list(): IntakeWatch[] {
    return this.ctx.store.intakeWatches();
  }

  /**
   * Starts offering new items of a kind, from now on. Searches once first, so a missing or
   * logged-out `gh` fails here, and what is already there is not offered as new.
   */
  /**
   * GitHub search needs owner/name. A bare name is what the owner usually
   * says, and means one of the owner's own repositories, so `gh` resolves it.
   */
  private async fullRepo(repo: string | undefined): Promise<string | undefined> {
    if (repo === undefined || repo.includes("/")) return repo;
    const out = await this.run(["repo", "view", repo, "--json", "nameWithOwner"]);
    const full = (JSON.parse(out) as { nameWithOwner?: unknown }).nameWithOwner;
    if (typeof full !== "string" || !full.includes("/")) {
      throw new Error(`cannot find the repository ${repo}; give it as owner/name`);
    }
    return full;
  }

  async add(request: IntakeRequest): Promise<IntakeWatch> {
    const { store } = this.ctx;
    const repo = await this.fullRepo(request.repo?.trim() || undefined);
    const label = request.label?.trim() || undefined;
    const watches = store.intakeWatches();
    const same = watches.find(
      (w) => w.kind === request.kind && w.repo === repo && w.label === label,
    );
    if (same !== undefined) {
      // Asking again may only change whether it starts by itself, and its trial run.
      const auto = request.auto ?? same.auto;
      const trial = auto && (request.trial ?? (same.auto ? same.trial === true : true));
      if (auto === same.auto && trial === (same.trial === true)) return same;
      const { trial: _trial, ...rest } = same;
      const changed: IntakeWatch = { ...rest, auto, ...(trial ? { trial: true } : {}) };
      store.saveIntakeWatch(changed);
      store.audit("intake.changed", { id: same.id, auto, trial });
      return changed;
    }
    if (watches.length >= INTAKE_WATCHES_MAX) {
      throw new Error(`at most ${INTAKE_WATCHES_MAX} watches for new work; remove one first`);
    }
    const auto = request.auto === true;
    const trial = auto && request.trial !== false;
    const draft: IntakeWatch = {
      id: randomUUID(),
      kind: request.kind,
      ...(repo === undefined ? {} : { repo }),
      ...(label === undefined ? {} : { label }),
      about: request.about?.trim() || describe(request.kind, repo, label),
      auto,
      ...(trial ? { trial: true } : {}),
      createdAt: this.clock.now().toISOString(),
      seen: [],
      offers: [],
    };
    const present = await searchItems(this.run, draft);
    const watch = { ...draft, seen: present.map((i) => i.url).slice(-SEEN_MAX) };
    store.saveIntakeWatch(watch);
    store.audit("intake.watching", {
      id: watch.id,
      kind: watch.kind,
      repo: watch.repo,
      label: watch.label,
      auto: watch.auto,
      trial,
    });
    this.schedule();
    return watch;
  }

  /** Stops a watch; false when there is no such watch. */
  remove(id: string): boolean {
    const { store } = this.ctx;
    const watch = store.intakeWatches().find((w) => w.id === id);
    if (watch === undefined) return false;
    store.deleteIntakeWatch(id);
    store.audit("intake.unwatched", { id, about: watch.about });
    if (store.intakeWatches().length === 0) this.cancel();
    return true;
  }

  /** Looks at every watch now. */
  poll(): Promise<void> {
    this.chain = this.chain
      .then(() => this.pollAll())
      .catch((error: Error) => this.ctx.sources.failed("github", error));
    return this.chain;
  }

  /** Waits for the looks already asked for (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** The owner tapped 「开任务」 or 「忽略」 on an offer. */
  async answer(target: string, action: string): Promise<void> {
    const { ctx } = this;
    const { store, texts } = ctx;
    const offerId = target.slice(INTAKE_TARGET.length);
    const watch = store.intakeWatches().find((w) => w.offers.some((o) => o.id === offerId));
    const offer = watch?.offers.find((o) => o.id === offerId);
    if (watch === undefined || offer === undefined) return;
    store.saveIntakeWatch({ ...watch, offers: watch.offers.filter((o) => o.id !== offerId) });
    const start = action === "start";
    store.audit(start ? "intake.started" : "intake.ignored", { url: offer.item.url });
    const view = this.offerView(offer);
    if (offer.ref !== undefined) {
      try {
        await ctx.opts.channel.update(offer.ref, {
          ...view,
          final: start ? texts.intakeStart : texts.intakeIgnore,
        });
      } catch (error) {
        store.audit("send.error", { kind: "intake", message: (error as Error).message });
      }
    }
    if (start && !this.start_(offer.item, false)) await say(ctx, texts.intakeNoHerder);
  }

  /** Polls only while something is watched. */
  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    if (this.ctx.store.intakeWatches().length === 0) return;
    this.timer = this.clock.after(this.pollMs, () => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    });
  }

  private cancel(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private async pollAll(): Promise<void> {
    for (const watch of this.ctx.store.intakeWatches()) {
      if (watch.paused === true) continue;
      try {
        const items = await searchItems(this.run, watch);
        this.ctx.sources.ok("github");
        await this.check(watch, items);
      } catch (error) {
        this.ctx.sources.failed("github", error as Error);
      }
    }
  }

  private async check(watch: IntakeWatch, items: IntakeItem[]): Promise<void> {
    const { ctx } = this;
    const { store } = ctx;
    // Another watch may have offered the same item already.
    const told = new Set(store.intakeWatches().flatMap((w) => w.seen));
    const fresh = items.filter((i) => !watch.seen.includes(i.url));
    if (fresh.length === 0) return;
    // Removed while GitHub answered: say nothing.
    const current = store.intakeWatches().find((w) => w.id === watch.id);
    if (current === undefined) return;
    let offers = current.offers;
    let trials = current.trials ?? 0;
    store.saveIntakeWatch({
      ...current,
      seen: [...current.seen, ...fresh.map((i) => i.url)].slice(-SEEN_MAX),
    });
    for (const item of fresh) {
      if (told.has(item.url)) continue;
      const onTrial = current.auto && current.trial === true;
      store.audit("intake.new", {
        id: watch.id,
        url: item.url,
        auto: current.auto,
        ...(onTrial ? { trial: true } : {}),
      });
      ctx.herder()?.event({ kind: "intake", title: watch.about, text: itemLine(item) });
      if (current.auto && !onTrial) {
        await say(ctx, ctx.texts.intakeAuto(item.repo, item.number, item.title, item.kind));
        if (!this.start_(item, true)) await say(ctx, ctx.texts.intakeNoHerder);
        continue;
      }
      // Asked, or on the trial run: the owner gets the offer either way (ADR 0064).
      if (onTrial) trials += 1;
      const offer: IntakeOffer = {
        id: randomUUID().slice(0, 12),
        item,
        ...(onTrial ? { trial: trials } : {}),
      };
      const ref = await ctx.outbox.send(this.offerView(offer));
      offers = [...offers, { ...offer, ...(ref === undefined ? {} : { ref }) }].slice(-OFFERS_MAX);
      const latest = store.intakeWatches().find((w) => w.id === watch.id);
      if (latest !== undefined) {
        store.saveIntakeWatch({ ...latest, offers, ...(onTrial ? { trials } : {}) });
      }
      // The Herder decides as it would and says what it would have started; nothing starts.
      if (onTrial) this.start_(item, true, true);
    }
  }

  private offerView(offer: IntakeOffer): AskView {
    const { texts } = this.ctx;
    const { item } = offer;
    const text = texts.intakeOffer(item.repo, item.number, item.title, item.url, item.kind);
    return {
      kind: "ask",
      askId: `${INTAKE_TARGET}${offer.id}`,
      text: offer.trial === undefined ? text : `${text}\n${texts.intakeTrial(offer.trial)}`,
      options: [
        { action: "start", label: texts.intakeStart },
        { action: "ignore", label: texts.intakeIgnore },
      ],
    };
  }
}

function describe(kind: IntakeKind, repo?: string, label?: string): string {
  const what = kind === "issues" ? "issues assigned to the owner" : "pull requests to review";
  return [
    what,
    repo === undefined ? "" : `in ${repo}`,
    label === undefined ? "" : `labelled ${label}`,
  ]
    .filter((s) => s !== "")
    .join(" ");
}

/** One line about an item, for the Herder. */
export function itemLine(item: IntakeItem): string {
  const what = item.kind === "issues" ? "issue" : "pull request to review";
  return `${what} ${item.repo}#${item.number}: ${item.title} ${item.url}`;
}
