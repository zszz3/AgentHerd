// Feishu channel (docs/spec/05-channels.md §3). The owner check and duplicate handling live
// in the core; the channel turns Feishu payloads into `Inbound` and views into cards.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type {
  Channel,
  ChannelBinding,
  ChannelCapability,
  Inbound,
  InboundFile,
  InboundImage,
  InboundSink,
  Locale,
  MessageRef,
  SetupUI,
  View,
} from "@agentherd/protocol";
import { DEFAULT_LOCALE } from "@agentherd/protocol";
import { herdUiImageType, replyPictures } from "@agentherd/protocol/herd-ui";
import * as lark from "@larksuiteoapi/node-sdk";
import {
  type Brand,
  cardRefused,
  type FeishuApi,
  type FeishuCredentials,
  sdkApi,
  verifyCredentials,
} from "./api.ts";
import { renderCard } from "./card.ts";
import { plainHerdUiView } from "./herd-ui-card.ts";
import { type FeishuMessage, parseCardAction, parseFeishuMessage } from "./inbound.ts";
import { CARD_TEXTS } from "./texts.ts";

export const CHANNEL_ID = "feishu";

/** `im:resource` lets the channel upload the pictures the Herder shows (ADR 0075). */
export const SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:resource",
];
export const EVENTS = ["im.message.receive_v1"];
export const CALLBACKS = ["card.action.trigger"];

/** How long a card callback waits for the core before it answers without a new card. */
export const CALLBACK_WAIT_MS = 2000;

interface PendingCallback {
  answered: boolean;
  card?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** How many messages drawn the old way the channel remembers (see `Drawing`). */
const PLAIN_KEEP = 200;

/** Feishu takes pictures up to 10 MB (`im/v1/images`). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** How many uploaded pictures the channel remembers, by content. */
const UPLOADED_KEEP = 200;
/** A picture that failed to upload is not tried again for this long. */
export const IMAGE_RETRY_MS = 10 * 60 * 1000;

type Card = Record<string, unknown>;

/**
 * The card of one view on its way to Feishu. When Feishu refuses a card drawn from herd-ui
 * fences for what is in it (ADR 0074), the view is drawn once more the old way, as Markdown
 * with the old answer buttons, and put again; any other error is thrown as it is.
 */
class Drawing {
  private readonly view: View;
  private readonly locale: Locale;
  private readonly fallback: View | null;
  private readonly images: ReadonlyMap<string, string>;
  /** True once the view is drawn the old way. */
  plain: boolean;

  constructor(view: View, locale: Locale, plain: boolean, images: ReadonlyMap<string, string>) {
    this.view = view;
    this.locale = locale;
    this.images = images;
    this.fallback =
      view.kind === "item" && view.exactApproval !== undefined
        ? null
        : plainHerdUiView(view, CARD_TEXTS[locale]);
    this.plain = plain && this.fallback !== null;
  }

  card(): Card {
    // Drawn the old way, pictures are named by their path like everything else in the fences.
    if (this.plain && this.fallback !== null) return renderCard(this.fallback, this.locale);
    return renderCard(this.view, this.locale, this.images);
  }

  async put<T>(put: (card: Card) => Promise<T>): Promise<T> {
    try {
      return await put(this.card());
    } catch (error) {
      if (this.plain || this.fallback === null || !cardRefused(error)) throw error;
      this.plain = true;
      return put(this.card());
    }
  }
}

function openMessageId(payload: unknown): string | null {
  const root =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const event =
    root !== null && typeof root.event === "object" && root.event !== null ? root.event : root;
  const context = (event as Record<string, unknown> | null)?.context as
    | Record<string, unknown>
    | undefined;
  const id = context?.open_message_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export interface FeishuChannelOptions {
  /** Looks up the App Secret for an App ID (keychain, safeStorage, …). */
  getSecret(appId: string): Promise<string>;
  /** Stores the App Secret after setup. The binding never holds it. */
  saveSecret(appId: string, secret: string): Promise<void>;
  /** Test seam. Default: the SDK. */
  createApi?: (creds: FeishuCredentials) => FeishuApi;
  /** Test seam. Default: `registerApp` from the SDK. */
  register?: typeof lark.registerApp;
  /** Test seam. Default: tenant access token check. */
  verify?: (creds: FeishuCredentials) => Promise<void>;
  /** Called when a sink throws or a picture cannot be uploaded; the channel never throws back. */
  onError?: (error: Error) => void;
  /** Test seam. Default: `readPicture`, which reads a picture the Herder showed (ADR 0075). */
  readImage?: (path: string) => Promise<Uint8Array>;
  /** Test seam for the retry wait of failed uploads. Default: `Date.now`. */
  now?: () => number;
  /** Language of owner-facing text. Default: Chinese. */
  locale?: Locale;
}

export class FeishuChannel implements Channel {
  readonly id = CHANNEL_ID;
  readonly exactApproval = true;
  readonly capabilities: ChannelCapability[] = [
    "buttons",
    "free-text",
    "update-message",
    "pin",
    "table",
  ];
  private api: FeishuApi | null = null;
  private ownerId = "";
  private readonly callbacks = new Map<string, PendingCallback>();
  /** Messages whose herd-ui card Feishu refused: their updates are drawn the old way at once. */
  private readonly plain = new Set<string>();
  /** Image keys of pictures already uploaded, by a hash of their bytes. */
  private readonly uploaded = new Map<string, string>();
  /** Pictures that failed to upload, by path, with when they may be tried again. */
  private readonly failedImages = new Map<string, number>();

  private readonly opts: FeishuChannelOptions;
  private readonly locale: Locale;

  constructor(opts: FeishuChannelOptions) {
    this.opts = opts;
    this.locale = opts.locale ?? DEFAULT_LOCALE;
  }

  async setup(ui: SetupUI): Promise<ChannelBinding> {
    const register = this.opts.register ?? lark.registerApp;
    ui.showStatus("waiting-scan");
    const result = await register({
      source: "agentherd",
      createOnly: true,
      appPreset: { name: CARD_TEXTS[this.locale].appName, desc: CARD_TEXTS[this.locale].appDesc },
      addons: {
        scopes: { tenant: SCOPES },
        events: { items: { tenant: EVENTS } },
        callbacks: { items: CALLBACKS },
      },
      // No onStatusChange: its "polling" means authorization_pending, which Feishu answers
      // before and after the scan alike, so it cannot tell that the owner has scanned.
      onQRCodeReady: (info) => ui.showQrCode(info.url, info.expireIn),
    } as Parameters<typeof lark.registerApp>[0]);
    const ownerId = result.user_info?.open_id;
    if (ownerId === undefined || ownerId === "") {
      throw new Error("Feishu did not return the owner's open_id");
    }
    const brand: Brand = result.user_info?.tenant_brand ?? "feishu";
    const creds = { appId: result.client_id, appSecret: result.client_secret, brand };
    ui.showStatus("verifying");
    await (this.opts.verify ?? verifyCredentials)(creds);
    await this.opts.saveSecret(creds.appId, creds.appSecret);
    ui.showStatus("connected");
    return { channelId: CHANNEL_ID, ownerId, data: { appId: creds.appId, brand } };
  }

  async start(binding: ChannelBinding, sink: InboundSink): Promise<void> {
    const appId = binding.data.appId;
    if (appId === undefined || appId === "") throw new Error("feishu binding has no appId");
    const brand: Brand = binding.data.brand === "lark" ? "lark" : "feishu";
    const appSecret = await this.opts.getSecret(appId);
    this.ownerId = binding.ownerId;
    const api = (this.opts.createApi ?? sdkApi)({ appId, appSecret, brand });
    const deliver = async (inbound: Inbound | null) => {
      if (inbound === null) return;
      try {
        await sink(inbound);
      } catch (error) {
        this.opts.onError?.(error as Error);
      }
    };
    await api.connect({
      onMessage: async (payload) => {
        const message = parseFeishuMessage(payload);
        if (message !== null) await deliver(await this.withImages(api, message));
      },
      onCardAction: async (payload) => this.onCardAction(payload, deliver),
    });
    this.api = api;
  }

  async stop(): Promise<void> {
    await this.api?.close();
    this.api = null;
  }

  async send(view: View): Promise<MessageRef> {
    const api = this.requireApi();
    const drawing = new Drawing(view, this.locale, false, await this.pictures(api, view));
    let id: string | undefined;
    const reply = api.replyCard;
    if (view.kind === "text" && view.replyTo !== undefined && reply !== undefined) {
      const to = view.replyTo.id;
      try {
        id = await drawing.put((card) => reply.call(api, to, card));
      } catch {
        // The message is gone (recalled): send it on its own.
      }
    }
    id ??= await drawing.put((card) => api.sendCard(this.ownerId, card));
    if (drawing.plain) this.rememberPlain(id);
    return { channelId: CHANNEL_ID, id };
  }

  async update(ref: MessageRef, view: View): Promise<void> {
    const images =
      this.api === null ? new Map<string, string>() : await this.pictures(this.api, view);
    const drawing = new Drawing(view, this.locale, this.plain.has(ref.id), images);
    // During a card callback, Feishu keeps showing the old card if it is patched before the
    // callback is answered (seen in the M1 manual run). So an update of the tapped card goes
    // into the callback response instead.
    const pending = this.callbacks.get(ref.id);
    if (pending !== undefined && !pending.answered) {
      pending.card = drawing.card();
      return;
    }
    const api = this.requireApi();
    await drawing.put((card) => api.patchCard(ref.id, card));
    if (drawing.plain) this.rememberPlain(ref.id);
  }

  private rememberPlain(messageId: string): void {
    this.plain.add(messageId);
    if (this.plain.size <= PLAIN_KEEP) return;
    const oldest = this.plain.values().next().value;
    if (oldest !== undefined) this.plain.delete(oldest);
  }

  /**
   * Uploads the pictures (herd-ui `image` items) of a view and returns their image keys by
   * path (ADR 0075). The same bytes are uploaded once. A picture that cannot be read or
   * uploaded is left out, so the card names it by its path, and is not tried again for a
   * while; the reason goes to `onError`.
   */
  private async pictures(api: FeishuApi, view: View): Promise<Map<string, string>> {
    const text = view.kind === "text" ? view.text : view.kind === "report" ? view.body : "";
    const keys = new Map<string, string>();
    const upload = api.uploadImage;
    if (upload === undefined) return keys;
    const now = (this.opts.now ?? Date.now)();
    for (const path of replyPictures(text)) {
      if ((this.failedImages.get(path) ?? 0) > now) continue;
      try {
        const data = await (this.opts.readImage ?? readPicture)(path);
        const hash = createHash("sha256").update(data).digest("hex");
        let key = this.uploaded.get(hash);
        if (key === undefined) {
          key = await upload.call(api, data);
          this.uploaded.set(hash, key);
          if (this.uploaded.size > UPLOADED_KEEP) {
            const oldest = this.uploaded.keys().next().value;
            if (oldest !== undefined) this.uploaded.delete(oldest);
          }
        }
        keys.set(path, key);
        this.failedImages.delete(path);
      } catch (error) {
        this.failedImages.set(path, now + IMAGE_RETRY_MS);
        this.opts.onError?.(
          new Error(`picture ${path} not shown in Feishu: ${(error as Error).message}`),
        );
      }
    }
    return keys;
  }

  /** Downloads the images of a message. One that fails becomes a note in the text. */
  private async withImages(api: FeishuApi, m: FeishuMessage): Promise<Inbound> {
    const images: InboundImage[] = [];
    const notes: string[] = [];
    for (const key of m.imageKeys) {
      try {
        const file = await api.downloadImage(m.messageId, key);
        images.push({ mimeType: imageType(file.data, file.contentType), data: file.data });
      } catch (error) {
        notes.push(CARD_TEXTS[this.locale].imageFailed((error as Error).message));
      }
    }
    const files: InboundFile[] = [];
    for (const f of m.files) {
      try {
        const file = await api.downloadFile(m.messageId, f.key);
        files.push({ name: f.name, data: file.data });
      } catch (error) {
        notes.push(CARD_TEXTS[this.locale].fileFailed(f.name, (error as Error).message));
      }
    }
    const text = [m.text, ...notes].filter((t) => t !== "").join("\n");
    return {
      kind: "message",
      ...(m.nativeText === true ? { nativeText: true } : {}),
      text,
      from: m.from,
      ...(m.messageId === "" ? {} : { ref: { channelId: CHANNEL_ID, id: m.messageId } }),
      ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
      ...(images.length === 0 ? {} : { images }),
      ...(files.length === 0 ? {} : { files }),
    };
  }

  private async onCardAction(
    payload: unknown,
    deliver: (inbound: Inbound | null) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const toast = { type: "info", content: CARD_TEXTS[this.locale].toast };
    const messageId = openMessageId(payload);
    if (messageId === null) {
      void deliver(parseCardAction(payload));
      return { toast };
    }
    const pending: PendingCallback = { answered: false };
    this.callbacks.set(messageId, pending);
    try {
      // Feishu waits about 3 s for the answer; give the core most of it.
      const inbound = parseCardAction(payload);
      if (inbound?.kind === "action") inbound.cardRef = { channelId: CHANNEL_ID, id: messageId };
      await Promise.race([deliver(inbound), sleep(CALLBACK_WAIT_MS)]);
    } finally {
      pending.answered = true;
      if (this.callbacks.get(messageId) === pending) this.callbacks.delete(messageId);
    }
    if (pending.card === undefined) return { toast };
    return { toast, card: { type: "raw", data: pending.card } };
  }

  async pin(ref: MessageRef): Promise<void> {
    await this.requireApi().pin(ref.id);
  }

  private requireApi(): FeishuApi {
    if (this.api === null) throw new Error("feishu channel is not started");
    return this.api;
  }
}

/**
 * Reads a picture the Herder put in a reply, for upload (ADR 0075): a full path (`~/` is the
 * home folder) to a regular file with a picture's extension, at most `IMAGE_MAX_BYTES`, whose
 * bytes are a png, jpeg, gif or webp. Anything else is refused, so a reply cannot send other
 * files from this computer to Feishu.
 */
export async function readPicture(raw: string, home = homedir()): Promise<Uint8Array> {
  const path = normalize(raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("not a full path");
  if (herdUiImageType(path) === undefined) throw new Error("not a png, jpg, gif or webp file");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size === 0 || info.size > IMAGE_MAX_BYTES) {
    throw new Error(`size ${info.size} bytes is not between 1 byte and 10 MB`);
  }
  const data = new Uint8Array(await readFile(path));
  if (pictureType(data) === undefined) throw new Error("its bytes are not a picture");
  return data;
}

/** The picture type from its first bytes, or undefined when they are not png, jpeg, gif or webp. */
export function pictureType(data: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45) return "image/webp";
  return undefined;
}

/** The image type from its first bytes; Feishu may answer with a generic content type. */
export function imageType(data: Uint8Array, contentType?: string): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45) return "image/webp";
  if (starts(0x42, 0x4d)) return "image/bmp";
  const type = contentType?.split(";")[0]?.trim();
  return type?.startsWith("image/") === true ? type : "image/png";
}
