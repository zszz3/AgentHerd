// The Herder: one resident session on a light model (docs/spec/04-herder.md §1, ADR 0018).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CompressionState } from "@agentherd/context-kernel";
import type {
  HerderContextSnapshot,
  HerderEvent,
  HerderHost,
  HerderPort,
  LetterDelivery,
  OwnerImage,
  Schedule,
  VoiceRequest,
} from "@agentherd/core";
import { countTokens, REVIEW_JOB } from "@agentherd/core";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@agentherd/herder-loop";
import { checkHerdUi, herdUiChoices } from "@agentherd/protocol/herd-ui";
import { guardCheck } from "@agentherd/rules";
import { type Api, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import {
  CONTEXT_STATE_KEY,
  CONTEXT_TOOL_NAMES,
  changedFrom,
  HerderContext,
  leadingSystem,
  promptOf,
  withoutContextMarks,
  withoutMarksDeep,
} from "./context.ts";
import { errorKind, HELD_RETRY_MS, RETRY_DELAYS_MS, shortError } from "./errors.ts";
import { herdUiFixPrompt, herdUiPrompt } from "./herd-ui-prompt.ts";
import { LOOKUP_TOOL_NAMES, type LookupOptions, lookupTools } from "./lookup.ts";
import { memoryTools, TURN_MEMORY_HEADING, turnMemory } from "./memory.ts";
import type { TierPlacement } from "./model-guide.ts";
import { PLUGIN_TOOL_NAMES, pluginTools } from "./plugin-tools.ts";
import {
  accountsPrompt,
  eventsPrompt,
  intakePrompt,
  lettersLine,
  lettersPrompt,
  nowLine,
  ownerAnswerPrompt,
  ownerMessagePrompt,
  quietReply,
  resumedNote,
  scheduledPrompt,
  systemPrompt,
  voicePrompt,
} from "./prompt.ts";
import { asksForQuiet, shouldStayQuiet } from "./quiet-check.ts";
import { stylePrompt, withoutEndPeriods } from "./style.ts";
import { sampleSuggestion } from "./suggest.ts";
import {
  herderTools,
  otherOption,
  pathsIn,
  pathsInAnswer,
  resolveProject,
  type TurnContext,
} from "./tools.ts";

export interface HerderOptions {
  host: HerderHost;
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  /** The model tiers, for picking and swapping a task's model (ADR 0028). Read on each use. */
  modelTiers?: () => TierPlacement;
  /** `service/model` of `model`, for telling the owner about a switch. */
  modelRef?: string;
  /** Other models to run on when this one keeps failing, best first (ADR 0037). */
  fallbacks?: () => HerderModel[];
  /** Waits before each retry of the same model. */
  retryDelaysMs?: number[];
  /** How often a held message is tried again. */
  heldRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock in ms, for tests. */
  now?: () => number;
  /** How web_search and web_read reach the web (ADR 0071); false leaves them out. */
  lookup?: LookupOptions | false;
  /** The working window the owner picked (ADR 0097), 0 for the model's whole; read each request. */
  contextCap?: () => number;
}

/** A model the Herder can run on. */
export interface HerderModel {
  ref: string;
  model: Model<Api>;
  apiKey?: string;
}

type Job = (
  | { kind: "owner"; text: string; images: OwnerImage[] }
  | { kind: "answer"; question: string; answer: string; ownerText?: string }
  | { kind: "intake"; text: string; auto: boolean; trial?: boolean }
  | { kind: "scheduled"; schedule: Schedule }
  | { kind: "letters"; delivery: LetterDelivery }
  | { kind: "voice"; request: VoiceRequest; done: (words: string | undefined) => void }
) & {
  recorded?: boolean;
  /** The owner's message or answer kept in herd.db until its turn ran (ADR 0062). */
  pendingId?: string;
  /** When it came, for one the last run received but did not finish. */
  resumedAt?: string;
};

/** Where the owner's messages and answers wait until their turn ran (ADR 0062). */
export const PENDING_STATE_KEY = "herder.pending";
/** A message older than this is not taken up after a restart: it is no longer what they want. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60_000;

/** An owner's message or answer kept until its turn ran. Images keep only their saved file. */
export type PendingMessage = { id: string; at: string; recorded?: boolean } & (
  | { kind: "owner"; text: string; images: { mimeType: string; path: string }[] }
  | { kind: "answer"; question: string; answer: string; ownerText: string }
);

type Attempt = { ok: true } | { ok: false; message: string; acted: boolean; overflow: boolean };

/**
 * The conversation is reviewed for things worth keeping once this many tokens of it have come in
 * since the last review (ADR 0101; OpenViking commits a session at about half its budget)…
 */
export const REVIEW_TOKENS = 20_000;
/** …or after this long without a turn, or when the conversation is folded. */
export const REVIEW_IDLE_MS = 10 * 60_000;

/** Where a turn's memory starts in its message; it is taken out again after the turn (ADR 0101). */
const TURN_MEMORY_MARK = `\n\n${TURN_MEMORY_HEADING} · `;

/** Events kept for the next owner turn; older ones are dropped. */
export const MAX_HELD_EVENTS = 10;

export class Herder implements HerderPort {
  private readonly host: HerderHost;
  private readonly agent: Agent;
  private readonly jobs: Job[] = [];
  private events: HerderEvent[] = [];
  private running: Promise<void> | undefined;
  private stopped = false;
  private turn: TurnContext = {
    kind: "owner",
    ownerText: "",
    typedText: "",
    images: [],
    asked: false,
    notified: false,
    pickedDirs: [],
  };
  /** The owner message an answer belongs to. */
  private lastOwnerText = "";
  private lastOwnerImages: OwnerImage[] = [];
  /** Whether the model reads images; otherwise it gets where they are saved. */
  private readonly seesImages: boolean;
  /** The whole conversation and its folds (ADR 0045). */
  private readonly context: HerderContext;
  /** The log as last written to the store, to write only what changed. */
  private saved: AgentMessage[];
  private current: HerderModel;
  private readonly fallbacks: () => HerderModel[];
  private readonly delays: number[];
  private readonly heldRetryMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** A message every model failed on; it runs before anything else (ADR 0037). */
  private held: Job | undefined;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  /** Tokens of conversation since the last review was queued (ADR 0101). */
  private reviewTokens = 0;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pending messages this Herder already queued, so a resume does not queue them twice. */
  private readonly queuedPending = new Set<string>();
  private resumed = false;
  private readonly streamFn: StreamFn;
  private readonly ownKey: HerderOptions["getApiKey"];
  /** The last request as sent: how many messages went in, and the folded view the model saw. */
  private lastView: { input: number; view: AgentMessage[] } | undefined;
  /** What each request of the current try was made of, in order (ADR 0093). */
  private sent: { snapshot: HerderContextSnapshot; prompt?: string }[] = [];
  /** The system prompt last kept in `herder_prompts`. */
  private keptPrompt: string | undefined;
  /** Where the message that started the current round sits (ADR 0095). */
  private round: number | undefined;
  /** Counts suggestion runs; a newer turn makes an older one stale (ADR 0084). */
  private suggestSeq = 0;
  private suggestAbort: AbortController | undefined;
  private suggesting: Promise<void> | undefined;

  constructor(opts: HerderOptions) {
    this.host = opts.host;
    this.current = { ref: opts.modelRef ?? opts.model.id, model: opts.model };
    this.fallbacks = opts.fallbacks ?? (() => []);
    this.delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.heldRetryMs = opts.heldRetryMs ?? HELD_RETRY_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const ownKey = opts.getApiKey;
    this.streamFn = opts.streamFn;
    this.ownKey = ownKey;
    this.seesImages = opts.model.input.includes("image");
    this.now = opts.now ?? (() => Date.now());
    const log = this.host.herderLog() as AgentMessage[];
    this.context = new HerderContext(
      {
        contextWindow: () => this.current.model.contextWindow,
        ...(opts.contextCap === undefined ? {} : { contextCap: opts.contextCap }),
        messages: () => this.agent.state.messages,
        audit: (type, data) => this.host.audit(type, data),
        event: (kind, data) => this.logEvent(kind, data),
      },
      log,
      this.host.getState<CompressionState>(CONTEXT_STATE_KEY),
      this.host.herderFolds?.() ?? [],
    );
    this.agent = new Agent({
      streamFn: opts.streamFn,
      getApiKey: async (provider) => this.current.apiKey ?? (await ownKey?.(provider)),
      beforeToolCall: async ({ toolCall, args }) => this.check(toolCall.name, args),
      transformContext: async (messages) => {
        const view = await this.context.project(messages);
        this.lastView = { input: messages.length, view };
        const prompt = this.keepPrompt(view);
        if (this.context.snapshot !== undefined) {
          this.sent.push({
            snapshot: this.context.snapshot,
            ...(prompt === undefined ? {} : { prompt }),
          });
        }
        return view;
      },
      initialState: {
        systemPrompt: this.fullSystemPrompt(),
        model: opts.model,
        thinkingLevel: "off",
        tools: [
          ...[
            ...herderTools(this.host, () => this.turn, opts.modelTiers),
            ...(this.host.memory === undefined
              ? []
              : memoryTools(this.host.memory, () => this.turn, this.host.embedder)),
            ...(opts.lookup === false ? [] : lookupTools(opts.lookup)),
            ...pluginTools(this.host),
          ].map(withoutMarksInArgs),
          ...this.context.tools(),
        ],
        messages: log,
      },
    });
    const messages = this.agent.state.messages;
    this.saved = messages.slice(leadingSystem(messages));
    // Folds kept in the state before ADR 0095, or straightened just now: into herder_folds at once.
    if (this.host.herderFolds?.().length === 0 || this.context.repaired.length > 0) {
      this.saveContext();
    }
    this.logEvent("start", {
      messages: this.saved.length,
      folds: this.context.state.blocks.filter((b) => b.active).length,
      repaired: this.context.repaired,
    });
  }

  /** Something that happened to the conversation, kept with the round it happened in. */
  private logEvent(kind: string, data: Record<string, unknown>): void {
    try {
      this.host.herderEvent?.(kind, data, this.round);
    } catch {
      // The event log is for the 上下文 tab; it never stops the Herder.
    }
    // A fold is a natural point to look back for what to keep (ADR 0101).
    if (kind === "fold") this.queueReview();
  }

  /** Keeps the system prompt and tools once per change; @returns their hash. */
  private keepPrompt(view: readonly AgentMessage[]): string | undefined {
    if (this.host.recordPrompt === undefined) return undefined;
    try {
      const prompt = promptOf(view);
      if (prompt === undefined) return undefined;
      if (prompt.hash !== this.keptPrompt) {
        this.host.recordPrompt(prompt);
        this.keptPrompt = prompt.hash;
      }
      return prompt.hash;
    } catch {
      return undefined;
    }
  }

  ownerMessage(text: string, images: OwnerImage[] = []): void {
    if (this.stopped) return;
    const id = this.keep({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      kind: "owner",
      text,
      images: images.map(({ mimeType, path }) => ({ mimeType, path })),
    });
    this.enqueue({ kind: "owner", text, images, pendingId: id });
  }

  ownerAnswer(question: string, answer: string): void {
    if (this.stopped) return;
    const id = this.keep({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      kind: "answer",
      question,
      answer,
      ownerText: this.lastOwnerText,
    });
    this.enqueue({ kind: "answer", question, answer, pendingId: id });
  }

  /**
   * Takes up the owner's messages and answers that the last run received but did not finish
   * (ADR 0062), oldest first. Each turn is told it came before the restart and may be done already.
   */
  resume(): void {
    if (this.resumed || this.stopped) return;
    this.resumed = true;
    const now = this.now();
    const kept: PendingMessage[] = [];
    for (const p of this.pending()) {
      if (this.queuedPending.has(p.id)) {
        kept.push(p);
        continue;
      }
      if (now - Date.parse(p.at) > PENDING_MAX_AGE_MS) {
        this.host.audit("herder.pending.dropped", { kind: p.kind, at: p.at });
        continue;
      }
      kept.push(p);
      this.queuedPending.add(p.id);
      const common = { pendingId: p.id, resumedAt: p.at, recorded: p.recorded === true };
      this.host.audit("herder.pending.resumed", { kind: p.kind, at: p.at });
      if (p.kind === "owner") {
        this.enqueue({ kind: "owner", text: p.text, images: savedImages(p.images), ...common });
      } else {
        const { question, answer, ownerText } = p;
        this.enqueue({ kind: "answer", question, answer, ownerText, ...common });
      }
    }
    this.host.setState(PENDING_STATE_KEY, kept);
  }

  /** New work for a turn; on a trial run the turn starts nothing (ADR 0064). */
  intake(text: string, auto: boolean, trial = false): void {
    this.enqueue({ kind: "intake", text, auto, ...(trial ? { trial: true } : {}) });
  }

  /** A schedule the owner made is due (ADR 0055). */
  scheduled(schedule: Schedule): void {
    this.enqueue({ kind: "scheduled", schedule });
  }

  /** Letters the mailbox brought, or the digest of the kept ones (ADR 0099). */
  letters(delivery: LetterDelivery): void {
    this.enqueue({ kind: "letters", delivery });
  }

  /**
   * Tells the owner a task's result in the Herder's words (ADR 0053), after the turns queued
   * before it. "" when it chose to say nothing; undefined when it could not speak.
   */
  voice(request: VoiceRequest): Promise<string | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    return new Promise((done) => this.enqueue({ kind: "voice", request, done }));
  }

  /**
   * Reports and alarms already reach the owner by themselves, so an event starts no turn: the
   * Herder only repeated them. They go with the owner's next message as context.
   */
  event(event: HerderEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_HELD_EVENTS) this.events.shift();
  }

  /** The owner tapped 「重试」, or the held timer fired: run the held message now. */
  retry(): void {
    const job = this.held;
    if (job === undefined || this.stopped) return;
    this.held = undefined;
    if (this.heldTimer !== undefined) clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    this.jobs.unshift(job);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reviewTimer !== undefined) clearTimeout(this.reviewTimer);
    if (this.heldTimer !== undefined) clearTimeout(this.heldTimer);
    for (const job of this.jobs) if (job.kind === "voice") job.done(undefined);
    this.jobs.length = 0;
    this.agent.abort();
    this.dropSuggestion();
    await this.running;
  }

  /** Resolves when every queued job has run. For tests. */
  async idle(): Promise<void> {
    while (this.running !== undefined || this.suggesting !== undefined) {
      await this.running;
      await this.suggesting;
    }
  }

  private enqueue(job: Job): void {
    if (this.stopped) return;
    this.jobs.push(job);
    // A new message is a good moment to try the held one again; it keeps its place first.
    if (this.held !== undefined) {
      this.retry();
      return;
    }
    this.kick();
  }

  private kick(): void {
    if (this.running === undefined) {
      this.running = this.drain().finally(() => {
        this.running = undefined;
      });
    }
  }

  private async drain(): Promise<void> {
    for (let job = this.jobs.shift(); job !== undefined && !this.stopped; job = this.jobs.shift()) {
      await this.runJob(job);
      // Handled, or given up on with the owner told: no longer waiting (ADR 0062). A held message,
      // or one a stop cut off, stays for the next try or the next start.
      if (job.pendingId !== undefined && this.held !== job && !this.stopped) {
        this.settle(job.pendingId);
      }
      if (this.held !== undefined) return; // Later messages wait behind the held one.
    }
  }

  private pending(): PendingMessage[] {
    return this.host.getState<PendingMessage[]>(PENDING_STATE_KEY) ?? [];
  }

  /** Writes the message to herd.db before its turn runs; returns its id. */
  private keep(message: PendingMessage): string {
    this.host.setState(PENDING_STATE_KEY, [...this.pending(), message]);
    this.queuedPending.add(message.id);
    return message.id;
  }

  private settle(id: string): void {
    this.queuedPending.delete(id);
    this.host.setState(
      PENDING_STATE_KEY,
      this.pending().filter((p) => p.id !== id),
    );
  }

  /** The owner's words are in the conversation record: a resumed turn must not add them again. */
  private markRecorded(id: string): void {
    this.host.setState(
      PENDING_STATE_KEY,
      this.pending().map((p) => (p.id === id ? { ...p, recorded: true } : p)),
    );
  }

  private async runJob(job: Job): Promise<void> {
    this.dropSuggestion();
    let prompt: string;
    let images: OwnerImage[] = [];
    if (job.kind === "owner") {
      images = job.images;
      this.lastOwnerText = job.text;
      this.lastOwnerImages = images;
      this.turn = {
        kind: "owner",
        ownerText: job.text,
        typedText: job.text,
        images,
        asked: false,
        notified: false,
        pickedDirs: pathsIn(job.text, this.host.userHome),
      };
      if (!job.recorded) this.host.recordTurn("owner", job.text);
      prompt = ownerMessagePrompt(job.text, images, this.host.texts);
    } else if (job.kind === "voice") {
      // Nothing the owner said: the turn may look things up but change nothing.
      this.turn = {
        kind: "event",
        ownerText: "",
        typedText: "",
        images: [],
        asked: false,
        notified: false,
        pickedDirs: [],
      };
      prompt = voicePrompt(job.request);
    } else if (job.kind === "scheduled") {
      // The saved words are the owner's, from the message that made the schedule.
      const { about, prompt: words, createdAt } = job.schedule;
      this.turn = {
        kind: "scheduled",
        ownerText: words,
        typedText: words,
        images: [],
        asked: false,
        notified: false,
        pickedDirs: pathsIn(words, this.host.userHome),
      };
      if (!job.recorded) this.host.recordTurn("event", `${about}: ${words}`);
      prompt = scheduledPrompt(about, words, createdAt);
    } else if (job.kind === "letters") {
      // Other people's words: the turn files them and may tell or ask the owner, nothing more.
      this.turn = {
        kind: "letters",
        ownerText: "",
        typedText: "",
        images: [],
        asked: false,
        notified: false,
        pickedDirs: [],
        filed: new Set<number>(),
      };
      if (!job.recorded) this.host.recordTurn("event", lettersLine(job.delivery));
      prompt = lettersPrompt(job.delivery);
    } else if (job.kind === "intake") {
      // The item's title is someone else's words: it can name the project (repository name)
      // but is quoted to the model as untrusted (ADR 0052).
      this.turn = {
        kind: "intake",
        ownerText: job.text,
        // Only the repository name may pick the project, not words of the title.
        typedText: /\S+\/(\S+)#\d+/.exec(job.text)?.[1] ?? "",
        images: [],
        asked: false,
        notified: false,
        pickedDirs: [],
        ...(job.trial === true ? { trial: true } : {}),
      };
      if (!job.recorded) this.host.recordTurn("event", job.text);
      prompt = intakePrompt(job.text, job.auto, job.trial === true);
    } else {
      if (this.lastOwnerText === "" && job.ownerText !== undefined)
        this.lastOwnerText = job.ownerText;
      const text = `${this.lastOwnerText}\n${job.answer}`;
      this.turn = {
        kind: "answer",
        ownerText: text,
        typedText: this.lastOwnerText,
        images: this.lastOwnerImages,
        asked: false,
        notified: false,
        // A picked button is a folder the owner chose; their earlier words may name one too.
        pickedDirs: [
          ...pathsInAnswer(job.answer, this.host.userHome),
          ...pathsIn(this.lastOwnerText, this.host.userHome),
        ],
      };
      if (!job.recorded) this.host.recordTurn("answer", job.answer);
      prompt = ownerAnswerPrompt(
        job.question,
        job.answer,
        job.answer.trim() === otherOption(this.host.locale),
      );
    }
    const firstRun = job.recorded !== true;
    job.recorded = true;
    if (firstRun && job.pendingId !== undefined) this.markRecorded(job.pendingId);
    // It came before a restart: the Herder may have acted on it already (ADR 0062).
    if (job.resumedAt !== undefined) prompt = `${resumedNote(job.resumedAt)}\n${prompt}`;
    if (this.events.length > 0) {
      for (const e of this.events) this.host.recordTurn("event", `${e.title}: ${e.text}`, e.taskId);
      prompt = `${eventsPrompt(this.events)}\n\n${prompt}`;
      this.events = [];
    }
    // In the message, not the system prompt, so the cached prefix stays the same.
    prompt = `${nowLine(this.now())}\n${prompt}`;
    // What memory has on this turn's subject, for this turn only (ADR 0101).
    const memory = await this.memoryFor(job);
    if (memory !== "") prompt = `${prompt}\n\n${memory}`;
    this.refreshSystemPrompt();
    this.host.audit("herder.turn", { kind: job.kind });
    const done = await this.runWithRetries(job, prompt, images);
    this.countForReview(prompt, done ? this.lastReply() : "");
    if (!done) {
      if (job.kind === "voice") job.done(undefined);
      return;
    }
    const raw = this.turn.asked ? "" : this.lastReply();
    // A model that writes its tool calls as text (DeepSeek's DSML) must not reach the owner.
    const said = beforeToolMarkup(raw);
    if (said !== raw) this.host.audit("herder.reply.markup", { kind: job.kind });
    // Chat style: no 「。」 at the end of a line (ADR 0088).
    const text = withoutEndPeriods(said === raw ? await this.readableBlocks(job, said) : said);
    // Tool calls written as text (not a repaired block) mean the voice cannot be trusted.
    if (job.kind === "voice" && said !== raw) {
      this.save();
      job.done(undefined);
      return;
    }
    if ((job.kind === "owner" || job.kind === "scheduled") && raw !== "" && text === "") {
      this.save();
      await this.host.alert(
        this.host.texts.herderFailed("the model wrote broken tool calls"),
        false,
      );
      return;
    }
    if (job.resumedAt !== undefined && quietReply(text)) {
      this.host.audit("herder.pending.quiet", { kind: job.kind });
      this.save();
      return;
    }
    if (job.kind === "scheduled" && quietReply(text)) {
      this.host.audit("schedule.quiet", { id: job.schedule.id });
      this.save();
      return;
    }
    // The owner said when to keep quiet; code checks the reply against that once more (ADR 0102).
    if (job.kind === "scheduled" && (await this.heldBack(job.schedule.prompt, text))) {
      this.host.audit("schedule.quiet", { id: job.schedule.id, by: "check" });
      this.save();
      return;
    }
    if (job.kind === "letters") this.fileTheRest(job.delivery);
    if (job.kind === "letters" && (quietReply(text) || text === "")) {
      this.host.audit("mailbox.quiet", { kind: job.delivery.kind });
      this.save();
      return;
    }
    if (job.kind === "voice" && quietReply(text)) {
      this.save();
      job.done("");
      return;
    }
    if (job.kind === "voice") {
      this.save();
      // The task sends it, as its report; an empty reply means the Herder could not say it.
      if (text !== "") this.host.recordTurn("herder", text, job.request.taskId);
      job.done(text === "" ? undefined : text);
      if (text !== "") this.suggestNext(text);
      return;
    }
    if (text !== "") {
      this.host.recordTurn("herder", text);
      await this.host.say(text);
    }
    this.save();
    if (text !== "" && job.kind !== "intake") this.suggestNext(text);
  }

  /** Letters the turn did not file are only noted, so none stays undecided (ADR 0099). */
  private fileTheRest(delivery: LetterDelivery): void {
    if (delivery.kind !== "new" || this.host.fileLetters === undefined) return;
    const filed = this.turn.filed ?? new Set<number>();
    const rest = delivery.groups
      .flatMap((g) => g.letters.map((l) => l.id))
      .filter((id) => !filed.has(id));
    if (rest.length === 0) return;
    try {
      this.host.fileLetters(rest.map((id) => ({ id, fate: "noted", why: "主管没有分拣" })));
    } catch (error) {
      this.host.audit("mailbox.file.error", { message: (error as Error).message });
    }
  }

  /** Stops a suggestion still being worked out; a new turn makes it stale (ADR 0084). */
  private dropSuggestion(): void {
    this.suggestSeq++;
    this.suggestAbort?.abort();
    this.suggestAbort = undefined;
  }

  /**
   * Whether a timer's reply goes against the owner's own words for it (「没有就不用说」): one small
   * request with no tools (ADR 0102). Only when those words say when to keep quiet.
   */
  private async heldBack(words: string, reply: string): Promise<boolean> {
    if (reply === "" || !asksForQuiet(words)) return false;
    const model = this.current.model;
    const apiKey = this.current.apiKey ?? (await this.ownKey?.(model.provider));
    return shouldStayQuiet({
      streamFn: this.streamFn,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      words,
      reply,
    });
  }

  /**
   * Works out what the owner might say next, the way Codex does it (ADR 0084): the last request
   * as it was sent, the reply it got, and one instruction more. Not after the first reply, not when
   * the reply offers answers or the Herder asked; dropped when anything happened meanwhile.
   */
  private suggestNext(reply: string): void {
    const hook = this.host.suggestion;
    if (hook === undefined || this.stopped || !hook.on()) return;
    if (this.turn.asked || herdUiChoices(reply).length > 0) return;
    const messages = this.agent.state.messages;
    const replies = messages.filter(
      (m) => m.role === "assistant" && m.content.some((c) => c.type === "text"),
    ).length;
    const last = this.lastView;
    // The last request must be the one that got this reply, with nothing in between.
    if (replies < 2 || last === undefined || messages.length !== last.input + 1) return;
    const answer = messages.at(-1);
    if (answer?.role !== "assistant") return;
    const seq = ++this.suggestSeq;
    const abort = new AbortController();
    this.suggestAbort = abort;
    const length = messages.length;
    const started = this.now();
    const run = async (): Promise<void> => {
      const model = this.current.model;
      const apiKey = this.current.apiKey ?? (await this.ownKey?.(model.provider));
      const input = await this.agent.convertToLlm([...last.view, answer]);
      const text = await sampleSuggestion({
        streamFn: this.streamFn,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        messages: input,
        locale: this.host.locale,
        signal: abort.signal,
      });
      const stale =
        seq !== this.suggestSeq || this.stopped || this.agent.state.messages.length !== length;
      this.host.audit("herder.suggestion", {
        shown: text !== undefined && !stale,
        stale,
        ms: this.now() - started,
      });
      if (text !== undefined && !stale) hook.show(text);
    };
    const running: Promise<void> = run()
      .catch(() => undefined)
      .finally(() => {
        if (this.suggesting === running) this.suggesting = undefined;
      });
    this.suggesting = running;
  }

  /**
   * The reply with its herd-ui blocks checked before anyone sees it (ADR 0074): blocks come out
   * repaired; a block that cannot be read at all gets one rewrite in the same turn, and if that
   * fails too the reply goes without it.
   */
  private async readableBlocks(job: Job, text: string): Promise<string> {
    const first = checkHerdUi(text);
    if (first.fences === 0) return text;
    if (first.problems.length > 0) {
      this.host.audit("herder.ui.problems", { kind: job.kind, problems: first.problems });
    }
    if (first.broken === 0 || this.stopped) return first.text;
    const fix = await this.attempt(herdUiFixPrompt(first.problems), []);
    const again = fix.ok && !this.turn.asked ? beforeToolMarkup(this.lastReply()) : "";
    const second = checkHerdUi(again);
    const fixed = again !== "" && second.broken === 0;
    this.host.audit("herder.ui.rewrite", { kind: job.kind, fixed });
    if (fixed) return second.text;
    // Still unreadable: the words around the blocks, or the reply as it was when nothing is left.
    return first.text.trim() === "" ? text : first.text;
  }

  /** Text of the Herder's last message, if it is the model's. */
  private lastReply(): string {
    const last = this.agent.state.messages.at(-1);
    if (last?.role !== "assistant") return "";
    return withoutContextMarks(
      last.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join(""),
    ).trim();
  }

  /**
   * Runs the turn (ADR 0037): transient errors retry the same model after each delay, then each
   * fallback model once. A key, balance or request error is not retried. When nothing works the
   * message is held and the owner told; it runs again on 「重试」, the next message or a timer.
   * A turn that already did something (a tool ran) is never run again: that could start a task twice.
   * @returns whether the turn finished.
   */
  private async runWithRetries(job: Job, prompt: string, images: OwnerImage[]): Promise<boolean> {
    let result = await this.attempt(prompt, images);
    // Too long for the model after all (the count is an estimate): fold old turns, try once more.
    if (!result.ok && result.overflow && !result.acted && this.context.foldForOverflow()) {
      this.host.audit("herder.context.overflow", { message: result.message });
      result = await this.attempt(prompt, images);
    }
    if (result.ok) return true;
    const first = result.message;
    if (!result.acted && errorKind(first) === "transient") {
      for (const delay of this.delays) {
        if (this.stopped) return false;
        this.host.audit("herder.retry", { kind: job.kind, message: result.message, delay });
        await this.sleep(delay);
        if (this.stopped) return false;
        result = await this.attempt(prompt, images);
        if (result.ok || result.acted || errorKind(result.message) === "fatal") break;
      }
    }
    if (!result.ok && !result.acted) {
      for (const next of this.fallbacks().filter((m) => m.ref !== this.current.ref)) {
        if (this.stopped) return false;
        const from = this.current;
        this.current = next;
        this.agent.state.model = next.model;
        result = await this.attempt(prompt, images);
        if (result.ok) {
          this.host.audit("herder.model-switched", { from: from.ref, to: next.ref, why: first });
          await this.host.alert(
            this.host.texts.herderSwitched(
              next.ref,
              shortError(first),
              errorKind(first) === "fatal",
            ),
            false,
          );
          return true;
        }
        if (result.acted) break;
        this.current = from;
        this.agent.state.model = from.model;
      }
    }
    if (result.ok) return true;
    this.host.audit("herder.error", { kind: job.kind, message: result.message });
    // A task result goes out without the Herder's words; the owner is not told the Herder failed.
    if (this.stopped || job.kind === "voice") return false;
    if (result.acted || errorKind(result.message) === "fatal") {
      await this.host.alert(this.host.texts.herderFailed(shortError(result.message)), false);
      return false;
    }
    this.held = job;
    this.heldTimer = setTimeout(() => this.retry(), this.heldRetryMs);
    this.heldTimer.unref?.();
    await this.host.alert(this.host.texts.herderHeld(shortError(result.message)), true);
    return false;
  }

  /**
   * The memory for one turn (ADR 0101): what the turn is about, looked up in memory. The owner's
   * words, a timer's job, the letters, a task's result or a question and its answer.
   */
  private async memoryFor(job: Job): Promise<string> {
    const memory = this.host.memory;
    if (memory === undefined) return "";
    try {
      return await turnMemory(memory, turnSubject(job, this.lastOwnerText), this.host.embedder);
    } catch (err) {
      this.host.audit("memory.recall.error", { message: String(err) });
      return "";
    }
  }

  /**
   * Counts what came in and queues a background review once enough has (ADR 0101), or after a
   * quiet spell.
   */
  private countForReview(prompt: string, reply: string): void {
    if (this.host.memory === undefined) return;
    this.reviewTokens += countTokens(withoutTurnMemoryText(prompt)) + countTokens(reply);
    if (this.reviewTimer !== undefined) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    if (this.reviewTokens >= REVIEW_TOKENS) {
      this.queueReview();
      return;
    }
    this.reviewTimer = setTimeout(() => this.queueReview(), REVIEW_IDLE_MS);
    this.reviewTimer.unref?.();
  }

  private queueReview(): void {
    const memory = this.host.memory;
    if (memory === undefined || this.reviewTokens === 0 || this.stopped) return;
    this.reviewTokens = 0;
    const waiting = memory
      .jobs(20)
      .some((j) => j.kind === REVIEW_JOB && (j.state === "pending" || j.state === "running"));
    if (waiting) return;
    const afterId = Number(memory.lastLog("review.done")?.ref ?? 0);
    memory.enqueueJob(REVIEW_JOB, { afterId });
  }

  /** The rules, then how to fold, then the memory: what changes least comes first, for the cache. */
  /** Which accounts are connected, for the system prompt (ADR 0089). */
  private accounts(): string {
    try {
      return accountsPrompt({
        socials: (this.host.socialWatches?.() ?? []).map((s) => ({ name: s.name, ready: s.ready })),
        apps: this.host.apps?.() ?? [],
        ...(this.host.plugins === undefined ? {} : { plugins: this.host.plugins.list() }),
      });
    } catch {
      return accountsPrompt({ socials: [], apps: [] });
    }
  }

  /** Rules and connected accounts; no memory, which comes with each turn instead (ADR 0101). */
  private fullSystemPrompt(): string {
    return `${systemPrompt(this.host.locale)}\n\n${stylePrompt()}\n\n${this.context.systemPrompt()}\n\n${herdUiPrompt()}\n\n${this.accounts()}`;
  }

  /**
   * The system prompt stays the same so the prompt cache holds; only a connected or disconnected
   * account changes it (ADR 0089). Old prompts that still carry memory are rebuilt once.
   */
  private refreshSystemPrompt(): void {
    const first = this.agent.state.messages[0];
    if (first?.role !== "system") return;
    const accountsChanged =
      typeof first.content === "string" && !first.content.includes(this.accounts());
    const oldMemory = typeof first.content === "string" && first.content.includes("\n\n[记忆 · ");
    if (!accountsChanged && !oldMemory) return;
    const prompt = this.fullSystemPrompt();
    if (first.content === prompt) return;
    this.agent.state.messages = [
      { ...first, content: prompt },
      ...this.agent.state.messages.slice(1),
    ];
  }

  /** One try. A failed try leaves no trace in the session. */
  private async attempt(prompt: string, images: OwnerImage[]): Promise<Attempt> {
    const before = this.agent.state.messages.length;
    const lead = leadingSystem(this.agent.state.messages);
    this.sent = [];
    // The prompt goes in at `before`: that message starts the round.
    this.round = before - lead;
    let message: string | undefined;
    let overflow = false;
    try {
      if (this.seesImages && images.length > 0) {
        await this.agent.prompt(
          prompt,
          images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
        );
      } else {
        await this.agent.prompt(prompt);
      }
      const last = this.agent.state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      ) {
        message = last.errorMessage ?? last.stopReason;
        overflow = isContextOverflow(last, this.current.model.contextWindow);
      }
    } catch (error) {
      message = (error as Error).message;
    }
    this.recordRequests(
      this.agent.state.messages.slice(before),
      before - lead,
      message === undefined,
    );
    if (message === undefined) return { ok: true };
    const added = this.agent.state.messages.slice(before);
    // Folding or reading the conversation changed nothing outside it, so the turn may run again.
    // Folding the conversation or looking something up changes nothing outside.
    const acted = added.some(
      (m) =>
        m.role === "toolResult" &&
        !CONTEXT_TOOL_NAMES.has(m.toolName) &&
        !LOOKUP_TOOL_NAMES.has(m.toolName) &&
        // The Herder's plugin tools are read-only (ADR 0094).
        !PLUGIN_TOOL_NAMES.has(m.toolName) &&
        m.toolName !== "stock_quote" &&
        m.toolName !== "fund_holdings",
    );
    this.agent.state.messages = this.agent.state.messages.slice(0, before);
    this.context.rollback(before - lead);
    this.save();
    return { ok: false, message, acted, overflow };
  }

  /**
   * Keeps what the provider counted for each request of a try, with what we sent (ADR 0093). Every
   * assistant message answers one request, in the order the snapshots were taken.
   */
  private recordRequests(added: readonly AgentMessage[], round: number, kept: boolean): void {
    const record = this.host.recordRequest;
    if (record === undefined) return;
    let n = 0;
    added.forEach((m, k) => {
      if (m.role !== "assistant") return;
      const sent = this.sent[n++];
      if (sent === undefined) return;
      const usage = m.usage;
      const counted = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
      try {
        record({
          at: new Date(m.timestamp > 0 ? m.timestamp : this.now()).toISOString(),
          model: `${m.provider}/${m.model}`,
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          cost: usage?.cost?.total ?? 0,
          tokens: counted > 0 ? counted : sent.snapshot.tokens,
          window: sent.snapshot.window,
          parts: sent.snapshot.parts,
          // A try that failed is taken back, so its replies have no place in the conversation.
          ...(kept ? { seq: round + k } : {}),
          round,
          ...(sent.prompt === undefined ? {} : { prompt: sent.prompt }),
          ...(m.stopReason === "error" ? { failed: true } : {}),
        });
      } catch {
        // Keeping numbers for the 上下文 tab must never break a turn.
      }
    });
    this.sent = [];
  }

  /** Guard list on every tool call (docs/spec/06-security.md). A hit blocks the call and tells the owner. */
  private async check(
    name: string,
    args: unknown,
  ): Promise<{ block: true; reason: string } | undefined> {
    this.host.audit("herder.tool", { name, args: args as Record<string, unknown> });
    if (name !== "session_start") return undefined;
    const project = (args as { project?: unknown }).project;
    if (typeof project !== "string") return undefined;
    let cwd: string;
    try {
      cwd = resolveProject(this.host, project);
    } catch {
      return undefined; // The tool itself reports an unknown project.
    }
    const result = guardCheck(
      { kind: "session_start", title: "session_start", paths: [cwd] },
      {
        cwd,
        home: this.host.userHome,
        protectedPaths: this.host.protectedPaths,
        protectedLocationFiles: this.host.protectedLocationFiles,
      },
    );
    if (!result.hit) return undefined;
    this.host.audit("herder.guard", { name, id: result.id, reason: result.reason });
    await this.host.say(this.host.texts.herderGuardHit(cwd, result.reason ?? result.id ?? ""));
    return { block: true, reason: `blocked by the guard list: ${result.reason}` };
  }

  /**
   * Saves the whole conversation (nothing is cut, ADR 0045): the messages from the first one that
   * changed since the last save, and the folds.
   */
  private save(): void {
    // Images are seen once; the text keeps where they are saved. Base64 in every later turn
    // would cost far more than it helps.
    this.agent.state.messages = this.agent.state.messages.map((m) =>
      withoutTurnMemory(withoutImages(m)),
    );
    const messages = this.agent.state.messages;
    const log = messages.slice(leadingSystem(messages));
    const from = changedFrom(this.saved, log);
    if (from < log.length || from < this.saved.length) {
      this.host.writeHerderLog(from, log.slice(from));
    }
    this.saved = log;
    this.saveContext();
  }

  /** The engine's bookkeeping and the folds that changed (ADR 0095); the whole state on old hosts. */
  private saveContext(): void {
    if (this.host.saveHerderContext === undefined || this.host.herderFolds === undefined) {
      this.host.setState(CONTEXT_STATE_KEY, this.context.state);
      return;
    }
    this.host.saveHerderContext(
      CONTEXT_STATE_KEY,
      this.context.bookkeeping(),
      this.context.changedFolds(this.saved),
    );
  }
}

/** Ref tags the model copied into a tool's arguments are removed before the tool sees them. */
function withoutMarksInArgs(tool: AgentTool): AgentTool {
  const prepare = tool.prepareArguments;
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const prepared = prepare === undefined ? args : prepare(args);
      return JSON.stringify(prepared)?.includes("<acp") ? withoutMarksDeep(prepared) : prepared;
    },
  } as AgentTool;
}

/** Seen once; without this note the model later reads only the path and thinks it never saw it. */
export const IMAGE_SEEN_NOTE =
  "[You saw the image(s) of this message when it arrived; they are no longer attached. Each is still saved at the path above. Ask the owner to send it again if you need to look again.]";

function withoutImages(m: AgentMessage): AgentMessage {
  if (m.role !== "user" || typeof m.content === "string") return m;
  if (!m.content.some((c) => c.type === "image")) return m;
  return {
    ...m,
    content: [
      ...m.content.filter((c) => c.type !== "image"),
      { type: "text", text: IMAGE_SEEN_NOTE },
    ],
  };
}

/**
 * Tool-call syntax some models write as plain text instead of calling the tool: DeepSeek's DSML
 * (`<｜DSML｜invoke>`, `</｜｜DSML｜｜ parameter>`) and its special tokens (`<｜tool▁calls▁begin｜>`).
 */
const TOOL_MARKUP = /<\/?[｜|]+\s*DSML|<[｜|]tool▁|<[｜|]end▁of▁sentence/;

/** The text before any leaked tool-call markup, trimmed; the text itself when there is none. */
export function beforeToolMarkup(text: string): string {
  const at = text.search(TOOL_MARKUP);
  if (at < 0) return text;
  // A broken context tag right before the markup is not text for the owner either.
  return text
    .slice(0, at)
    .replace(/<acp\b[^>]*>?[^<]*$/, "")
    .trim();
}

/** A turn's prompt without the memory that came with it. */
function withoutTurnMemoryText(text: string): string {
  const at = text.lastIndexOf(TURN_MEMORY_MARK);
  return at < 0 ? text : text.slice(0, at);
}

/**
 * A turn's memory is taken out of its message once the turn is over (ADR 0101): it is never saved,
 * and later turns do not carry it, only their own.
 */
function withoutTurnMemory(m: AgentMessage): AgentMessage {
  if (m.role !== "user") return m;
  if (typeof m.content === "string") {
    const text = withoutTurnMemoryText(m.content);
    return text === m.content ? m : { ...m, content: text };
  }
  if (!m.content.some((c) => c.type === "text" && c.text.includes(TURN_MEMORY_MARK))) return m;
  return {
    ...m,
    content: m.content.map((c) =>
      c.type === "text" ? { ...c, text: withoutTurnMemoryText(c.text) } : c,
    ),
  };
}

/** What a turn is about, to look up in memory (ADR 0101). */
function turnSubject(job: Job, lastOwnerText: string): string {
  switch (job.kind) {
    case "owner":
      return job.text;
    case "answer":
      return `${job.question}\n${job.answer}\n${lastOwnerText}`;
    case "scheduled":
      return `${job.schedule.about}\n${job.schedule.prompt}`;
    case "letters":
      return lettersSubject(job.delivery);
    case "intake":
      return job.text;
    case "voice":
      return `${job.request.title}\n${job.request.reply.slice(0, 1000)}`;
  }
}

function lettersSubject(delivery: LetterDelivery): string {
  return delivery.groups
    .map((g) => [g.name, g.note, ...g.letters.map((l) => l.title)].join("\n"))
    .join("\n");
}

/** Images of a message kept across a restart, read again from where they were saved. */
function savedImages(images: readonly { mimeType: string; path: string }[]): OwnerImage[] {
  return images.flatMap((image) => {
    try {
      return [{ ...image, data: readFileSync(image.path).toString("base64") }];
    } catch {
      return [];
    }
  });
}
