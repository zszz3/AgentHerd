import type { Inbound } from "@agentherd/protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SDK may deliver events nested under `event` or flattened to the top level. */
function eventRoot(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.event)) return payload.event;
  return payload;
}

/**
 * Parse a Feishu `card.action.trigger` payload into an inbound action. Returns null on any
 * shape it does not recognize. A `value` that arrives as a JSON string is parsed first.
 */
export function parseCardAction(payload: unknown): Inbound | null {
  const data = eventRoot(payload);
  if (data === null) return null;

  const operator = isRecord(data.operator) ? data.operator : null;
  const openId =
    operator !== null && typeof operator.open_id === "string" ? operator.open_id : null;
  if (openId === null || openId === "") return null;

  const action = isRecord(data.action) ? data.action : null;
  if (action === null) return null;

  let value: unknown = action.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const target = typeof value.target === "string" ? value.target : null;
  const act = typeof value.action === "string" ? value.action : null;
  if (target === null || act === null || target === "" || act === "") return null;

  return { kind: "action", target, action: act, from: openId };
}

/** An owner message as Feishu sent it; images are still keys to download. */
export interface FeishuMessage {
  messageId: string;
  nativeText?: true;
  text: string;
  from: string;
  replyTo?: { channelId: "feishu"; id: string };
  imageKeys: string[];
  /** File, audio and video messages: the key to download and the name to save it under. */
  files: { key: string; name: string }[];
}

/**
 * Parse a Feishu `im.message.receive_v1` payload: `text`, `image`, rich text (`post`, its
 * text and images), and `file`, `audio` and `media` (video) messages as files. Returns null for non-p2p chats, other message types, non-user senders, bad
 * JSON, or a message with neither text nor images.
 */
export function parseFeishuMessage(payload: unknown): FeishuMessage | null {
  const data = eventRoot(payload);
  if (data === null) return null;

  const sender = isRecord(data.sender) ? data.sender : null;
  if (sender === null || sender.sender_type !== "user") return null;

  const senderId = isRecord(sender.sender_id) ? sender.sender_id : null;
  const openId =
    senderId !== null && typeof senderId.open_id === "string" ? senderId.open_id : null;
  if (openId === null || openId === "") return null;

  const message = isRecord(data.message) ? data.message : null;
  if (message === null || message.chat_type !== "p2p") return null;
  if (typeof message.content !== "string") return null;

  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return null;
  }
  if (!isRecord(content)) return null;

  let text = "";
  const imageKeys: string[] = [];
  const files: { key: string; name: string }[] = [];
  switch (message.message_type) {
    case "text":
      text = typeof content.text === "string" ? content.text.trim() : "";
      break;
    case "image":
      if (typeof content.image_key === "string" && content.image_key !== "") {
        imageKeys.push(content.image_key);
      }
      break;
    case "post":
      text = postText(postBody(content), imageKeys);
      break;
    case "file":
    case "audio":
    case "media": {
      const key = content.file_key;
      if (typeof key !== "string" || key === "") break;
      const given = typeof content.file_name === "string" ? content.file_name : "";
      const fallback = message.message_type === "audio" ? `${key}.opus` : key;
      files.push({ key, name: given === "" ? fallback : given });
      break;
    }
    default:
      return null;
  }
  if (text === "" && imageKeys.length === 0 && files.length === 0) return null;

  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const parsed: FeishuMessage = { messageId, text, from: openId, imageKeys, files };
  if (message.message_type === "text") parsed.nativeText = true;
  const parentId = typeof message.parent_id === "string" ? message.parent_id : null;
  if (parentId !== null && parentId !== "") parsed.replyTo = { channelId: "feishu", id: parentId };
  return parsed;
}

/** A received post is `{title, content}`; a sent one may be wrapped in a language key. */
function postBody(content: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(content.content)) return content;
  for (const value of Object.values(content)) {
    if (isRecord(value) && Array.isArray(value.content)) return value;
  }
  return content;
}

/** The text of a post, one line per paragraph; image keys go into `images`. */
function postText(post: Record<string, unknown>, images: string[]): string {
  const lines: string[] = [];
  if (typeof post.title === "string" && post.title.trim() !== "") lines.push(post.title.trim());
  const paragraphs = Array.isArray(post.content) ? post.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const node of paragraph) {
      if (!isRecord(node)) continue;
      if (node.tag === "img" && typeof node.image_key === "string" && node.image_key !== "") {
        images.push(node.image_key);
      } else if (node.tag === "at") {
        line += typeof node.user_name === "string" ? `@${node.user_name}` : "";
      } else if (node.tag === "a") {
        const label = typeof node.text === "string" ? node.text : "";
        const href = typeof node.href === "string" ? node.href : "";
        line += href !== "" && href !== label ? `${label} (${href})` : label;
      } else if (node.tag === "code_block") {
        line += typeof node.text === "string" ? `\n${node.text}\n` : "";
      } else if (typeof node.text === "string") {
        line += node.text;
      }
    }
    // A paragraph that is only an image leaves no empty line behind.
    if (line.trim() !== "") lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * Parse a Feishu `im.message.receive_v1` payload into an inbound owner message without its
 * images. Returns null when the message has no text.
 */
export function parseMessage(payload: unknown): Inbound | null {
  const m = parseFeishuMessage(payload);
  if (m === null || m.text === "") return null;
  return {
    kind: "message",
    text: m.text,
    from: m.from,
    ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
  };
}
