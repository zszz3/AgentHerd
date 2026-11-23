// Local vectors for the Herder's memory search (ADR 0038): a small Chinese/English model
// (bge-small-zh-v1.5, 8-bit, ~24 MB) run with ONNX in this process. It is downloaded once into
// <home>/models, from Hugging Face or its mirror. Until it is ready, or when it cannot load, search
// uses keywords alone.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "@agentherd/core";
import { hostDataPaths } from "./data-home-paths.ts";

export const EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
/** Where the model files come from; the mirror works where huggingface.co is blocked. */
export const MODEL_HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];
/** After a failed load, wait this long before trying again. */
export const RETRY_LOAD_MS = 10 * 60_000;

type Extract = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly model = EMBED_MODEL;
  private readonly dir: string;
  private readonly log: (line: string) => void;
  private extract: Extract | undefined;
  private loading: Promise<void> | undefined;
  private failedAt = 0;

  constructor(home: string, log: (line: string) => void = () => {}) {
    this.dir = join(home, hostDataPaths.models.relative);
    this.log = log;
  }

  /** Starts loading (and downloading, the first time) in the background. */
  warm(): void {
    void this.load();
  }

  async embed(texts: readonly string[]): Promise<Float32Array[] | undefined> {
    if (texts.length === 0) return [];
    await this.load();
    const extract = this.extract;
    if (extract === undefined) return undefined;
    const out = await extract([...texts], { pooling: "mean", normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  }

  private load(): Promise<void> {
    if (this.extract !== undefined) return Promise.resolve();
    if (this.loading !== undefined) return this.loading;
    if (this.failedAt !== 0 && Date.now() - this.failedAt < RETRY_LOAD_MS) return Promise.resolve();
    this.loading = this.tryLoad().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async tryLoad(): Promise<void> {
    let lib: typeof import("@huggingface/transformers");
    try {
      lib = await import("@huggingface/transformers");
    } catch (error) {
      this.fail(`cannot load the vector library: ${(error as Error).message}`);
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    lib.env.cacheDir = this.dir;
    for (const host of MODEL_HOSTS) {
      lib.env.remoteHost = host;
      try {
        const started = Date.now();
        const pipe = await lib.pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
        this.extract = pipe as unknown as Extract;
        this.failedAt = 0;
        this.log(`[memory] vector model ready in ${Date.now() - started} ms`);
        return;
      } catch (error) {
        this.log(`[memory] vector model from ${host} failed: ${(error as Error).message}`);
      }
    }
    this.fail("no model host answered; memory search uses keywords only");
  }

  private fail(why: string): void {
    this.failedAt = Date.now();
    this.log(`[memory] ${why}`);
  }
}
