// The Windows app icon: an ICO built from the app's own icon.png, so the taskbar, the
// Start menu and the installer show the same icon as the app.

import { describe, expect, it } from "vitest";
import { icoFromPngs, WINDOWS_ICON_SIZES } from "../scripts/windows-icon.ts";

/** A PNG-looking buffer: the signature and some bytes; the ICO only stores it. */
function png(tag: number, length: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, Buffer.alloc(length - signature.length, tag)]);
}

describe("icoFromPngs", () => {
  it("writes an icon directory with one PNG entry per size, in order", () => {
    const small = png(1, 40);
    const large = png(2, 100);
    const ico = icoFromPngs([
      { size: 16, png: small },
      { size: 256, png: large },
    ]);
    // ICONDIR: reserved 0, type 1 (icon), 2 images.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    const entry = (i: number) => {
      const at = 6 + i * 16;
      return {
        width: ico.readUInt8(at),
        height: ico.readUInt8(at + 1),
        colors: ico.readUInt8(at + 2),
        planes: ico.readUInt16LE(at + 4),
        bits: ico.readUInt16LE(at + 6),
        bytes: ico.readUInt32LE(at + 8),
        offset: ico.readUInt32LE(at + 12),
      };
    };
    // 256 px is written as 0 in the one-byte width and height.
    expect(entry(0)).toEqual({
      width: 16,
      height: 16,
      colors: 0,
      planes: 1,
      bits: 32,
      bytes: 40,
      offset: 38,
    });
    expect(entry(1)).toEqual({
      width: 0,
      height: 0,
      colors: 0,
      planes: 1,
      bits: 32,
      bytes: 100,
      offset: 78,
    });
    expect(ico.subarray(38, 78).equals(small)).toBe(true);
    expect(ico.subarray(78, 178).equals(large)).toBe(true);
    expect(ico.length).toBe(178);
  });

  it("refuses a size the format cannot hold or data that is not PNG", () => {
    expect(() => icoFromPngs([{ size: 512, png: png(1, 20) }])).toThrow(/512/);
    expect(() => icoFromPngs([{ size: 16, png: Buffer.from("not a png") }])).toThrow(/PNG/);
    expect(() => icoFromPngs([])).toThrow();
  });

  it("covers the sizes Windows asks for, up to 256", () => {
    expect(WINDOWS_ICON_SIZES).toContain(16);
    expect(WINDOWS_ICON_SIZES).toContain(32);
    expect(WINDOWS_ICON_SIZES).toContain(48);
    expect(WINDOWS_ICON_SIZES.at(-1)).toBe(256);
  });
});
