// A small, conservative shell splitter. It understands quotes, escapes and the control
// operators that join commands. Anything it cannot read with confidence (command or process
// substitution, unbalanced quotes) throws `UnparsedCommandError`, so callers fail toward the
// human.

export class UnparsedCommandError extends Error {
  constructor(reason: string) {
    super(`unparsed: ${reason}`);
    this.name = "UnparsedCommandError";
  }
}

export type JoinOperator = "&&" | "||" | ";" | "|" | "&" | "\n";

export interface Token {
  /** Unquoted text of the word. */
  value: string;
  /** Character offsets of unquoted `,` separators inside `value`. */
  unquotedCommas: readonly number[];
  /** Character offsets of unquoted `(` or `)` inside `value`. */
  unquotedParens: readonly number[];
  /** Inclusive start offset in the input string. */
  start: number;
  /** Exclusive end offset in the input string. */
  end: number;
}

export interface RichSegment {
  /** Operator that joins this segment to the previous one; `null` for the first. */
  joinedBy: JoinOperator | null;
  /** Tokens with unquoted comma positions and source offsets preserved. */
  tokens: Token[];
}

export interface Segment {
  /** Operator that joins this segment to the previous one; `null` for the first. */
  joinedBy: JoinOperator | null;
  /** Words with quotes removed. Redirection operators are separate words (`>`, `>>`, `<`). */
  words: string[];
}

const OPERATORS: readonly JoinOperator[] = ["&&", "||", ";", "|", "&", "\n"];
const POSIX_ESCAPE_CHARS = new Set([
  " ",
  "\t",
  '"',
  "'",
  "$",
  "`",
  "&",
  "|",
  ";",
  "<",
  ">",
  "(",
  ")",
  "#",
]);
const CMD_BOUNDARY_CHARS = new Set([" ", "\t", "&", "|", ";", "<", ">"]);

function isWindowsPathWord(word: string): boolean {
  return (
    word.includes("\\") ||
    /^[A-Za-z]:$/.test(word) ||
    word === "." ||
    word === ".." ||
    /^(?:cd|chdir)$/i.test(word)
  );
}

/** Split a command line into segments while preserving unquoted comma positions and token offsets. */
export function splitCommandRich(input: string): RichSegment[] {
  const segments: RichSegment[] = [];
  let tokens: Token[] = [];
  let unquotedCommas: number[] = [];
  let unquotedParens: number[] = [];
  let word = "";
  let inWord = false;
  let wordStart = 0;
  let wordEnd = 0;
  let joinedBy: JoinOperator | null = null;
  let i = 0;

  const appendText = (text: string, quoted: boolean, at: number, endAt: number): void => {
    if (!inWord) {
      wordStart = at;
      inWord = true;
    }
    wordEnd = endAt;
    if (!quoted && text === ",") unquotedCommas.push(word.length);
    if (!quoted && (text === "(" || text === ")")) unquotedParens.push(word.length);
    word += text;
  };

  const endWord = (): void => {
    if (inWord) {
      tokens.push({ value: word, unquotedCommas, unquotedParens, start: wordStart, end: wordEnd });
    }
    unquotedCommas = [];
    unquotedParens = [];
    word = "";
    inWord = false;
  };
  const endSegment = (op: JoinOperator): void => {
    endWord();
    if (tokens.length === 0) {
      if (op === "\n" || op === ";") return; // blank line or trailing `;`
      throw new UnparsedCommandError(`empty command before ${JSON.stringify(op)}`);
    }
    segments.push({ joinedBy, tokens });
    tokens = [];
    joinedBy = op;
  };

  while (i < input.length) {
    const c = input[i] as string;
    const next = input[i + 1];

    if (c === "\\") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r" && input[i + 2] === "\n") {
        i += 3;
        continue;
      }
      // Start of a UNC path (`\\server\share`) rather than a POSIX escape.
      if (!inWord && next === "\\") {
        appendText("\\\\", false, i, i + 2);
        i += 2;
        continue;
      }
      if (next === undefined) {
        if (inWord && isWindowsPathWord(word)) {
          appendText("\\", false, i, i + 1);
          i += 1;
          continue;
        }
        throw new UnparsedCommandError("trailing backslash");
      }
      // Trailing backslash on a Windows path before a space or command operator (`rd C:\foo\ /s`).
      if (inWord && isWindowsPathWord(word) && CMD_BOUNDARY_CHARS.has(next)) {
        appendText("\\", false, i, i + 1);
        i += 1;
        continue;
      }
      if (next === "\\") {
        appendText("\\", false, i, i + 2);
        i += 2;
        continue;
      }
      if (POSIX_ESCAPE_CHARS.has(next) && !(inWord && isWindowsPathWord(word))) {
        appendText(next, false, i, i + 2);
        i += 2;
        continue;
      }
      // Preserve backslashes inside Windows paths (`C:\Users\me\.ssh`, `\\server\share\file`).
      appendText(`\\${next}`, false, i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new UnparsedCommandError("unbalanced single quote");
      appendText(input.slice(i + 1, end), true, i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const quoteStart = i;
      i += 1;
      let closed = false;
      let quotedText = "";
      while (i < input.length) {
        const d = input[i] as string;
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === "`" || (d === "$" && input[i + 1] === "(")) {
          throw new UnparsedCommandError("command substitution");
        }
        if (d === "\\" && i + 1 < input.length) {
          const escNext = input[i + 1] as string;
          if (escNext === "\n") {
            i += 2;
            continue;
          }
          if (escNext === "\r" && input[i + 2] === "\n") {
            i += 3;
            continue;
          }
          // Only unescape POSIX metacharacters or `\\` before closing `"`; keep Windows `\`.
          if (
            escNext === '"' ||
            escNext === "$" ||
            escNext === "`" ||
            (escNext === "\\" && input[i + 2] === '"')
          ) {
            quotedText += escNext;
            i += 2;
            continue;
          }
          quotedText += d;
          i += 1;
          continue;
        }
        quotedText += d;
        i += 1;
      }
      if (!closed) throw new UnparsedCommandError("unbalanced double quote");
      appendText(quotedText, true, quoteStart, i);
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) {
      throw new UnparsedCommandError("command substitution");
    }
    if ((c === "<" || c === ">") && next === "(") {
      throw new UnparsedCommandError("process substitution");
    }
    if (c === " " || c === "\t" || (c === "\r" && next === "\n")) {
      if (c !== "\r") endWord();
      i += 1;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      endSegment(two);
      i += 2;
      continue;
    }
    if (two === "|&") {
      endSegment("|");
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      // Redirections become their own words: `2>` `>>` `>` `<` `&>`.
      const opStart = inWord && /^\d+$/.test(word) ? wordStart : i;
      const fd = inWord && /^\d+$/.test(word) ? word : "";
      if (fd !== "") {
        unquotedCommas = [];
        unquotedParens = [];
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      let op = fd + c;
      i += 1;
      if (input[i] === c) {
        op += c;
        i += 1;
      }
      if (input[i] === "&") {
        op += "&";
        i += 1;
      }
      tokens.push({ value: op, unquotedCommas: [], unquotedParens: [], start: opStart, end: i });
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      const opStart = i;
      const append = input[i + 2] === ">";
      const op = append ? "&>>" : "&>";
      i += append ? 3 : 2;
      tokens.push({ value: op, unquotedCommas: [], unquotedParens: [], start: opStart, end: i });
      continue;
    }
    if ((OPERATORS as readonly string[]).includes(c)) {
      endSegment(c as JoinOperator);
      i += 1;
      continue;
    }
    appendText(c, false, i, i + 1);
    i += 1;
  }

  endWord();
  if (tokens.length > 0) segments.push({ joinedBy, tokens });
  else if (joinedBy !== null && joinedBy !== ";" && joinedBy !== "&" && joinedBy !== "\n") {
    throw new UnparsedCommandError(`missing command after ${JSON.stringify(joinedBy)}`);
  }
  return segments;
}

/** Split a command line into segments joined by control operators. */
export function splitCommand(input: string): Segment[] {
  return splitCommandRich(input).map((s) => ({
    joinedBy: s.joinedBy,
    words: s.tokens.map((t) => t.value),
  }));
}

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "runas",
  "gsudo",
  "command",
  "builtin",
  "exec",
  "nice",
  "nohup",
  "time",
  "env",
]);

const RUNAS_SWITCH =
  /^\/(?:noprofile|profile|env|netonly|savecred|smartcard|showtrustlevels|(?:user|trustlevel):.+)$/i;

/**
 * The words of a segment starting at the real program: leading `NAME=value` assignments and
 * wrappers such as `sudo`, `env`, `nohup`, `runas`, `gsudo` are skipped. Options of the wrappers
 * are skipped too (coarse: every word starting with `-` right after a wrapper, plus `runas` `/...`
 * switches).
 */
export function programWords(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    const base = basename(w);
    if (WRAPPERS.has(base)) {
      i += 1;
      while (i < words.length) {
        const opt = words[i] as string;
        if (opt.startsWith("-") || (base === "runas" && RUNAS_SWITCH.test(opt))) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return words.slice(i);
}

/** Normalized executable name: strips directory prefix (`/` or `\`), lowercases, drops Windows extensions. */
export function basename(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  const base = slash === -1 ? word : word.slice(slash + 1);
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
}
