import { describe, expect, it } from "vitest";
import {
  dropSide,
  EDGE_GAP,
  edgeOf,
  fitDrag,
  peekRight,
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

it("keeps a Windows drag inside each corner and tucks only at exposed sides", () => {
  for (const width of [72, 150]) {
    const pet = { width, height: width };
    for (const x of [-2000, 3000]) {
      for (const y of [-2000, 3000]) {
        const placed = fitDrag({ x, y, ...pet }, area);
        expect(placed).toEqual({ x: x < 0 ? 0 : area.width - width, y: y < 0 ? 25 : 945 - width });
        expect(dropSide({ ...placed, ...pet }, area, [])).toBe(x < 0 ? "left" : "right");
      }
    }
    const leftDisplay = { ...area, x: -area.width };
    expect(dropSide({ ...pet, x: 0, y: 100 }, area, [leftDisplay])).toBeUndefined();
    expect(fitDrag({ ...pet, x: -1, y: 100 }, leftDisplay)).toEqual({ x: -width, y: 100 });
    expect(dropSide({ ...pet, x: 1, y: 25 }, area, [])).toBeUndefined();
  }
});
