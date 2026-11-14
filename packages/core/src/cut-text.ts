/** Room kept for the note that says what was left out. */
const NOTE_ROOM = 100;
/** Share of the kept characters that come from the start; the rest come from the end. */
const HEAD_SHARE = 0.6;

/**
 * A long text cut to about `max` characters, keeping its start and its end (ADR 0062): a model
 * that reads only the start takes it for the whole, and a reply's conclusion is usually at the end.
 * A note between the two says how many characters are left out and, when `whole` is given, where
 * the whole text is.
 */
export function headTail(text: string, max: number, whole?: string): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - NOTE_ROOM);
  const head = Math.ceil(room * HEAD_SHARE);
  const tail = room - head;
  const left = text.length - head - tail;
  const note = `[… ${left} characters left out${whole === undefined ? "" : `; ${whole}`} …]`;
  const end = tail === 0 ? "" : text.slice(text.length - tail).trimStart();
  return [text.slice(0, head).trimEnd(), note, end].filter((part) => part !== "").join("\n");
}
