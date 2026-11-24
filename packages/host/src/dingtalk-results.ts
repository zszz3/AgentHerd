type Fields = Record<string, unknown>;
export const responseError = () =>
  new Error("无法验证钉钉返回的结果。若是写操作，请先在钉钉中确认结果再重试。");

export function object(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw responseError();
  return value as Fields;
}

function result(value: unknown): Fields {
  const data = object(value);
  if (
    data.ok === false ||
    data.success === false ||
    data.error !== undefined ||
    (data.status !== undefined && data.status !== "success" && data.status !== "partial_success")
  ) {
    throw responseError();
  }
  return data;
}

function unified(value: unknown) {
  const envelope = result(value);
  if (envelope.ok !== true || envelope.outcome !== "success") throw responseError();
  return { data: result(envelope.data), page: object(object(envelope.meta).pagination) };
}

export function pagination(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0")
    return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[!-~]{1,512}$/.test(value)) return value;
  throw responseError();
}

function page(data: Fields, key: string, nextCursor: string | undefined, partial: boolean) {
  const items = data[key];
  if (
    !Array.isArray(items) ||
    !items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    throw responseError();
  }
  return {
    items: items as Fields[],
    ...(nextCursor === undefined ? {} : { nextCursor }),
    partial: partial || nextCursor !== undefined,
  };
}

export function unifiedPage(value: unknown, key: string) {
  const { data, page: metadata } = unified(value);
  if (typeof metadata.endpoint_exhausted !== "boolean" || typeof data.complete !== "boolean")
    throw responseError();
  const cursor = pagination(metadata.next_token);
  if (!metadata.endpoint_exhausted && cursor === undefined) return page(data, key, undefined, true);
  return page(data, key, cursor, !metadata.endpoint_exhausted || !data.complete);
}

export function documentList(value: unknown) {
  const data = result(value);
  if (data.contractVersion !== "doc.list.v1" || typeof data.complete !== "boolean")
    throw responseError();
  return page(
    data,
    "documents",
    pagination(data.nextCursor),
    data.status !== "success" || !data.complete || data.hasMore === true || data.truncated === true,
  );
}

export function documentContent(value: unknown) {
  const data = result(value);
  if (
    data.contractVersion !== "doc.content.v1" ||
    data.status !== "success" ||
    data.complete !== true
  )
    throw responseError();
  const content = result(data.content);
  return { content };
}

export function chatPage(value: unknown, key: "groups" | "messages") {
  const data = result(value);
  return page(
    data,
    key,
    pagination(data.nextPageToken ?? data.nextCursor),
    data.complete !== true || data.hasMore === true || data.partial === true,
  );
}

export function groupName(value: unknown, groupId: string): string {
  const envelope = result(value);
  if (envelope.success !== true) throw responseError();
  const data = result(envelope.result);
  const groupTypes = ["group", "groupchat", "group_chat"];
  const type = data.conversationType ?? data.type;
  const knownGroup =
    (typeof type === "string" && groupTypes.includes(type.toLowerCase())) ||
    data.singleChat === false;
  const notGroup =
    data.singleChat === true ||
    (typeof type === "string" && !groupTypes.includes(type.toLowerCase()));
  const name = data.conversationName ?? data.name ?? data.title;
  if (
    !knownGroup ||
    notGroup ||
    data.openConversationId !== groupId ||
    typeof name !== "string" ||
    name.trim() === ""
  ) {
    throw new Error("无法验证钉钉群聊身份。请先查询可见群聊并使用准确的群 ID。");
  }
  return name;
}

export function minutesSummary(value: unknown, id: string) {
  const data = result(value);
  if (data.complete !== true || data.taskUuid !== id) throw responseError();
  const artifact = result(data.summary);
  const summary = result(artifact.result).fullSummary;
  if (typeof summary !== "string") throw responseError();
  return { summary };
}

export function calendarReceipt(value: unknown) {
  const outer = result(value);
  if (outer.ok !== true || outer.outcome !== "success") throw responseError();
  const data = result(outer.data);
  if (
    data.verified !== true ||
    data.success !== true ||
    typeof data.eventId !== "string" ||
    !data.eventId
  )
    throw responseError();
  return { eventId: data.eventId, verified: true };
}

export function documentReceipt(value: unknown) {
  const envelope = result(value);
  if (
    envelope.contractVersion !== "doc.operation.v1" ||
    envelope.status !== "success" ||
    envelope.complete !== true
  )
    throw responseError();
  const data = result(envelope.data);
  if (data.verified !== true || typeof data.nodeId !== "string" || !data.nodeId)
    throw responseError();
  return { nodeId: data.nodeId, verified: true };
}

export function messageReceipt(value: unknown) {
  const envelope = result(value);
  if (
    envelope.ok !== true ||
    envelope.identity !== "user" ||
    envelope.tool !== "send_personal_message"
  )
    throw responseError();
  const raw = result(envelope.result);
  const details = raw.result === undefined ? raw : result(raw.result);
  const receipt = result(envelope.sendReceipt);
  if (receipt.contractVersion !== "im.message-send-receipt.v1") throw responseError();
  const reference = receipt.messageRef === undefined ? undefined : object(receipt.messageRef);
  const hasId = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const status = details.sendStatus ?? raw.sendStatus;
  if (
    (status !== undefined && status !== "accepted") ||
    !(
      raw.success === true ||
      details.success === true ||
      hasId(receipt.openTaskId) ||
      hasId(reference?.openMessageId)
    )
  )
    throw responseError();
  // DWS acknowledges the send request, not delivery to members' devices.
  return { accepted: true };
}
