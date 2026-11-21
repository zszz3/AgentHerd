// The desktop pet (ADR 0070): a small figure floating over other windows. It moves with what
// AgentHerd is doing. A click opens the conversation with the Herder, both ways and in full; it
// also opens by itself when AgentHerd tells the owner something (the same as Feishu), without
// taking the keyboard. It shows the buttons of whatever waits for the owner and passes what the
// owner types to the Herder. Cards come in it as in Feishu, with a card for each task (ADR 0072).
// Its top-left corner and edges resize it. Drag the figure anywhere; the small button folds it
// into a dot, which counts what came meanwhile.

import {
  PET_DROP_MAX,
  type PetCard,
  type PetFigure,
  type PetSettings,
  type PetView,
  type TasksView,
} from "@agentherd/host/api";
import {
  type DragEvent,
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PetPose, PetRegion, PetRoom } from "../../../shared/bridge";
import { isQuiet, quietLine } from "../../../shared/pet-notify";
import type { PetArm } from "../../../shared/pet-shortcuts";
import { devOpen } from "../dev-bridge";
import { FIGURES } from "./figures";
import gripArt from "./figures/poses/claude-edge.webp";
import { gripHits } from "./grip-hits";
import { CardView, TaskCard } from "./PetCards";
import { LineView, Separator } from "./PetConversation";
import {
  addDrops,
  badgeOf,
  CHAT_DEFAULT,
  type ChatSize,
  cardGroups,
  conversationOf,
  type Drop,
  dragChat,
  type Entry,
  FLASH_MS,
  fitChat,
  flashOf,
  type Grip,
  type Mood,
  moodOf,
  newestScroll,
  newLine,
  type PendingSay,
  type PetTab,
  readChatSize,
  readTab,
  remainingSays,
  separatorOf,
  statusOf,
  suggestionFor,
  taskDots,
  taskGroups,
} from "./pet-state";
import {
  ANIMATIONS,
  ATLAS,
  CELL,
  type Clip,
  clipOf,
  FIDGET_MS,
  type Fidget,
  fidgetDelay,
  frameAt,
  HELLO_MS,
  JUMP_MS,
  nextFidget,
  thinkingOf,
  walkOf,
} from "./sprite";

const SCALE = 0.58;
const W = Math.round(CELL.width * SCALE);
const H = Math.round(CELL.height * SCALE);
/** The folded pet: the head of the current frame in a circle. */
const DOT = 46;
const DOT_SCALE = 0.5;
/** The Herder's face at the top of the conversation: the head of the resting frame. */
const AVATAR = 30;
const AVATAR_SCALE = 0.36;
const COLLAPSED_KEY = "agentherd.pet.collapsed";
/** The size the owner gave the conversation (ADR 0070). */
const CHAT_KEY = "agentherd.pet.chat";
/** The page the expanded pet shows (ADR 0078). */
const TAB_KEY = "agentherd.pet.tab";
/** Room on the screen before the pet has measured itself: the figure, input and margins. */
const CHAT_CHROME = { width: 60, height: 280 };

/** The whole screen: what the pet may use until main says how much room its corner leaves. */
function screenSpace(): PetRoom {
  return { width: window.screen.availWidth, height: window.screen.availHeight };
}

function screenRoom(): ChatSize {
  const space = screenSpace();
  return {
    width: space.width - CHAT_CHROME.width,
    list: space.height - CHAT_CHROME.height,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

type Task = TasksView["tasks"][number];

function countWorking(tasks: readonly Task[]): number {
  return tasks.filter((t) => t.stage === "working" || t.stage === "queued").length;
}

function regionsOf(root: HTMLElement): PetRegion[] {
  const base = root.getBoundingClientRect();
  const regions: PetRegion[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(".pet-stage, .pet-dot")) {
    const r = node.getBoundingClientRect();
    const padding = node.hasAttribute("data-docked") ? 0 : 4;
    regions.push({
      x: Math.max(0, Math.floor(r.left - base.left) - padding),
      y: Math.max(0, Math.floor(r.top - base.top) - padding),
      width: Math.ceil(r.width) + 2 * padding,
      height: Math.ceil(r.height) + 2 * padding,
    });
  }
  for (const node of root.querySelectorAll<HTMLElement>(".pet-bubble")) {
    const r = node.getBoundingClientRect();
    // Include the top/left resize grips and the bottom speech-bubble tail.
    regions.push({
      x: Math.max(0, Math.floor(r.left - base.left) - 6),
      y: Math.max(0, Math.floor(r.top - base.top) - 6),
      width: Math.ceil(r.width) + 6,
      height: Math.ceil(r.height) + 12,
    });
  }
  return regions;
}

export function Pet() {
  const bridge = window.agentherd;
  const [view, setView] = useState<PetView>({
    connected: false,
    pending: [],
    history: [],
    cards: [],
  });
  const [pose, setPose] = useState<PetPose>();
  useEffect(() => bridge.pet?.onPose?.(setPose), []);
  const [figure, setFigure] = useState<PetFigure>("deepseek");
  /** Quiet hours and snoozes (ADR 0079); undefined from an older host. */
  const [settings, setSettings] = useState<PetSettings>();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [tasks, setTasks] = useState<Task[]>([]);
  const working = countWorking(tasks);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<{ mood: "celebrate" | "error"; until: number }>();
  const [lastActive, setLastActive] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  /** The conversation is showing. */
  const [open, setOpen] = useState(() => devOpen() === "chat");
  const [hover, setHover] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  /** Lines that came while the pet was folded. */
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState("");
  // Files dropped on the pet, sent with the next message (ADR 0082).
  const [drops, setDrops] = useState<Drop[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingSays, setPendingSays] = useState<PendingSay[]>([]);
  const nextSayId = useRef(-1);
  const [note, setNote] = useState<string>();
  /** What the approve shortcut did, shown above the input (ADR 0080). */
  const [arm, setArm] = useState<PetArm>();
  const [hello, setHello] = useState(false);
  /** A reply just came: one jump (ADR 0087). */
  const [jump, setJump] = useState(false);
  /** Walking the way the owner drags it. */
  const [walk, setWalk] = useState<"walkRight" | "walkLeft">();
  /** A small idle move now and then. */
  const [fidget, setFidget] = useState<Fidget>();
  const lastFidget = useRef<Fidget | undefined>(undefined);
  const lastWave = useRef(0);
  const [chat, setChat] = useState<ChatSize>(() => readChatSize(localStorage.getItem(CHAT_KEY)));
  const [tab, setTabState] = useState<PetTab>(() => readTab(localStorage.getItem(TAB_KEY)));
  /** New lines that came while another page was shown. */
  const [chatUnread, setChatUnread] = useState(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const openRef = useRef(open);
  openRef.current = open;
  /** The largest conversation that fits on this screen next to the rest of the pet. */
  const [room, setRoom] = useState<ChatSize>(screenRoom);
  /** Room left of and above the figure's corner, from main; the pet never grows past it. */
  const [space, setSpace] = useState<PetRoom>(screenSpace);
  const lastId = useRef<number | undefined>(undefined);
  const lastTurn = useRef<number | undefined>(undefined);
  const edgeGrip =
    figure === "claude" && !collapsed && !open && pose?.pose === "grip" ? pose : undefined;
  const folded = useRef(collapsed);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; lastX: number; moved: boolean } | undefined>(
    undefined,
  );
  const figureEl = useRef<HTMLButtonElement>(null);
  const inputEl = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const panelEl = useRef<HTMLDivElement>(null);
  /** How far the conversation is scrolled up from its bottom, kept while it is resized. */
  const fromBottom = useRef(0);
  const resizing = useRef<{ grip: Grip; x: number; y: number; start: ChatSize } | undefined>(
    undefined,
  );

  const mood: Mood = moodOf({
    view,
    working,
    ...(flash === undefined ? {} : { flash }),
    lastActive,
    now,
    online,
  });

  useEffect(() => {
    const h = bridge.host;
    const apply = (next: PetView, first: boolean) => {
      setView(next);
      setPendingSays((prev) => (prev.length === 0 ? prev : remainingSays(prev, next.history)));
      // A new line in the conversation (the owner's too, from Feishu) wakes the pet up.
      const newest = next.history[next.history.length - 1];
      if (!first && newest !== undefined && newest.id !== lastTurn.current) {
        setLastActive(Date.now());
        // The Herder answered: a little jump as the reply comes (ADR 0087).
        if (newest.kind === "say") {
          setJump(true);
          setTimeout(() => setJump(false), JUMP_MS);
        }
      }
      lastTurn.current = newest?.id;
      const line = next.last;
      // Nothing said since the host started: the first line that comes is news.
      if (first && line === undefined) lastId.current = 0;
      if (line === undefined) return;
      const fresh = !first && newLine(lastId.current, line);
      if (first || fresh || lastId.current === undefined) lastId.current = line.id;
      if (!fresh) return;
      const t = Date.now();
      const f = flashOf(line);
      if (f !== undefined) setFlash({ mood: f, until: t + FLASH_MS });

      setLastActive(t);
      setNote(undefined);
      // Shown in full at once; a folded pet only counts it. A closed panel opens on the
      // conversation; an open one on another page counts it on the 对话 tab (ADR 0078). While
      // the owner wants quiet, a closed panel stays closed and only counts it (ADR 0079).
      if (folded.current || (!openRef.current && isQuiet(settingsRef.current, new Date()))) {
        setUnread((n) => n + 1);
      } else {
        if (!openRef.current) {
          setTabState("chat");
          localStorage.setItem(TAB_KEY, "chat");
        } else if (tabRef.current !== "chat") setChatUnread((n) => n + 1);
        setOpen(true);
      }
    };
    h.pet()
      .then((v) => apply(v, true))
      .catch(() => undefined);
    const onStatus = (s: { pet?: PetSettings }) => {
      setFigure(s.pet?.figure ?? "deepseek");
      setSettings(s.pet);
    };
    h.status()
      .then(onStatus)
      .catch(() => undefined);
    h.tasks()
      .then((t) => setTasks(t.tasks))
      .catch(() => undefined);
    const offEvent = bridge.onEvent((e) => {
      if (e.topic === "pet") apply(e.data, false);
      else if (e.topic === "status") onStatus(e.data);
      else if (e.topic === "tasks") {
        setTasks(e.data.tasks);
        setLastActive(Date.now());
      }
    });
    const offConnection = bridge.onConnection(setOnline);
    const offRoom = bridge.pet?.onRoom?.(setSpace);
    // A notification or the menu bar was clicked: the panel opens on that page (ADR 0079).
    const offShow = bridge.pet?.onShow?.((next) => {
      setCollapsed(false);
      folded.current = false;
      localStorage.setItem(COLLAPSED_KEY, "0");
      setTabState(next);
      localStorage.setItem(TAB_KEY, next);
      if (next === "chat") setChatUnread(0);
      setOpen(true);
      if (next === "chat") setTimeout(() => inputEl.current?.focus(), 60);
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offEvent();
      offConnection();
      offShow?.();
      offRoom?.();
      clearInterval(tick);
    };
  }, []);

  // The approve shortcut (ADR 0080): main tells what it armed or did; the line goes away when
  // the second press can no longer allow, or after a moment for the rest.
  useEffect(() => bridge.pet?.onArm?.(setArm), []);
  useEffect(() => {
    if (arm === undefined) return;
    const ms = arm.kind === "arm" ? Math.max(0, arm.until - Date.now()) : 3500;
    const timer = setTimeout(() => setArm(undefined), ms);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || arm.kind !== "arm") return;
      e.stopPropagation();
      bridge.pet?.disarm?.();
      setArm(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    if (arm.kind === "arm") {
      requestAnimationFrame(() =>
        document.querySelector(".pet-cardwrap.armed")?.scrollIntoView({ block: "nearest" }),
      );
    }
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [arm]);

  // Whatever came while the panel was closed is seen once it opens.
  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  // The Herder is working on a reply: the pet reads, with a "…" bubble (ADR 0087).
  const thinking = thinkingOf(view.history, remainingSays(pendingSays, view.history).length, now);

  // Now and then a calm pet waves, jumps or reads a little; never the same move twice running.
  const calm = mood === "resting" && !thinking && !collapsed;
  useEffect(() => {
    if (!calm) {
      setFidget(undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      timer = setTimeout(play, fidgetDelay(Math.random()));
    };
    const play = () => {
      const f = nextFidget(lastFidget.current, Math.random());
      lastFidget.current = f;
      setFidget(f);
      timer = setTimeout(() => {
        setFidget(undefined);
        wait();
      }, FIDGET_MS[f]);
    };
    wait();
    return () => clearTimeout(timer);
  }, [calm]);

  // Plays the clip's frames on the figure. Writes the style directly: no React render per frame.
  const clip: Clip = clipOf({ mood, walk, hello, jump, thinking, fidget });
  useEffect(() => {
    if (collapsed) return;
    const animation = ANIMATIONS[clip];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      const { column, next } = frameAt(animation, still ? 0 : performance.now() - start);
      const el = figureEl.current;
      if (el !== null) el.style.backgroundPosition = `${-column * W}px ${-animation.row * H}px`;
      if (!still && Number.isFinite(next)) timer = setTimeout(show, Math.max(16, next));
    };
    show();
    return () => clearTimeout(timer);
  }, [clip, collapsed]);

  // Back to the pet with the conversation open: the cursor goes straight into the input.
  useEffect(() => {
    if (!open) return;
    const toInput = () => inputEl.current?.focus();
    window.addEventListener("focus", toInput);
    return () => window.removeEventListener("focus", toInput);
  }, [open]);

  // The conversation opens at its newest message, from its first line, and follows new ones.
  const shown = open && !collapsed;
  const shownSays = remainingSays(pendingSays, view.history);
  const entries: Entry[] = [
    ...conversationOf(view, tasks, now),
    ...shownSays.map(
      (s): Entry => ({
        kind: "line",
        key: `s${s.id}`,
        at: s.at,
        line: { id: s.id, at: s.at, kind: "owner", text: s.text },
      }),
    ),
  ];
  const newestKey = entries.at(-1)?.key;
  useLayoutEffect(() => {
    const el = listEl.current;
    if (!shown || el === null || newestKey === "") return;
    // The other pages start at their top.
    if (tab !== "chat") {
      el.scrollTop = 0;
      return;
    }
    const newest = el.lastElementChild;
    const top = newest instanceof HTMLElement ? newest.offsetTop - 4 : el.scrollHeight;
    el.scrollTop = newestScroll(top, el.scrollHeight - el.clientHeight);
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [shown, newestKey, tab]);

  // Measures how big the conversation may get: the screen less the rest of the pet.
  const size = fitChat(chat, room);
  // A new size keeps what was at the bottom in place; growing shows more of what came before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the size changes
  useLayoutEffect(() => {
    const el = listEl.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom.current;
  }, [size.width, size.list]);
  useLayoutEffect(() => {
    const r = root.current;
    const p = panelEl.current;
    const l = listEl.current;
    if (!shown || r === null || p === null || l === null) return;
    const next = {
      width: space.width - (r.offsetWidth - p.offsetWidth),
      list: space.height - (r.offsetHeight - l.offsetHeight),
    };
    setRoom((current) =>
      current.width === next.width && current.list === next.list ? current : next,
    );
  });

  const reportSize = useCallback(() => {
    const el = root.current;
    if (el) bridge.pet?.resize(el.offsetWidth, el.offsetHeight, regionsOf(el), gripHits(el));
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(reportSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reportSize]);

  // During entry the clickable silhouette moves with the image.
  useLayoutEffect(() => {
    if (!edgeGrip?.animate) return;
    let frame: number;
    const until = performance.now() + 320;
    const follow = () => {
      reportSize();
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [edgeGrip, reportSize]);

  useEffect(() => {
    const pet = bridge.pet;
    if (pet === undefined) return;
    const down = () => pet.interacting(true);
    const up = () => pet.interacting(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    const offLeave = pet.onMouseLeave(() => setHover(false));
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
      offLeave();
    };
  }, []);

  const touch = () => {
    setLastActive(Date.now());
    setHello(true);
    setTimeout(() => setHello(false), 2 * HELLO_MS);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic event without a live pointer: no capture needed
    }
    drag.current = { x: e.screenX, y: e.screenY, lastX: e.screenX, moved: false };
    bridge.pet?.dragStart();
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === undefined) return;
    const dx = e.screenX - d.x;
    const dy = e.screenY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) >= 4) d.moved = true;
    // Dragged sideways, it walks that way (ADR 0087).
    if (d.moved) {
      const step = e.screenX - d.lastX;
      d.lastX = e.screenX;
      setWalk((w) => walkOf(w, step));
    }
    bridge.pet?.dragMove(dx, dy);
  };
  const finishDrag = (click?: () => void) => {
    const d = drag.current;
    drag.current = undefined;
    setWalk(undefined);
    if (d === undefined) return;
    const localMoved = d.moved;
    void Promise.resolve(bridge.pet?.dragEnd()).then((hostMoved) => {
      if (!localMoved && hostMoved !== true) click?.();
    });
  };

  const close = () => setOpen(false);

  // Pointed at, it waves; not again within ten seconds.
  const onFigureEnter = () => {
    const t = Date.now();
    if (drag.current !== undefined || t - lastWave.current < 10_000) return;
    lastWave.current = t;
    setHello(true);
    setTimeout(() => setHello(false), HELLO_MS);
  };

  const onFigureClick = () => {
    touch();
    setOpen((x) => !x);
  };

  const onGripDown = (grip: Grip) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic event without a live pointer: no capture needed
    }
    resizing.current = { grip, x: e.screenX, y: e.screenY, start: size };
  };
  const draggedTo = (e: PointerEvent<HTMLElement>): ChatSize | undefined => {
    const r = resizing.current;
    return r === undefined
      ? undefined
      : dragChat(r.start, r.grip, e.screenX - r.x, e.screenY - r.y, room);
  };
  const onGripMove = (e: PointerEvent<HTMLElement>) => {
    const next = draggedTo(e);
    if (next !== undefined) setChat(next);
  };
  const onGripUp = (e: PointerEvent<HTMLElement>) => {
    const next = draggedTo(e);
    resizing.current = undefined;
    if (next === undefined) return;
    setChat(next);
    localStorage.setItem(CHAT_KEY, JSON.stringify(next));
  };
  const resetChat = () => {
    setChat(CHAT_DEFAULT);
    localStorage.removeItem(CHAT_KEY);
  };
  const grip = (where: Grip) => (
    <div
      className={`pet-grip ${where}`}
      title="拖动改大小，双击恢复默认"
      aria-hidden="true"
      onPointerDown={onGripDown(where)}
      onPointerMove={onGripMove}
      onPointerUp={onGripUp}
      onDoubleClick={resetChat}
    />
  );

  const fold = (value: boolean) => {
    setCollapsed(value);
    folded.current = value;
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    if (value) close();
    else {
      // Unfolding shows what came meanwhile.
      if (unread > 0) setOpen(true);
      setUnread(0);
    }
  };

  const send = async () => {
    const text = draft.trim();
    const sending = drops;
    if ((text === "" && sending.length === 0) || offline) return;
    // What the owner says shows in the conversation.
    setTab("chat");
    const id = nextSayId.current--;
    const afterId = view.history.at(-1)?.id ?? 0;
    const prevLastId = view.last?.id;
    const shown = [text, ...sending.map((d) => `${d.picture ? "🖼️" : "📎"} ${d.name}`)]
      .filter((x) => x !== "")
      .join("\n");
    const entry: PendingSay = { id, at: new Date().toISOString(), text: shown, afterId };
    setDraft("");
    setDrops([]);
    setPendingSays((prev) => [...prev, entry]);
    setNote("已发给主管，等它回复…");
    inputEl.current?.focus();
    try {
      const next = await bridge.host.petSay(
        text,
        sending.map((d) => d.path),
      );
      setView(next);
      setPendingSays((prev) => {
        // With files the stored line reads differently, so it is not waited for.
        const directReply =
          sending.length > 0 || text.startsWith("/") || next.last?.id !== prevLastId;
        const filtered = directReply ? prev.filter((p) => p.id !== id) : prev;
        return remainingSays(filtered, next.history);
      });
    } catch (error) {
      setPendingSays((prev) => prev.filter((p) => p.id !== id));
      setDraft((cur) => (cur === "" ? text : cur));
      setDrops((cur) => (cur.length === 0 ? sending : cur));
      setNote(errorText(error));
    }
  };

  const press = async (target: string, action: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.host.petPress(target, action);
      setNote(undefined);
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.host.stopTask(taskId);
      setNote("已停下这个任务");
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const openTask = (taskId: string) => bridge.pet?.openApp(taskId);

  // Pages of the expanded pet (ADR 0078); the choice is kept.
  const setTab = (next: PetTab) => {
    setTabState(next);
    localStorage.setItem(TAB_KEY, next);
    if (next === "chat") setChatUnread(0);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Tab takes the Herder's guess at what the owner says next; it is never sent by itself (ADR 0084).
    if (e.key === "Tab" && suggestion !== undefined && !e.shiftKey) {
      e.preventDefault();
      setDraft(suggestion);
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") close();
  };

  const atlas = FIGURES[figure].atlas;
  const offline = !online || !view.connected;
  const suggestion = suggestionFor(view, draft, drops.length, offline);
  const badge = badgeOf(view.pending.length, unread);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these changes can move hit regions without resizing the root
  useLayoutEffect(reportSize, [
    reportSize,
    open,
    collapsed,
    pose,
    size.width,
    size.list,
    tasks,
    badge,
  ]);
  const quiet = quietLine(settings, new Date(now));
  // A figure tucked at a screen edge comes out while the cursor is on it or its panel is open,
  // and the pet floats above other windows while it has something for the owner (ADR 0080).
  const canGrip = figure === "claude" && !collapsed;
  const busyForOwner = shown || badge > 0 || arm?.kind === "arm";
  useEffect(() => {
    bridge.pet?.peek?.({ hover, panel: shown, grip: canGrip });
  }, [hover, shown, canGrip]);
  useEffect(() => {
    bridge.pet?.float?.(busyForOwner);
  }, [busyForOwner]);
  const openFile = (path: string) => bridge.pet?.openFile(path);
  const actions = {
    busy,
    offline,
    press: (target: string, action: string) => void press(target, action),
    openTask,
    openFile,
  };

  // Files dragged onto the pet wait above the input until sent (ADR 0082).
  const hasFiles = (e: DragEvent<HTMLElement>) => [...e.dataTransfer.types].includes("Files");
  const dropZone = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const paths = [...e.dataTransfer.files].map((f) => bridge.pet?.pathOf?.(f) ?? "");
      const next = addDrops(drops, paths, PET_DROP_MAX);
      if (paths.some((p) => p === "")) setNote("有的东西没有文件路径，拖不进来");
      else if (next.length - drops.length < new Set(paths).size)
        setNote(`一次最多带 ${PET_DROP_MAX} 个文件`);
      else setNote(undefined);
      setDrops(next);
      if (folded.current) fold(false);
      setTab("chat");
      setOpen(true);
      inputEl.current?.focus();
    },
  };
  const rootClass = dragging ? "pet-root pet-dragging" : "pet-root";

  if (collapsed) {
    return (
      <div ref={root} className={rootClass} {...dropZone}>
        <button
          type="button"
          className="pet-dot"
          aria-label="展开桌宠"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title={quiet === undefined ? "展开" : `展开（${quiet}）`}
          onPointerDown={onPointerDown}
          onPointerEnter={onFigureEnter}
          onPointerMove={onPointerMove}
          onPointerUp={() => finishDrag(() => fold(false))}
          onPointerCancel={() => finishDrag()}
          onLostPointerCapture={() => finishDrag()}
          style={{
            width: DOT,
            height: DOT,
            backgroundImage: `url(${atlas})`,
            backgroundSize: `${CELL.width * DOT_SCALE * ATLAS.columns}px ${CELL.height * DOT_SCALE * ATLAS.rows}px`,
            backgroundPosition: `-25px ${-(ANIMATIONS[mood].row * CELL.height * DOT_SCALE) - 6}px`,
          }}
        >
          {badge > 0 && <span className="pet-badge">{badge}</span>}
        </button>
      </div>
    );
  }

  const entryView = (entry: Entry) => {
    if (entry.kind === "card") {
      return (
        <div className="pet-cardwrap" data-open={entry.card.open ? "1" : "0"}>
          <CardView card={entry.card} actions={actions} />
        </div>
      );
    }
    if (entry.kind === "task") {
      return (
        <TaskCard
          task={entry.task}
          now={now}
          busy={busy}
          stop={(id) => void stop(id)}
          open={openTask}
        />
      );
    }
    return <LineView line={entry.line} openFile={openFile} />;
  };

  const taskPage = taskGroups(tasks, now);
  const cardPage = cardGroups(view.cards ?? []);
  const tabButton = (id: PetTab, label: string, count: number, tone: "blue" | "amber") => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={tab === id ? "pet-tab on" : "pet-tab"}
      onClick={() => setTab(id)}
    >
      {label}
      {count > 0 && <span className={`pet-tab-count ${tone}`}>{count}</span>}
    </button>
  );
  const taskView = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      now={now}
      busy={busy}
      stop={(id) => void stop(id)}
      open={openTask}
    />
  );
  const tasksPage =
    taskPage.running.length === 0 && taskPage.ended.length === 0 ? (
      <div className="pet-empty">现在没有任务。跟主管说要做的事，它会开任务。</div>
    ) : (
      <>
        {taskPage.running.length > 0 && (
          <div className="pet-section">在跑 · {taskPage.running.length}</div>
        )}
        {taskPage.running.map(taskView)}
        {taskPage.ended.length > 0 && (
          <div className="pet-section">一天内结束的 · {taskPage.ended.length}</div>
        )}
        {taskPage.ended.map(taskView)}
      </>
    );
  const armedRef = arm?.kind === "arm" ? arm.approval.ref : undefined;
  const cardView = (card: PetCard) => (
    <div
      key={card.ref}
      className={card.ref === armedRef ? "pet-cardwrap armed" : "pet-cardwrap"}
      data-open={card.open ? "1" : "0"}
    >
      <CardView card={card} actions={actions} />
    </div>
  );
  const cardsPage =
    cardPage.waiting.length === 0 && cardPage.recent.length === 0 ? (
      <div className="pet-empty">还没有卡片。要你确认的事、任务的结果都会在这里。</div>
    ) : (
      <>
        {cardPage.waiting.length > 0 && (
          <div className="pet-section">等你处理 · {cardPage.waiting.length}</div>
        )}
        {cardPage.waiting.map(cardView)}
        {cardPage.recent.length > 0 && <div className="pet-section">最近的卡片</div>}
        {cardPage.recent.map(cardView)}
      </>
    );

  // On the 卡片 page the waiting cards are already in sight.
  const waiting =
    view.pending.length === 0 || tab === "cards" ? undefined : (
      <button type="button" className="pet-waiting" onClick={() => setTab("cards")}>
        <i aria-hidden="true" />
        {view.pending.length} 件等你确认 →
      </button>
    );

  const armLine =
    arm === undefined ? undefined : arm.kind === "arm" ? (
      <div className="pet-arm">
        再按一次 <kbd>{arm.key}</kbd> 同意：{arm.approval.title}
        <span className="pet-arm-hint">Esc 取消</span>
      </div>
    ) : arm.kind === "none" ? (
      <div className="pet-arm quiet">现在没有等你同意的事</div>
    ) : arm.kind === "done" ? (
      <div className="pet-arm done">已同意：{arm.approval.title}</div>
    ) : (
      <div className="pet-arm bad">没能同意：{arm.message}</div>
    );

  const talk = (
    <div className="pet-talk">
      {armLine}
      {arm?.kind !== "arm" && waiting}
      {offline && <div className="pet-note">AgentHerd 还没连上飞书，先在 App 里设置好。</div>}
      {note !== undefined && <div className="pet-note">{note}</div>}
      {drops.length > 0 && (
        <div className="pet-drops">
          {drops.map((d) => (
            <span key={d.path} className="pet-drop" title={d.path}>
              {d.picture ? "🖼️" : "📎"} {d.name}
              <button
                type="button"
                aria-label={`去掉 ${d.name}`}
                onClick={() => setDrops((cur) => cur.filter((x) => x.path !== d.path))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="pet-input-row">
        <input
          ref={inputEl}
          className="pet-input"
          autoFocus
          value={draft}
          disabled={offline}
          placeholder={
            offline
              ? "连上飞书后才能说话"
              : (suggestion ??
                (drops.length > 0 ? "说点什么，或直接发送" : "跟主管说…（可以把文件拖到我身上）"))
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        {suggestion !== undefined && (
          <button
            type="button"
            className="pet-suggest"
            title="主管猜你接下来想说这句：按 Tab 或点这里填进去，不会直接发送"
            onClick={() => {
              setDraft(suggestion);
              inputEl.current?.focus();
            }}
          >
            Tab
          </button>
        )}
        <button
          type="button"
          className="pet-send"
          aria-label="发送"
          title="发送（回车）"
          disabled={offline || (draft.trim() === "" && drops.length === 0)}
          onClick={() => void send()}
        >
          ↑
        </button>
      </div>
    </div>
  );

  const dotView = taskDots(tasks, now);
  const dots =
    dotView.dots.length === 0 ? undefined : (
      <div className="pet-dots">
        {dotView.dots.map((dot) => (
          <button
            key={dot.id}
            type="button"
            className={`pet-dot-task ${dot.tone}`}
            title={dot.label}
            aria-label={dot.label}
            onClick={() => {
              setTab("tasks");
              setOpen(true);
            }}
          />
        ))}
        {dotView.more > 0 && <span className="pet-dot-more">+{dotView.more}</span>}
      </div>
    );

  return (
    <div ref={root} className={rootClass} {...dropZone}>
      {open && (
        <div className="pet-bubble pet-chat" ref={panelEl} style={{ width: size.width }}>
          {grip("top")}
          {grip("left")}
          {grip("corner")}
          <div className="pet-chat-head">
            <span
              className="pet-avatar"
              aria-hidden="true"
              style={{
                width: AVATAR,
                height: AVATAR,
                backgroundImage: `url(${atlas})`,
                backgroundSize: `${CELL.width * AVATAR_SCALE * ATLAS.columns}px ${CELL.height * AVATAR_SCALE * ATLAS.rows}px`,
                backgroundPosition: `${-CELL.width * AVATAR_SCALE * 0.27}px ${-CELL.height * AVATAR_SCALE * 0.06}px`,
              }}
            />
            <span className="pet-who">
              <b>主管</b>
              <small>
                <i className={offline ? "pet-online off" : "pet-online"} />
                {statusOf(!offline, working)}
              </small>
            </span>
            <button
              type="button"
              className="pet-icon"
              aria-label="打开 App"
              title="打开 App"
              onClick={() => bridge.pet?.openApp()}
            >
              ↗
            </button>
            <button
              type="button"
              className="pet-icon"
              aria-label="收起对话"
              title="收起"
              onClick={close}
            >
              ✕
            </button>
          </div>
          <div className="pet-tabs" role="tablist" aria-label="桌宠的页面">
            {tabButton("chat", "对话", chatUnread, "blue")}
            {tabButton("tasks", "任务", taskPage.running.length, "blue")}
            {tabButton("cards", "卡片", cardPage.waiting.length, "amber")}
          </div>
          <div
            className="pet-chat-list"
            ref={listEl}
            role="tabpanel"
            style={{ height: size.list }}
            onScroll={(e) => {
              if (tab !== "chat") return;
              const el = e.currentTarget;
              fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
            }}
          >
            {tab === "tasks" ? (
              tasksPage
            ) : tab === "cards" ? (
              cardsPage
            ) : entries.length === 0 ? (
              <div className="pet-empty">
                还没有和主管的对话。在这里或飞书里说的话都会出现在这儿。
              </div>
            ) : (
              entries.map((entry, i) => {
                const day = separatorOf(entry.at, entries[i - 1]?.at, new Date(now));
                return (
                  <Fragment key={entry.key}>
                    {day !== undefined && <Separator text={day} />}
                    {entryView(entry)}
                  </Fragment>
                );
              })
            )}
          </div>
          {talk}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hovering only shows the fold button */}
      <div
        className="pet-stage"
        data-docked={figure === "claude" && !open ? pose?.side : undefined}
        data-grip={edgeGrip?.side ?? undefined}
        data-enter={edgeGrip?.animate || undefined}
        style={{ width: W, height: H }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {hover && !edgeGrip && (
          <button
            type="button"
            className="pet-fold"
            aria-label="收起成小圆点"
            title="收起"
            onClick={() => fold(true)}
          >
            –
          </button>
        )}
        <button
          type="button"
          aria-label="桌宠：点一下打开或关上和主管的对话"
          title="点一下打开或关上对话"
          ref={figureEl}
          className={`pet-figure mood-${mood}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => finishDrag(onFigureClick)}
          onPointerCancel={() => finishDrag()}
          onLostPointerCapture={() => finishDrag()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setOpen((x) => !x);
          }}
          style={
            edgeGrip
              ? undefined
              : {
                  width: W,
                  height: H,
                  backgroundImage: `url(${atlas})`,
                  backgroundSize: `${W * ATLAS.columns}px ${H * ATLAS.rows}px`,
                }
          }
        >
          {edgeGrip && <img src={gripArt} onLoad={reportSize} alt="" draggable={false} />}
        </button>
        {badge > 0 && (
          <button
            type="button"
            className="pet-badge"
            aria-label={view.pending.length ? "待处理卡片" : "未读消息"}
            onClick={() => {
              setTab(view.pending.length ? "cards" : "chat");
              setOpen(true);
            }}
          >
            {badge}
          </button>
        )}
        {dots}
        {quiet !== undefined && (
          <span className="pet-moon" title={quiet} role="img" aria-label={quiet}>
            🌙
          </span>
        )}
        {thinking && clip === "thinking" && (
          <span className="pet-think" title="主管在想…" role="img" aria-label="主管在想">
            <i />
            <i />
            <i />
          </span>
        )}
        {mood === "sleeping" && (
          <span className="pet-zz" aria-hidden="true">
            <i>z</i>
            <i>z</i>
            <i>Z</i>
          </span>
        )}
        {mood === "celebrate" && (
          <span className="pet-sparkles" aria-hidden="true">
            <i>✦</i>
            <i>✦</i>
            <i>✧</i>
          </span>
        )}
      </div>
    </div>
  );
}
