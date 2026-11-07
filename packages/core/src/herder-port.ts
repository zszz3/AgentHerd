// What the Herd and the Herder know about each other (docs/spec/04-herder.md §1). The core does
// not import the Herder or any model library: the CLI or the app passes a factory.

import type { Locale } from "@agentherd/protocol";
import type { Completer, Embedder, MemoryStore } from "./memory-store.ts";
import type { DecisionRow, MailWatch } from "./store.ts";
import type { Task } from "./tasks.ts";
import type { CoreTexts } from "./texts.ts";

/** An image the owner sent, saved under `<home>/attachments`. */
export interface OwnerImage {
  mimeType: string;
  /** Base64. */
  data: string;
  /** Where the image is saved, for agents and models that cannot take images. */
  path: string;
}

/** Who said a line of the Herder's conversation: `owner` typed, `answer` is a button pick. */
export type HerderTurnRole = "owner" | "answer" | "herder" | "ask" | "event";

export interface HerderEvent {
  kind: "task-reported" | "watchdog" | "github" | "mail";
  /** The task it is about; mail is about no task. */
  taskId?: string;
  /** The task's title, or for mail what the owner asked to hear about. */
  title: string;
  /** Text that came from an agent. Untrusted. */
  text: string;
}

/** Everything the Herder can do. There is deliberately nothing here that answers an item. */
export interface HerderHost {
  readonly locale: Locale;
  readonly texts: CoreTexts;
  readonly userHome: string;
  profiles(): { id: string; name: string }[];
  tasks(): Task[];
  openTasks(): Task[];
  relayTaskId(): string | undefined;
  decisions(limit: number): DecisionRow[];
  /** Models in the owner's list ("service/model") and the profile ids that can run each. */
  models(): { ref: string; agents: string[] }[];
  /** Whether a model answers now; true when there is nothing to check with. */
  checkModel(ref: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * `title` is the task's short name, chosen by the Herder; `prompt` is what the agent receives. `model` ("service/model")
   * runs the agent with that model; without it the agent uses its own settings.
   */
  startTask(
    profileId: string,
    /** The owner's project folder; undefined for a task that needs none (a scratch folder). */
    cwd: string | undefined,
    title: string,
    prompt: string,
    model?: string,
    images?: OwnerImage[],
  ): Promise<string>;
  promptTask(taskId: string, text: string, images?: OwnerImage[]): void;
  /** A new short name for a task, when its work changed. */
  renameTask(taskId: string, name: string): void;
  cancelTurn(taskId: string): Promise<void>;
  /** Closes a task for good because the owner said it is finished. */
  endTask(taskId: string): Promise<void>;
  startRelay(taskId: string): Promise<void>;
  endRelay(): Promise<void>;
  say(text: string): Promise<void>;
  /** A red card from the Herder (ADR 0037); `retry` adds a 「重试」 button that calls {@link HerderPort.retry}. */
  alert(text: string, retry: boolean): Promise<void>;
  ask(text: string, options: string[]): Promise<void>;
  /** Names of the owner's connected apps; agents other than Pi use them (docs/spec/09-agent-tools.md §3). */
  apps?(): string[];
  /** Mail the owner asked to hear about (ADR 0048); absent without connected apps. */
  mailWatches?(): MailWatch[];
  /** Starts telling the owner about mail matching a Gmail search; throws when Gmail cannot be read. */
  watchMail?(about: string, query: string): Promise<MailWatch>;
  unwatchMail?(id: string): boolean;
  audit(type: string, data: Record<string, unknown>): void;
  /** Keeps a line of the Herder's conversation with the owner (`herder_turns`). */
  recordTurn(role: HerderTurnRole, text: string, taskId?: string): void;
  /** The Herder's long-term memory (ADR 0038); absent in tests that do not use it. */
  readonly memory?: MemoryStore;
  /** Vectors for memory search; absent or not ready → keyword search alone. */
  readonly embedder?: Embedder;
  /** A cheap model for small judgements such as ranking past cases; absent → skip them. */
  readonly memoryComplete?: Completer;
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
  /** The Herder's whole conversation as the model saw it, oldest first (ADR 0045). */
  herderLog(): unknown[];
  /** Replaces the saved conversation from position `from` on with `messages`. */
  writeHerderLog(from: number, messages: unknown[]): void;
}

/** Card action target of the 「重试」 button on a held Herder message. */
export const HERDER_RETRY_TARGET = "herder";

/** Calls return at once; the Herder works through them one at a time. */
export interface HerderPort {
  /** `text` may be empty when the owner sent only images. */
  ownerMessage(text: string, images?: OwnerImage[]): void;
  ownerAnswer(question: string, answer: string): void;
  event(event: HerderEvent): void;
  /** Runs a message held after every model failed (the owner tapped 「重试」). */
  retry?(): void;
  stop(): Promise<void>;
}

export type HerderFactory = (host: HerderHost) => HerderPort;
