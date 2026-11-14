// Items waiting for the owner (docs/spec/05-channels.md §2, ADR 0056). One item per session is
// open at a time; newer items for the same session wait behind it. Open items of different
// sessions share one card, so approvals that come up together are answered together ("都批",
// "批 1、3"). Only the bound owner can answer.
// Every open item has a life: one reminder after `remindMinutes`, and after `timeoutMinutes`
// it closes as not done: the agent gets a deny and goes on without that step. "先不管" closes
// it the same way at once. Time never allows anything.

import type {
  Channel,
  ChannelBinding,
  Decision,
  Inbound,
  Item,
  ItemLine,
  ItemView,
  MessageRef,
} from "@agentherd/protocol";
import { redact } from "@agentherd/rules";
import type { Clock, Timer } from "./clock.ts";
import type { Store } from "./store.ts";
import { CORE_TEXTS, type CoreTexts } from "./texts.ts";

export const BODY_MAX_LINES = 20;
export const DEFAULT_REMIND_MINUTES = 30;
/** An approval nobody answers closes as not done after this long (ADR 0056). */
export const DEFAULT_TIMEOUT_MINUTES = 60;
/** Lines on a card with several approvals: the command is cut shorter there. */
export const LINE_BODY_MAX_LINES = 6;

export type OwnerAnswer = "allow" | "deny";
/** What the owner can do with an item: answer it, or leave it ("先不管": not done). */
type OwnerAction = OwnerAnswer | "skip";

/** Footer actions of a card with several approvals. */
export const ALLOW_ALL = "allow-all";
export const SKIP_ALL = "skip-all";

/** The agent side of an item: answering it, once. */
export interface Answerable {
  /** Returns false when the agent no longer waits (it was cancelled or exited). */
  answer(answer: OwnerAnswer): boolean;
}

interface Entry {
  item: Item;
  target: Answerable;
  reason: string;
  taskLabel?: string;
  card?: Card;
  timers: Timer[];
  closing: boolean;
  /** Set once the item closed: the line's final text. */
  final?: string;
}

/** One message in the chat holding one or more items. */
interface Card {
  id: string;
  entries: Entry[];
  ref?: MessageRef;
  /** Card updates run one after another, so a late update never overwrites a newer one. */
  updating: Promise<void>;
}

export interface InboxOptions {
  channel: Channel;
  binding: ChannelBinding;
  store: Store;
  clock: Clock;
  remindMinutes?: number;
  timeoutMinutes?: number;
  secrets?: Record<string, string>;
  /** Called after an item is decided or expired. */
  onClosed?: (item: Item) => void;
  /** Called when an item is answered: by the owner, by 「先不管」 or by the timeout (ADR 0057). */
  onAnswered?: (item: Item, answer: OwnerAnswer, how: "owner" | "skip" | "timeout") => void;
  texts?: CoreTexts;
}

function options(texts: CoreTexts): ItemView["options"] {
  return [
    { action: "allow", label: texts.allow },
    { action: "deny", label: texts.deny },
    { action: "skip", label: texts.skip },
  ];
}

/** The agent's own reason for a tool call, e.g. DSH's `rawInput.justification`. */
function justificationOf(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null || !("justification" in rawInput))
    return undefined;
  const value = rawInput.justification;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Card body: the command and the paths, at most `max` lines, redacted. */
export function itemBody(
  item: Item,
  secrets?: Record<string, string>,
  texts: CoreTexts = CORE_TEXTS.en,
  max = BODY_MAX_LINES,
): string {
  const lines: string[] = [];
  if (item.toolCall?.command !== undefined) lines.push(...item.toolCall.command.split("\n"));
  for (const path of item.toolCall?.paths ?? []) lines.push(path);
  if (lines.length === 0) lines.push(...item.body.split("\n"));
  const justification = justificationOf(item.toolCall?.rawInput);
  if (justification !== undefined) lines.push(texts.reason(justification));
  const shown =
    lines.length > max
      ? [...lines.slice(0, max - 1), `… ${lines.length - max + 1} more lines`]
      : lines;
  return redact(shown.join("\n"), secrets);
}

/** The pipeline's reasons are English keys; show them in the owner's language. */
function reasonText(reason: string, texts: CoreTexts): string {
  if (reason === "no rule matched") return texts.noRuleMatched;
  if (reason.startsWith("guard list: ")) return texts.guardHit(reason.slice(12));
  if (reason.startsWith("mass delete: ")) return texts.massDelete;
  const out = /^leaves the Mac: ([a-z-]+):/.exec(reason);
  if (out !== null) {
    const step = out[1] as string;
    return reason.endsWith(" [pull request turn]")
      ? texts.leavesMacPr(step)
      : texts.leavesMac(step);
  }
  return reason;
}

export function itemView(
  item: Item,
  reason: string,
  secrets?: Record<string, string>,
  texts: CoreTexts = CORE_TEXTS.en,
): ItemView {
  return {
    kind: "item",
    itemId: item.id,
    title: redact(item.title, secrets),
    body: itemBody(item, secrets, texts),
    risk: item.risk,
    options: options(texts),
    reason: redact(reasonText(reason, texts), secrets),
  };
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

/**
 * Numbers in an answer like "批 1、3" or "allow 2 and 4"; undefined when the text is not an
 * answer to a card with several approvals.
 */
export function parseBatchAnswer(
  text: string,
): { action: OwnerAction | "allow-all"; ns: number[] } | undefined {
  const t = text.trim().replace(/[。.!！]+$/, "");
  if (/^(都批|全批|全部批准|都批准|批准全部|全部同意|都同意|allow all|approve all)$/i.test(t)) {
    return { action: "allow-all", ns: [] };
  }
  const m =
    /^(批准?|同意|拒绝?|不批|先不管|allow|approve|deny|skip)\s*(第)?\s*([\d\s,，、和及and]+)$/i.exec(
      t,
    );
  if (m === null) return undefined;
  const word = (m[1] as string).toLowerCase();
  const action: OwnerAction = /^(拒|不批|deny)/.test(word)
    ? "deny"
    : /^(先不管|skip)/.test(word)
      ? "skip"
      : "allow";
  const ns = [...(m[3] as string).matchAll(/\d+/g)].map((d) => Number(d[0]));
  return ns.length === 0 ? undefined : { action, ns };
}

export class Inbox {
  private readonly queues = new Map<string, Entry[]>();
  /** The card new items join while it still has open items. */
  private card: Card | undefined;
  private readonly remindMs: number;
  private readonly timeoutMs: number;

  private readonly opts: InboxOptions;
  private readonly texts: CoreTexts;

  constructor(opts: InboxOptions) {
    this.opts = opts;
    this.texts = opts.texts ?? CORE_TEXTS.en;
    this.remindMs = (opts.remindMinutes ?? DEFAULT_REMIND_MINUTES) * 60_000;
    this.timeoutMs = (opts.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
  }

  /** Number of items not yet decided, shown or queued. */
  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  /** Adds an item. `taskLabel` names the task on the card. */
  async add(item: Item, target: Answerable, reason: string, taskLabel?: string): Promise<void> {
    const queue = this.queues.get(item.sessionId) ?? [];
    this.queues.set(item.sessionId, queue);
    const entry: Entry = { item, target, reason, timers: [], closing: false };
    if (taskLabel !== undefined) entry.taskLabel = taskLabel;
    queue.push(entry);
    if (queue.length === 1) await this.show(entry);
  }

  async handle(inbound: Inbound): Promise<void> {
    const { store, binding } = this.opts;
    if (inbound.from !== binding.ownerId) {
      store.audit("inbound.dropped", {
        reason: "not-owner",
        from: inbound.from,
        kind: inbound.kind,
      });
      return;
    }
    if (inbound.kind !== "action") {
      if (!(await this.handleText(inbound.text))) {
        store.audit("inbound.ignored", { reason: "not-an-answer", text: inbound.text });
      }
      return;
    }
    const card = this.card?.id === inbound.target ? this.card : undefined;
    if (card !== undefined) {
      if (inbound.action !== ALLOW_ALL && inbound.action !== SKIP_ALL) {
        store.audit("inbound.dropped", { reason: "unknown-action", action: inbound.action });
        return;
      }
      const action: OwnerAction = inbound.action === ALLOW_ALL ? "allow" : "skip";
      await this.decideMany(
        card.entries.filter((e) => !e.closing),
        action,
        binding.ownerId,
      );
      return;
    }
    const entry = this.shown(inbound.target);
    if (entry === undefined || entry.closing) {
      store.audit("inbound.dropped", { reason: "not-open", target: inbound.target });
      return;
    }
    const action = inbound.action;
    if (action !== "allow" && action !== "deny" && action !== "skip") {
      store.audit("inbound.dropped", { reason: "unknown-action", action });
      return;
    }
    await this.decideMany([entry], action, binding.ownerId);
  }

  /**
   * The owner's chat message, when it answers the open card: "都批", "批 1、3", "拒 2". Returns
   * false when it is not such an answer (the message then goes to the Herder).
   */
  async handleText(text: string): Promise<boolean> {
    const card = this.card;
    if (card === undefined || !card.entries.some((e) => !e.closing)) return false;
    const parsed = parseBatchAnswer(text);
    if (parsed === undefined) return false;
    const open = card.entries.filter((e) => !e.closing);
    if (parsed.action === "allow-all") {
      await this.decideMany(open, "allow", this.opts.binding.ownerId);
      return true;
    }
    // A bare "批" with one open item, or numbers on the card.
    const picked = parsed.ns
      .map((n) => card.entries[n - 1])
      .filter((e): e is Entry => e !== undefined && !e.closing);
    if (picked.length === 0) return false;
    await this.decideMany(picked, parsed.action, this.opts.binding.ownerId);
    return true;
  }

  /** The agent stopped waiting (exit, cancel, end of turn): its open items expire. */
  async expireSession(sessionId: string, why: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return;
    this.queues.delete(sessionId);
    for (const entry of queue) {
      if (entry.closing) continue;
      entry.closing = true;
      await this.finish(entry, "expired", this.texts.expired(why));
    }
  }

  async stop(): Promise<void> {
    for (const sessionId of [...this.queues.keys()]) {
      await this.expireSession(sessionId, this.texts.agentherdStopped);
    }
  }

  private shown(itemId: string): Entry | undefined {
    for (const queue of this.queues.values()) {
      const head = queue[0];
      if (head !== undefined && head.item.id === itemId && head.card?.ref !== undefined) {
        return head;
      }
    }
    return undefined;
  }

  /** Shows a session's next item: on the open card if there is one, else on a new card. */
  private async show(entry: Entry): Promise<void> {
    const { channel, store } = this.opts;
    const open = this.card;
    if (open?.entries.some((e) => !e.closing)) {
      const card = open;
      card.entries.push(entry);
      entry.card = card;
      this.arm(entry);
      if (card.ref !== undefined) store.updateItem(entry.item.id, { messageRef: card.ref });
      store.audit("item.sent", { itemId: entry.item.id, joined: card.id });
      await this.refresh(card);
      return;
    }
    const card: Card = {
      id: `card-${entry.item.id}`,
      entries: [entry],
      updating: Promise.resolve(),
    };
    entry.card = card;
    this.card = card;
    const ref = await channel.send(this.cardView(card));
    card.ref = ref;
    for (const e of card.entries) store.updateItem(e.item.id, { messageRef: ref });
    store.audit("item.sent", { itemId: entry.item.id });
    for (const e of card.entries) this.arm(e);
    // Items that joined while the card was being sent.
    if (card.entries.length > 1) await this.refresh(card);
  }

  /** One reminder, then the timeout: not done (ADR 0056). */
  private arm(entry: Entry): void {
    if (entry.timers.length > 0) return;
    const { clock } = this.opts;
    if (this.remindMs < this.timeoutMs) {
      entry.timers.push(
        clock.after(this.remindMs, () => {
          if (entry.closing) return;
          const { channel, store, secrets } = this.opts;
          const text = this.texts.stillWaiting(redact(entry.item.title, secrets));
          void channel
            .send({ kind: "text", text })
            .then(() => store.audit("item.reminded", { itemId: entry.item.id }))
            .catch((error: Error) =>
              store.audit("channel.error", { op: "remind", message: error.message }),
            );
        }),
      );
    }
    entry.timers.push(
      clock.after(this.timeoutMs, () => {
        if (entry.closing) return;
        void this.close(entry, "deny", this.texts.timedOut(Math.round(this.timeoutMs / 60_000)), {
          source: "timeout",
        });
      }),
    );
  }

  private async decideMany(entries: Entry[], action: OwnerAction, ownerId: string): Promise<void> {
    const final =
      action === "allow"
        ? this.texts.allowedByYou
        : action === "deny"
          ? this.texts.deniedByYou
          : this.texts.skippedByYou;
    for (const entry of entries) {
      if (entry.closing) continue;
      await this.close(entry, action === "allow" ? "allow" : "deny", final, {
        source: "human",
        ownerId,
        ...(action === "skip" ? { skipped: true } : {}),
      });
    }
  }

  /** Answers the agent, records the decision, updates the card and shows the session's next item. */
  private async close(
    entry: Entry,
    answer: OwnerAnswer,
    final: string,
    by: { source: "human" | "timeout"; ownerId?: string; skipped?: boolean },
  ): Promise<void> {
    if (entry.closing) return;
    entry.closing = true;
    const { store, clock } = this.opts;
    if (!entry.target.answer(answer)) {
      await this.finish(entry, "expired", this.texts.expired(this.texts.agentStoppedWaiting));
      await this.next(entry.item.sessionId);
      return;
    }
    const decision: Decision = {
      itemId: entry.item.id,
      action: answer,
      confidence: 1,
      risk: entry.item.risk,
      source: "human",
      reason:
        by.source === "timeout" ? "no answer in time" : by.skipped ? "owner: not now" : "owner",
      precedents: [],
    };
    store.insertDecision(decision, {
      ...(by.ownerId === undefined ? {} : { ownerId: by.ownerId }),
      createdAt: clock.now().toISOString(),
    });
    if (by.source === "timeout") store.audit("item.timed-out", { itemId: entry.item.id });
    this.opts.onAnswered?.(
      entry.item,
      answer,
      by.source === "timeout" ? "timeout" : by.skipped ? "skip" : "owner",
    );
    await this.finish(entry, "decided", final);
    await this.next(entry.item.sessionId);
  }

  private async finish(entry: Entry, state: "decided" | "expired", final: string): Promise<void> {
    const { store, clock } = this.opts;
    for (const t of entry.timers) t.cancel();
    entry.timers = [];
    entry.final = final;
    store.updateItem(entry.item.id, { state, decidedAt: clock.now().toISOString() });
    store.audit(`item.${state}`, { itemId: entry.item.id, final });
    const card = entry.card;
    if (card !== undefined) {
      if (this.card === card && card.entries.every((e) => e.closing)) this.card = undefined;
      await this.refresh(card);
    }
    this.opts.onClosed?.({ ...entry.item, state });
  }

  /** Redraws a card after a change; updates run in order. */
  private refresh(card: Card): Promise<void> {
    const run = card.updating.then(async () => {
      if (card.ref === undefined) return;
      try {
        await this.opts.channel.update(card.ref, this.cardView(card));
      } catch (error) {
        this.opts.store.audit("channel.error", { op: "update", message: (error as Error).message });
      }
    });
    card.updating = run;
    return run;
  }

  private cardView(card: Card): ItemView {
    const { secrets } = this.opts;
    const texts = this.texts;
    const [first] = card.entries as [Entry];
    if (card.entries.length === 1) {
      const view = itemView(first.item, first.reason, secrets, texts);
      if (first.taskLabel !== undefined) view.taskLabel = first.taskLabel;
      if (first.final !== undefined) return { ...view, options: [], final: first.final };
      return view;
    }
    const lines: ItemLine[] = card.entries.map((e, i) => {
      const line: ItemLine = {
        itemId: e.item.id,
        n: i + 1,
        title: redact(e.item.title, secrets),
        body: itemBody(e.item, secrets, texts, LINE_BODY_MAX_LINES),
        risk: e.item.risk,
        reason: redact(reasonText(e.reason, texts), secrets),
        options: e.final === undefined ? options(texts).slice(0, 2) : [],
      };
      if (e.taskLabel !== undefined) line.taskLabel = e.taskLabel;
      if (e.final !== undefined) line.final = e.final;
      return line;
    });
    const open = card.entries.filter((e) => e.final === undefined).length;
    const risk = card.entries
      .map((e) => e.item.risk)
      .reduce((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a));
    const view: ItemView = {
      kind: "item",
      itemId: card.id,
      title: texts.manyWaiting(card.entries.length),
      body: open === 0 ? "" : texts.manyHint,
      risk,
      options:
        open === 0
          ? []
          : [
              { action: ALLOW_ALL, label: texts.allowAll },
              { action: SKIP_ALL, label: texts.skipAll },
            ],
      lines,
    };
    if (open === 0) view.final = texts.allClosed;
    return view;
  }

  private async next(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return;
    queue.shift();
    const head = queue[0];
    if (head === undefined) {
      this.queues.delete(sessionId);
      return;
    }
    try {
      await this.show(head);
    } catch (error) {
      this.opts.store.audit("channel.error", { op: "send", message: (error as Error).message });
    }
  }
}
