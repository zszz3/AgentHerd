// Messages for the owner are stored before they are sent and kept until the channel took them
// (docs/spec/04-herder.md "Delivery"). A failed send is retried with a growing delay, and what a
// crash or stop left unsent goes out after the next start.

import { randomUUID } from "node:crypto";
import type { Channel, MessageRef, View } from "@agentherd/protocol";
import type { Clock, Timer } from "./clock.ts";
import type { OutboxRow, Store } from "./store.ts";

/** First retry delay; it doubles up to OUTBOX_MAX_DELAY_MS. */
export const OUTBOX_FIRST_DELAY_MS = 2_000;
export const OUTBOX_MAX_DELAY_MS = 60_000;
/** A message the channel did not take for this long is dropped (and audited). */
export const OUTBOX_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export function retryDelay(attempts: number): number {
  return Math.min(OUTBOX_FIRST_DELAY_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_DELAY_MS);
}

export class Outbox {
  private timer: Timer | undefined;
  private timerAt = Number.POSITIVE_INFINITY;
  private readonly sending = new Set<string>();
  private running = false;

  private readonly channel: Channel;
  private readonly store: Store;
  private readonly clock: Clock;

  constructor(channel: Channel, store: Store, clock: Clock) {
    this.channel = channel;
    this.store = store;
    this.clock = clock;
  }

  /** Sends what an earlier run left unsent and retries from now on. */
  start(): void {
    this.running = true;
    void this.flush(true);
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Stores the view, then sends it. Returns the channel's reference once it took the message;
   * `undefined` when it did not (yet): the message is retried later and never thrown.
   */
  async send(view: View, taskId?: string): Promise<MessageRef | undefined> {
    const now = this.clock.now().toISOString();
    const row: OutboxRow = {
      id: randomUUID(),
      view,
      ...(taskId === undefined ? {} : { taskId }),
      attempts: 0,
      nextAt: now,
      createdAt: now,
    };
    try {
      this.store.addOutbox(row);
    } catch (error) {
      // herd.db is not writable: still try to send once.
      this.store.audit("send.error", { kind: view.kind, message: (error as Error).message });
    }
    return this.attempt(row);
  }

  /** Messages still waiting for the channel. */
  pending(): number {
    return this.store.outbox().length;
  }

  private async attempt(row: OutboxRow): Promise<MessageRef | undefined> {
    if (this.sending.has(row.id)) return undefined;
    this.sending.add(row.id);
    try {
      const ref = await this.channel.send(row.view);
      this.store.deleteOutbox(row.id);
      if (row.taskId !== undefined && typeof ref?.id === "string") {
        this.store.linkMessage(ref.id, row.taskId);
      }
      if (row.attempts > 0) {
        this.store.audit("send.retried", { kind: row.view.kind, attempts: row.attempts });
      }
      return ref;
    } catch (error) {
      this.failed(row, (error as Error).message);
      return undefined;
    } finally {
      this.sending.delete(row.id);
    }
  }

  private failed(row: OutboxRow, message: string): void {
    const now = this.clock.now().getTime();
    const attempts = row.attempts + 1;
    this.store.audit("send.error", { kind: row.view.kind, attempts, message });
    if (now - Date.parse(row.createdAt) >= OUTBOX_GIVE_UP_MS) {
      this.store.deleteOutbox(row.id);
      this.store.audit("send.dropped", { kind: row.view.kind, attempts, message });
      return;
    }
    const nextAt = now + retryDelay(attempts);
    try {
      this.store.addOutbox({
        ...row,
        attempts,
        nextAt: new Date(nextAt).toISOString(),
        error: message,
      });
    } catch {
      return;
    }
    this.schedule(nextAt);
  }

  private schedule(at: number): void {
    if (!this.running || at >= this.timerAt) return;
    this.timer?.cancel();
    this.timerAt = at;
    const delay = Math.max(0, at - this.clock.now().getTime());
    this.timer = this.clock.after(delay, () => {
      this.timer = undefined;
      this.timerAt = Number.POSITIVE_INFINITY;
      void this.flush();
    });
  }

  /** Sends every due message (with `all`, every message) in order; schedules the next retry. */
  private async flush(all = false): Promise<void> {
    if (!this.running) return;
    let rows: OutboxRow[];
    try {
      rows = this.store.outbox();
    } catch {
      return;
    }
    const now = this.clock.now().getTime();
    let next = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (!this.running) return;
      const at = Date.parse(row.nextAt);
      if (!all && at > now) {
        next = Math.min(next, at);
        continue;
      }
      await this.attempt(row);
    }
    if (next !== Number.POSITIVE_INFINITY) this.schedule(next);
  }
}
