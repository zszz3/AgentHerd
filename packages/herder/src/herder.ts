// The Herder: one resident session on a light model (docs/spec/04-herder.md §1, ADR 0018).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CompressionState } from "@agentherd/context-kernel";
import type {
  HerderEvent,
  HerderHost,
  HerderPort,
  OwnerImage,
  Schedule,
  VoiceRequest,
} from "@agentherd/core";
import { REVIEW_JOB } from "@agentherd/core";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@agentherd/herder-loop";
import { DEFAULT_HERDER_STYLE, type HerderStyle } from "@agentherd/protocol";
import { guardCheck } from "@agentherd/rules";
import { type Api, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import {
  CONTEXT_STATE_KEY,
  CONTEXT_TOOL_NAMES,
  changedFrom,
  HerderContext,
  leadingSystem,
  withoutContextMarks,
  withoutMarksDeep,
} from "./context.ts";
import { errorKind, HELD_RETRY_MS, RETRY_DELAYS_MS, shortError } from "./errors.ts";
import { memorySnapshot, memoryTools, recallBlock } from "./memory.ts";
import type { TierPlacement } from "./model-guide.ts";
import {
  eventsPrompt,
  intakePrompt,
  nowLine,
  ownerAnswerPrompt,
  ownerMessagePrompt,
  QUIET,
  resumedNote,
  scheduledPrompt,
  systemPrompt,
  voicePrompt,
} from "./prompt.ts";
import { stylePrompt } from "./style.ts";
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

/** A pause after which the memory in the system prompt is rebuilt. */
export const MEMORY_REFRESH_MS = 60 * 60_000;

/** A review of the conversation for lasting things runs after this many owner messages… */
export const REVIEW_EVERY_TURNS = 6;
/** …or after this long without one. */
export const REVIEW_IDLE_MS = 2 * 60_000;

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
  /** When the last turn ran; after a long pause the memory in the system prompt is rebuilt. */
  private lastTurnAt = 0;
  private ownerTurnsSinceReview = 0;
  /** The style in the system prompt now. */
  private style: HerderStyle = DEFAULT_HERDER_STYLE;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pending messages this Herder already queued, so a resume does not queue them twice. */
  private readonly queuedPending = new Set<string>();
  private resumed = false;

  constructor(opts: HerderOptions) {
    this.host = opts.host;
    this.current = { ref: opts.modelRef ?? opts.model.id, model: opts.model };
    this.fallbacks = opts.fallbacks ?? (() => []);
    this.delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.heldRetryMs = opts.heldRetryMs ?? HELD_RETRY_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const ownKey = opts.getApiKey;
    this.seesImages = opts.model.input.includes("image");
    this.now = opts.now ?? (() => Date.now());
    const log = this.host.herderLog() as AgentMessage[];
    this.context = new HerderContext(
      {
        contextWindow: () => this.current.model.contextWindow,
        messages: () => this.agent.state.messages,
        audit: (type, data) => this.host.audit(type, data),
      },
      log,
      this.host.getState<CompressionState>(CONTEXT_STATE_KEY),
    );
    this.agent = new Agent({
      streamFn: opts.streamFn,
      getApiKey: async (provider) => this.current.apiKey ?? (await ownKey?.(provider)),
      beforeToolCall: async ({ toolCall, args }) => this.check(toolCall.name, args),
      transformContext: async (messages) => this.context.project(messages),
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
          ].map(withoutMarksInArgs),
          ...this.context.tools(),
        ],
        messages: log,
      },
    });
    const messages = this.agent.state.messages;
    this.saved = messages.slice(leadingSystem(messages));
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
    await this.running;
  }

  /** Resolves when every queued job has run. For tests. */
  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running;
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
      const recall =
        this.host.memory === undefined
          ? ""
          : await recallBlock(this.host.memory, job.text, this.host.embedder);
      if (recall !== "") prompt = `${prompt}\n\n${recall}`;
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
    this.refreshSystemPrompt();
    this.host.audit("herder.turn", { kind: job.kind });
    const done = await this.runWithRetries(job, prompt, images);
    if (job.kind === "owner") this.countForReview();
    if (!done) {
      if (job.kind === "voice") job.done(undefined);
      return;
    }
    const raw = this.turn.asked ? "" : this.lastReply();
    // A model that writes its tool calls as text (DeepSeek's DSML) must not reach the owner.
    const text = beforeToolMarkup(raw);
    if (text !== raw) this.host.audit("herder.reply.markup", { kind: job.kind });
    if (job.kind === "voice" && text !== raw) {
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
    if (job.resumedAt !== undefined && text.includes(QUIET)) {
      this.host.audit("herder.pending.quiet", { kind: job.kind });
      this.save();
      return;
    }
    if (job.kind === "scheduled" && text.includes(QUIET)) {
      this.host.audit("schedule.quiet", { id: job.schedule.id });
      this.save();
      return;
    }
    if (job.kind === "voice" && text.includes(QUIET)) {
      this.save();
      job.done("");
      return;
    }
    if (job.kind === "voice") {
      this.save();
      // The task sends it, as its report; an empty reply means the Herder could not say it.
      if (text !== "") this.host.recordTurn("herder", text, job.request.taskId);
      job.done(text === "" ? undefined : text);
      return;
    }
    if (text !== "") {
      this.host.recordTurn("herder", text);
      await this.host.say(text);
    }
    this.save();
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

  /** Queues a background review every few owner messages or after a quiet spell (ADR 0038). */
  private countForReview(): void {
    if (this.host.memory === undefined) return;
    this.ownerTurnsSinceReview++;
    if (this.reviewTimer !== undefined) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    if (this.ownerTurnsSinceReview >= REVIEW_EVERY_TURNS) {
      this.queueReview();
      return;
    }
    this.reviewTimer = setTimeout(() => this.queueReview(), REVIEW_IDLE_MS);
    this.reviewTimer.unref?.();
  }

  private queueReview(): void {
    const memory = this.host.memory;
    if (memory === undefined || this.ownerTurnsSinceReview === 0 || this.stopped) return;
    this.ownerTurnsSinceReview = 0;
    const waiting = memory
      .jobs(20)
      .some((j) => j.kind === REVIEW_JOB && (j.state === "pending" || j.state === "running"));
    if (waiting) return;
    const afterId = Number(memory.lastLog("review.done")?.ref ?? 0);
    memory.enqueueJob(REVIEW_JOB, { afterId });
  }

  /** The rules, then how to fold, then the memory: what changes least comes first, for the cache. */
  private fullSystemPrompt(): string {
    this.style = this.host.style?.() ?? DEFAULT_HERDER_STYLE;
    const base = `${systemPrompt(this.host.locale)}\n\n${stylePrompt(this.style)}\n\n${this.context.systemPrompt()}`;
    const snapshot = this.host.memory === undefined ? "" : memorySnapshot(this.host.memory);
    return snapshot === "" ? base : `${base}\n\n${snapshot}`;
  }

  /**
   * The system prompt keeps the memory as it was when the conversation started, so the prompt
   * cache holds. After {@link MEMORY_REFRESH_MS} without a turn it is rebuilt with what was learnt.
   */
  private refreshSystemPrompt(): void {
    const now = this.now();
    const stale = this.lastTurnAt !== 0 && now - this.lastTurnAt >= MEMORY_REFRESH_MS;
    this.lastTurnAt = now;
    // A new style takes effect at once (ADR 0053); it costs one cache miss.
    const restyled = (this.host.style?.() ?? DEFAULT_HERDER_STYLE) !== this.style;
    if (!restyled && (!stale || this.host.memory === undefined)) return;
    const first = this.agent.state.messages[0];
    if (first?.role !== "system") return;
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
    if (message === undefined) return { ok: true };
    const added = this.agent.state.messages.slice(before);
    // Folding or reading the conversation changed nothing outside it, so the turn may run again.
    const acted = added.some((m) => m.role === "toolResult" && !CONTEXT_TOOL_NAMES.has(m.toolName));
    const lead = leadingSystem(this.agent.state.messages);
    this.agent.state.messages = this.agent.state.messages.slice(0, before);
    this.context.rollback(before - lead);
    this.save();
    return { ok: false, message, acted, overflow };
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
      { cwd, home: this.host.userHome },
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
    this.agent.state.messages = this.agent.state.messages.map(withoutImages);
    const messages = this.agent.state.messages;
    const log = messages.slice(leadingSystem(messages));
    const from = changedFrom(this.saved, log);
    if (from < log.length || from < this.saved.length) {
      this.host.writeHerderLog(from, log.slice(from));
    }
    this.saved = log;
    this.host.setState(CONTEXT_STATE_KEY, this.context.state);
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
