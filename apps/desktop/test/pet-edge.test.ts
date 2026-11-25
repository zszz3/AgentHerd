import { describe, expect, it } from "vitest";
import {
  EDGE_GAP,
  edgeOf,
  fitCorner,
  fitDrag,
  peekRight,
  pushedEdge,
  TUCK_SHOW,
  tuckedX,
} from "../src/shared/pet-edge.ts";

const area = { x: 0, y: 25, width: 1512, height: 920 };
// The figure inside a 150-wide window, at its right.
const stage = { x: 40, y: 30, width: 110, height: 120 };

describe("tucking the pet at a screen edge (ADR 0080)", () => {
  it("tucks only when more than a third of the figure is past the left or right edge", () => {
    expect(edgeOf({ x: 1450, y: 600, width: 110, height: 120 }, area)).toBe("right");
    expect(edgeOf({ x: 1420, y: 600, width: 110, height: 120 }, area)).toBeUndefined();
    expect(edgeOf({ x: -40, y: 600, width: 110, height: 120 }, area)).toBe("left");
    expect(edgeOf({ x: -20, y: 600, width: 110, height: 120 }, area)).toBeUndefined();
    expect(edgeOf({ x: 600, y: 600, width: 110, height: 120 }, area)).toBeUndefined();
  });

  it("shows a strip while tucked and the whole figure inside the edge when it peeks", () => {
    // Right edge: the figure's left TUCK_SHOW pixels show.
    const xr = tuckedX("right", stage, area);
    expect(area.x + area.width - (xr + stage.x)).toBe(TUCK_SHOW);
    const rr = peekRight("right", stage, 150, area);
    expect(rr - 150 + stage.x + stage.width).toBe(area.x + area.width - EDGE_GAP);
    // Left edge: the figure's right TUCK_SHOW pixels show.
    const xl = tuckedX("left", stage, area);
    expect(xl + stage.x + stage.width - area.x).toBe(TUCK_SHOW);
    const rl = peekRight("left", stage, 150, area);
    expect(rl - 150 + stage.x).toBe(area.x + EDGE_GAP);
  });
});

it("keeps a drag inside each corner, on every system", () => {
  for (const width of [72, 150]) {
    const pet = { width, height: width };
    for (const x of [-2000, 3000]) {
      for (const y of [-2000, 3000]) {
        const placed = fitDrag({ x, y, ...pet }, area);
        expect(placed).toEqual({ x: x < 0 ? 0 : area.width - width, y: y < 0 ? 25 : 945 - width });
      }
    }
    const leftDisplay = { ...area, x: -area.width };
    expect(fitDrag({ ...pet, x: -1, y: 100 }, leftDisplay)).toEqual({ x: -width, y: 100 });
  }
});

it("tucks a drop at the edge the pointer kept pushing past by a third of the figure", () => {
  expect(pushedEdge(40, 111)).toBe("right");
  expect(pushedEdge(-40, 111)).toBe("left");
  expect(pushedEdge(30, 111)).toBeUndefined();
  expect(pushedEdge(0, 111)).toBeUndefined();
});

describe("the pet after a screen change (ADR 0070)", () => {
  // Seen live: a second screen became the main one (0–1920 wide) and the corner stayed at
  // right 2352, so the conversation opened 432 px past the screen's right edge.
  const main = { x: 0, y: 25, width: 1920, height: 1025 };

  it("pulls a corner past the right or bottom edge back onto the screen", () => {
    expect(fitCorner({ right: 2352, bottom: 833 }, main, 40)).toEqual({ right: 1920, bottom: 833 });
    expect(fitCorner({ right: 900, bottom: 1300 }, main, 40)).toEqual({ right: 900, bottom: 1050 });
    expect(fitCorner({ right: -300, bottom: 0 }, main, 40)).toEqual({ right: 40, bottom: 65 });
  });

  it("leaves a corner on the screen as it is, tuck and all", () => {
    const corner = { right: 1228, bottom: 850, edge: "right" as const };
    expect(fitCorner(corner, main, 40)).toBe(corner);
    expect(fitCorner({ right: 2352, bottom: 833, edge: "right" as const }, main, 40)).toEqual({
      right: 1920,
      bottom: 833,
      edge: "right",
    });
  });
});
