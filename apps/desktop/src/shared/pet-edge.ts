// Tucking the pet at a screen edge (ADR 0080): dropped with a third of the figure past the left or
// right edge, it hides there with a strip showing, and peeks out while the cursor is on it. Pure,
// so main and tests share it.

export type Edge = "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A tucked figure shows this much of itself. */
export const TUCK_SHOW = 44;
/** Gap between a peeking figure and the screen edge. */
export const EDGE_GAP = 8;

/** The edge a figure dropped here tucks at: more than a third of it past that edge. */
export function edgeOf(figure: Rect, area: Rect): Edge | undefined {
  const past = figure.width / 3;
  if (figure.x + figure.width - (area.x + area.width) > past) return "right";
  if (area.x - figure.x > past) return "left";
  return undefined;
}

/**
 * The window's right side when the tucked figure peeks out: the figure stands EDGE_GAP inside
 * the edge. `stage` is the figure inside the window, `width` the window's.
 */
export function peekRight(edge: Edge, stage: Rect, width: number, area: Rect): number {
  if (edge === "right") return area.x + area.width - EDGE_GAP + (width - stage.x - stage.width);
  return area.x + EDGE_GAP - stage.x + width;
}

/** The window's left side while tucked: TUCK_SHOW of the figure shows at the edge. */
export function tuckedX(edge: Edge, stage: Rect, area: Rect): number {
  if (edge === "right") return area.x + area.width - TUCK_SHOW - stage.x;
  return area.x + TUCK_SHOW - stage.x - stage.width;
}

/** Keep a Windows drag inside the work area that contains the pointer. */
export function fitDrag(window: Rect, area: Rect) {
  return {
    x: Math.max(area.x, Math.min(window.x, area.x + area.width - window.width)),
    y: Math.max(area.y, Math.min(window.y, area.y + area.height - window.height)),
  };
}

/** A shared side leads to another display. Only exposed sides accept a tuck. */
export function dropSide(window: Rect, area: Rect, otherDisplays: Rect[]): Edge | undefined {
  const left = window.x === area.x;
  if (!left && window.x + window.width !== area.x + area.width) return undefined;
  const x = left ? area.x - 1 : area.x + area.width;
  const shared = otherDisplays.some(
    (r) =>
      x >= r.x && x < r.x + r.width && window.y < r.y + r.height && window.y + window.height > r.y,
  );
  return shared ? undefined : left ? "left" : "right";
}
