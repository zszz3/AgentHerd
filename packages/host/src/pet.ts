// The desktop pet (ADR 0070): a tee in front of the chat channel. Everything AgentHerd sends to
// the owner still goes to Feishu; the pet sees the same views, shows the latest one in its bubble
// with the buttons of whatever waits for the owner, and passes what the owner types or presses
// there back in as the owner's own message or button press; what the owner typed is quoted on top
// of the Herder's next chat answer rather than sent alone, so the chat app does not ring for it.
// The expanded pet shows the Herder's conversation kept in herd.db (`historyOf`), so it reaches
// back past restarts, with the cards sent to the owner (reports, approvals, questions) kept in
// herd.db too (ADR 0072). It never writes text of its own and makes no model calls.

import type { HerderTurn, OwnerCard } from "@agentherd/core";
import { quietReply, withoutContextMarks } from "@agentherd/herder";
import type {
  Channel,
  ChannelBinding,
  ChannelCapability,
  InboundImage,
  InboundSink,
  MessageRef,
  SetupUI,
  View,
} from "@agentherd/protocol";
import { HERD_UI_TARGET, hasHerdUi, herdUiChoices } from "@agentherd/protocol/herd-ui";
import type { PetCard, PetCardView, PetLine, PetPending } from "./api.ts";

/** Longest text the pet keeps for one line or one card body. */
export const PET_TEXT_MAX = 600;
/** Lines of the conversation the expanded pet shows; older ones are in the chat app. */
export const PET_HISTORY_MAX = 80;
/** Longest text of one line in the conversation. */
export const PET_HISTORY_TEXT_MAX = 1500;
/** Cards the expanded pet shows, the newest. */
export const PET_CARDS_MAX = 60;
/** Longest report or agent reply a card in the pet keeps; the app has the whole task. */
export const PET_CARD_TEXT_MAX = 4000;
/** Longest text with a herd-ui block the pet keeps: cutting the block would lose it (ADR 0074). */
export const PET_UI_TEXT_MAX = 12_000;
/**
 * How long what the owner typed in the pet waits to ride on the Herder's answer before it goes
 * to the chat alone (ADR 0070). A message of its own makes the chat app ring for words the owner
 * wrote.
 */
export const PET_ECHO_HOLD_MS = 2 * 60_000;
/** Chat messages whose echo is kept, so an update in place does not drop it. */
const ECHOED_MAX = 50;

/**
 * The Herder answering: its own words (with or without herd-ui choices) or its question. Not a
 * task's message, an offer with buttons, the board, a report or a card.
 */
function carriesEcho(view: View): boolean {
  if (view.kind === "ask") return true;
  if (view.kind !== "text" || view.taskLabel !== undefined) return false;
  return view.target === undefined || view.target.startsWith(HERD_UI_TARGET);
}

/**
 * What the owner typed in the pet, set apart from the Herder's words: a Markdown quote, one per
 * message, then a rule. Without it the chat could not tell who said what.
 */
export function echoQuote(lines: readonly string[]): string {
  return lines
    .map((line) =>
      line
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n"),
    )
    .join("\n>\n");
}

/** The view with what the owner typed in the pet quoted on top. */
function withEcho(view: View, quote: string): View {
  if (view.kind !== "text" && view.kind !== "ask") return view;
  return { ...view, text: `${quote}\n\n---\n\n${view.text}` };
}

/** How long a text may be in the pet: longer when it carries a herd-ui block. */
function maxFor(text: string, max: number): number {
  return hasHerdUi(text) ? Math.max(max, PET_UI_TEXT_MAX) : max;
}

function cut(text: string, max = PET_TEXT_MAX): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function key(ref: MessageRef): string {
  return `${ref.channelId}:${ref.id}`;
}

/**
 * The views the pet shows as cards: reports, approvals, questions, offers with buttons, and
 * Herder replies whose herd-ui offers choices (ADR 0074).
 */
export function isCardView(view: View): view is PetCardView {
  return (
    view.kind === "report" ||
    view.kind === "item" ||
    view.kind === "ask" ||
    (view.kind === "text" &&
      view.target !== undefined &&
      ((view.options?.length ?? 0) > 0 || herdUiChoices(view.text).length > 0))
  );
}

/** Every button on a card that still works, as the target and action it sends. */
function buttonsOf(view: View): { target: string; action: string }[] {
  if (view.kind === "item") {
    if (view.final !== undefined) return [];
    const own = view.options.map((o) => ({ target: view.itemId, action: o.action }));
    const lines = (view.lines ?? [])
      .filter((l) => l.final === undefined)
      .flatMap((l) => l.options.map((o) => ({ target: l.itemId, action: o.action })));
    return [...own, ...lines];
  }
  if (view.kind === "ask") {
    return view.final === undefined
      ? view.options.map((o) => ({ target: view.askId, action: o.action }))
      : [];
  }
  if (view.kind === "text" && view.target !== undefined) {
    const target = view.target;
    if ((view.options?.length ?? 0) > 0) {
      return (view.options ?? []).map((o) => ({ target, action: o.action }));
    }
    // A reply's choices work until one is picked.
    if (view.chosen !== undefined) return [];
    return herdUiChoices(view.text).map((a) => ({ target, action: a.action }));
  }
  return [];
}

/** What waits for the owner on this card, or undefined when nothing does (closed, or no buttons). */
function pendingOf(view: View): PetPending | undefined {
  if (view.kind === "item") {
    if (view.final !== undefined || view.options.length === 0) return undefined;
    const pending: PetPending = {
      target: view.itemId,
      title: cut(view.title, 200),
      body: cut(
        view.lines === undefined
          ? view.body
          : view.lines
              .filter((l) => l.final === undefined)
              .map((l) => `${l.n}. ${l.title}`)
              .join("\n"),
        400,
      ),
      options: view.options,
    };
    if (view.taskLabel !== undefined) pending.task = view.taskLabel;
    if (view.lines !== undefined)
      pending.count = view.lines.filter((l) => l.final === undefined).length;
    return pending;
  }
  if (view.kind === "ask") {
    if (view.final !== undefined || view.options.length === 0) return undefined;
    return { target: view.askId, title: cut(view.text, 400), body: "", options: view.options };
  }
  if (view.kind === "text" && view.target !== undefined && (view.options?.length ?? 0) > 0) {
    const pending: PetPending = {
      target: view.target,
      title: cut(view.title ?? view.text, 400),
      body: view.title === undefined ? "" : cut(view.text, 400),
      options: view.options ?? [],
    };
    if (view.taskLabel !== undefined) pending.task = view.taskLabel;
    return pending;
  }
  return undefined;
}

/** The line the pet says for a new message; undefined for the board and relay cards. */
function lineOf(view: View): Omit<PetLine, "id" | "at"> | undefined {
  switch (view.kind) {
    case "text": {
      const words = view.title === undefined ? view.text : `${view.title}：${view.text}`;
      const text = cut(words, maxFor(words, PET_TEXT_MAX));
      if (view.tone === "error") return { kind: "error", text, ...task(view.taskLabel) };
      if (view.taskLabel !== undefined || view.tone !== undefined) {
        return { kind: "task", text, ...task(view.taskLabel) };
      }
      return { kind: "say", text };
    }
    case "report":
      return { kind: "report", text: cut(view.body), task: view.title, result: view.result };
    case "item":
      return { kind: "ask", text: cut(view.title, 200), ...task(view.taskLabel) };
    case "ask":
      return { kind: "ask", text: cut(view.text, 400) };
    default:
      return undefined;
  }
}

function task(label: string | undefined): { task?: string } {
  return label === undefined ? {} : { task: label };
}

/**
 * The conversation for the expanded pet, from the lines the Herder keeps in herd.db
 * (`herder_turns`): the owner's messages and answers, the Herder's replies and questions, and
 * the reports it passed on. Oldest first.
 */
export function historyOf(
  turns: readonly HerderTurn[],
  titleOf: (taskId: string) => string | undefined,
): PetLine[] {
  const lines: PetLine[] = [];
  for (const turn of turns) {
    // Older replies may still begin with a ref tag the model wrote itself (ADR 0045).
    const said = turn.role === "herder" || turn.role === "ask";
    const words = said ? withoutContextMarks(turn.text) : turn.text;
    const text = cut(words, maxFor(words, PET_HISTORY_TEXT_MAX));
    if (text === "") continue;
    // A "say nothing" reply that slipped through as 「[安静]」 is not shown (ADR 0099).
    if (turn.role === "herder" && quietReply(text)) continue;
    const base = { id: turn.id, at: turn.at, text };
    if (turn.role === "owner" || turn.role === "answer") {
      lines.push({ ...base, kind: "owner" });
    } else if (turn.role === "ask") {
      lines.push({ ...base, kind: "ask" });
    } else if (turn.role === "event") {
      // Already says which task: "title: what happened".
      lines.push({ ...base, kind: "task" });
    } else {
      const title = turn.taskId === undefined ? undefined : titleOf(turn.taskId);
      lines.push({ ...base, kind: "say", ...task(title) });
    }
  }
  return lines;
}

function plain(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A line of herd.db that a card already shows: the question of an ask card, the Herder's words
 * of a report it spoke, the note a report or an answered approval left for the Herder, a reply
 * whose choices make it a card (ADR 0074).
 */
function shownAsCard(turn: HerderTurn, views: readonly PetCardView[]): boolean {
  const text = plain(turn.text);
  const said = turn.role === "herder" ? plain(withoutContextMarks(turn.text)) : "";
  for (const view of views) {
    if (view.kind === "text" && said !== "" && said === plain(view.text)) return true;
    if (view.kind === "ask" && turn.role === "ask" && text.startsWith(plain(view.text))) {
      return true;
    }
    if (view.kind === "report" && turn.taskId === view.taskId) {
      if (turn.role === "herder" && text === plain(view.body)) return true;
      if (turn.role === "event" && text === plain(`${view.title}: ${view.body}`)) return true;
    }
    if (view.kind === "item" && turn.role === "event") {
      const titles = [view.title, ...(view.lines ?? []).map((l) => l.title)];
      if (titles.some((t) => text.endsWith(`: ${plain(t)}`))) return true;
    }
  }
  return false;
}

/** A card as the pet gets it: long texts cut, the app has the rest. */
function forPet(view: PetCardView): PetCardView {
  if (view.kind === "report") {
    return {
      ...view,
      body: cut(view.body, PET_CARD_TEXT_MAX),
      ...(view.fullReply === undefined
        ? {}
        : { fullReply: cut(view.fullReply, PET_CARD_TEXT_MAX) }),
    };
  }
  if (view.kind === "item") {
    return {
      ...view,
      body: cut(view.body, 2000),
      ...(view.lines === undefined
        ? {}
        : { lines: view.lines.map((l) => ({ ...l, body: cut(l.body, 600) })) }),
    };
  }
  if (view.kind === "text") return { ...view, text: cut(view.text, maxFor(view.text, 2000)) };
  return view;
}

/**
 * The expanded pet's conversation (ADR 0072): the lines of herd.db and the cards sent to the
 * owner since the first of those lines, without the lines a card already shows. `isOpen` says
 * which cards can still be answered in this run.
 */
export function petConversation(
  turns: readonly HerderTurn[],
  stored: readonly OwnerCard[],
  titleOf: (taskId: string) => string | undefined,
  isOpen: (ref: string) => boolean,
): { history: PetLine[]; cards: PetCard[] } {
  // A full window of lines starts somewhere in the past: older cards would stand alone.
  const from = turns.length >= PET_HISTORY_MAX ? (turns[0]?.at ?? "") : "";
  const kept = stored.filter(
    (c): c is OwnerCard & { view: PetCardView } => c.at >= from && isCardView(c.view),
  );
  const views = kept.map((c) => c.view);
  return {
    history: historyOf(
      turns.filter((t) => !shownAsCard(t, views)),
      titleOf,
    ),
    cards: kept.map((c) => ({ ref: c.ref, at: c.at, view: forPet(c.view), open: isOpen(c.ref) })),
  };
}

type Entry = PetLine & { ref?: string };

/**
 * What the pet knows: the latest line and the open cards. One feed lives as long as the host;
 * each herd start wraps its new channel with it.
 */
export interface PetFeedOptions {
  /** Something the pet shows changed. */
  changed: () => void;
  /**
   * The chat line that tells what the owner typed to the pet, so the chat still reads as one
   * conversation. It is quoted on top of the Herder's next answer, or posted alone after
   * `echoHoldMs`. Undefined: nothing is posted.
   */
  echo?: (text: string) => string;
  /** Default `PET_ECHO_HOLD_MS`. */
  echoHoldMs?: number;
  /** Keeps a card in its latest form, for the conversation after a restart (ADR 0072). */
  keep?: (ref: string, view: PetCardView) => void;
  now?: () => Date;
}

/** Echo lines that wait for the Herder's answer on one channel. */
interface HeldEcho {
  channel: Channel;
  lines: string[];
  timer: ReturnType<typeof setTimeout>;
}

export class PetFeed {
  private seq = 0;
  private lastLine: Entry | undefined;
  /** Cards with buttons that still work, by message ref, oldest first. */
  private readonly open = new Map<string, View>();
  private sink: InboundSink | undefined;
  private ownerId: string | undefined;
  private inner: Channel | undefined;
  private held: HeldEcho | undefined;
  /** The echo quoted on a chat message, by message ref. */
  private readonly echoed = new Map<string, string>();
  private readonly opts: PetFeedOptions;

  constructor(opts: PetFeedOptions) {
    this.opts = opts;
  }

  /** The channel the herd uses: the same as `inner`, and the pet sees what it sends. */
  wrap(inner: Channel): Channel {
    this.inner = inner;
    return new PetChannel(inner, this);
  }

  private changed(): void {
    this.opts.changed();
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  get connected(): boolean {
    return this.sink !== undefined;
  }

  get last(): PetLine | undefined {
    if (this.lastLine === undefined) return undefined;
    const { ref: _ref, ...line } = this.lastLine;
    return line;
  }

  /** Open cards, oldest first. */
  pending(): PetPending[] {
    return [...this.open.values()].flatMap((v) => pendingOf(v) ?? []);
  }

  /** The card sent as `ref` (`channelId:messageId`) can still be answered. */
  isOpen(ref: string): boolean {
    return this.open.has(ref);
  }

  /** The owner typed this in the pet's bubble: it reaches AgentHerd like a chat message. */
  /**
   * The owner typed this in the pet, maybe with files dropped on it (ADR 0082): pictures come as
   * the message's images, other files as lines with their paths.
   */
  async say(
    text: string,
    dropped: { images?: InboundImage[]; lines?: string[] } = {},
  ): Promise<void> {
    const images = dropped.images ?? [];
    const t = [text.trim(), ...(dropped.lines ?? [])].filter((x) => x !== "").join("\n");
    if (t === "" && images.length === 0) throw new Error("说点什么再发送");
    const { sink, ownerId } = this.inbound();
    if (this.opts.echo !== undefined && this.inner !== undefined) {
      // Not a message of its own: the owner wrote it, so the chat app should not ring for it.
      // Held, not sent, so the Herder does not wait on Feishu either.
      const pictures = images.length === 0 ? "" : ` 🖼️×${images.length}`;
      this.hold(this.inner, [this.opts.echo(`${t}${pictures}`.trim())]);
    }
    await sink({
      kind: "message",
      text: t,
      from: ownerId,
      ...(images.length === 0 ? {} : { images }),
    });
  }

  private hold(channel: Channel, lines: string[], first = false): void {
    const held = this.held;
    if (held !== undefined && held.channel === channel) {
      if (first) held.lines.unshift(...lines);
      else held.lines.push(...lines);
      return;
    }
    if (held !== undefined) void this.flush(held.channel);
    const timer = setTimeout(
      () => void this.flush(channel),
      this.opts.echoHoldMs ?? PET_ECHO_HOLD_MS,
    );
    timer.unref?.();
    this.held = { channel, lines: [...lines], timer };
  }

  /** @internal The Herder took too long, or the channel stops: the echo goes to the chat alone. */
  async flush(channel: Channel): Promise<void> {
    const held = this.held;
    if (held === undefined || held.channel !== channel) return;
    this.held = undefined;
    clearTimeout(held.timer);
    // Straight to the chat, past the pet: the owner just typed it and needs no bubble for it.
    await channel.send({ kind: "text", text: held.lines.join("\n") }).catch(() => undefined);
  }

  /** @internal The echo to quote on this view, taken off the hold; undefined if none. */
  takeEcho(channel: Channel, view: View): string[] | undefined {
    const held = this.held;
    if (held === undefined || held.channel !== channel || !carriesEcho(view)) return undefined;
    this.held = undefined;
    clearTimeout(held.timer);
    return held.lines;
  }

  /** @internal The view could not be sent: its echo waits again. */
  returnEcho(channel: Channel, lines: string[]): void {
    this.hold(channel, lines, true);
  }

  /** @internal This chat message carries the echo; updates keep it. */
  rememberEcho(ref: MessageRef, echo: string): void {
    this.echoed.set(key(ref), echo);
    if (this.echoed.size > ECHOED_MAX) {
      const oldest = this.echoed.keys().next().value;
      if (oldest !== undefined) this.echoed.delete(oldest);
    }
  }

  /** @internal */
  echoOf(ref: MessageRef): string | undefined {
    return this.echoed.get(key(ref));
  }

  /** The owner pressed a button in the bubble: the same as pressing it on the Feishu card. */
  async press(target: string, action: string): Promise<void> {
    const open = [...this.open.values()].some((v) =>
      buttonsOf(v).some((b) => b.target === target && b.action === action),
    );
    if (!open) throw new Error("这件事已经处理过了");
    const { sink, ownerId } = this.inbound();
    // A press is not an answer to what the owner typed: that goes first, alone.
    if (this.inner !== undefined) await this.flush(this.inner);
    await sink({ kind: "action", target, action, from: ownerId });
  }

  private inbound(): { sink: InboundSink; ownerId: string } {
    if (this.sink === undefined || this.ownerId === undefined) {
      throw new Error("AgentHerd 还没连上飞书，先在 App 里设置好");
    }
    return { sink: this.sink, ownerId: this.ownerId };
  }

  /** @internal */
  attach(binding: ChannelBinding, sink: InboundSink): void {
    this.sink = sink;
    this.ownerId = binding.ownerId;
    this.changed();
  }

  /** @internal The herd stopped: its cards can no longer be answered. */
  detach(inner: Channel): void {
    if (inner !== this.inner) return;
    this.sink = undefined;
    this.ownerId = undefined;
    this.open.clear();
    this.changed();
  }

  /** @internal */
  sent(ref: MessageRef, view: View): void {
    const k = key(ref);
    this.keep(k, view);
    const open = buttonsOf(view).length > 0;
    if (open) this.open.set(k, view);
    const line = lineOf(view);
    if (line !== undefined) {
      this.seq++;
      this.lastLine = {
        ...line,
        id: this.seq,
        at: this.now().toISOString(),
        ref: k,
        ...(isCardView(view) ? { card: k } : {}),
      };
    }
    if (open || line !== undefined) this.changed();
  }

  private keep(ref: string, view: View): void {
    if (this.opts.keep === undefined || !isCardView(view)) return;
    try {
      this.opts.keep(ref, view);
    } catch {
      // The pet shows less after a restart; the chat app has the card.
    }
  }

  /** @internal An update in place: a card closed or changed, or a message was edited. */
  updated(ref: MessageRef, view: View): void {
    const k = key(ref);
    this.keep(k, view);
    // A card's new form shows in the conversation even when its buttons did not change.
    let changed = isCardView(view);
    if (buttonsOf(view).length > 0) {
      this.open.set(k, view);
      changed = true;
    } else if (this.open.delete(k)) {
      changed = true;
    }
    // An edited message (a progress line that grows): the same line, new words.
    if (this.lastLine?.ref === k && view.kind === "text") {
      const line = lineOf(view);
      if (line !== undefined) {
        this.lastLine = { ...this.lastLine, ...line };
        changed = true;
      }
    }
    if (changed) this.changed();
  }
}

class PetChannel implements Channel {
  readonly id: string;
  readonly capabilities: ChannelCapability[];
  private readonly inner: Channel;
  private readonly feed: PetFeed;

  constructor(inner: Channel, feed: PetFeed) {
    this.inner = inner;
    this.feed = feed;
    this.id = inner.id;
    this.capabilities = inner.capabilities;
  }

  setup(ui: SetupUI): Promise<ChannelBinding> {
    return this.inner.setup(ui);
  }

  async start(
    binding: ChannelBinding,
    sink: (inbound: Parameters<InboundSink>[0], source?: "local") => ReturnType<InboundSink>,
  ): Promise<void> {
    // The owner moved on in the chat: what they typed in the pet goes first, alone, so it is
    // never quoted on an answer to something else.
    await this.inner.start(binding, async (inbound) => {
      await this.feed.flush(this.inner);
      await sink(inbound);
    });
    this.feed.attach(binding, (inbound) => sink(inbound, "local"));
  }

  async stop(): Promise<void> {
    await this.feed.flush(this.inner);
    this.feed.detach(this.inner);
    await this.inner.stop();
  }

  async send(view: View): Promise<MessageRef> {
    const lines = this.feed.takeEcho(this.inner, view);
    if (lines === undefined) {
      const ref = await this.inner.send(view);
      this.feed.sent(ref, view);
      return ref;
    }
    const echo = echoQuote(lines);
    let ref: MessageRef;
    try {
      ref = await this.inner.send(withEcho(view, echo));
    } catch (error) {
      this.feed.returnEcho(this.inner, lines);
      throw error;
    }
    this.feed.rememberEcho(ref, echo);
    // The pet shows the Herder's words alone: the owner's line is already in its conversation.
    this.feed.sent(ref, view);
    return ref;
  }

  async update(ref: MessageRef, view: View): Promise<void> {
    const echo = this.feed.echoOf(ref);
    await this.inner.update(ref, echo === undefined ? view : withEcho(view, echo));
    this.feed.updated(ref, view);
  }

  pin(ref: MessageRef): Promise<void> {
    return this.inner.pin(ref);
  }
}
