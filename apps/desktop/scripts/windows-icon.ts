// The Windows app icon: an ICO made from resources/icon.png, so the taskbar, the Start menu and the
// installer show the app's own icon instead of Electron's. Electron's image scaler makes the sizes
// (no image library), and the ICO stores each one as PNG, which Windows reads since Vista.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The sizes the shell asks for at 100–200 % scaling, up to the largest an ICO can hold. */
export const WINDOWS_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256] as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An ICO file holding the given square PNG images, in the order given. */
export function icoFromPngs(images: readonly { size: number; png: Buffer }[]): Buffer {
  if (images.length === 0) throw new Error("an icon needs at least one image");
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`an ICO image is 1 to 256 px, not ${size}`);
    }
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error(`the ${size} px image is not a PNG`);
    }
    const at = 6 + i * 16;
    header.writeUInt8(size === 256 ? 0 : size, at);
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

/**
 * Writes `out`, an ICO of `source` (a large square PNG) at every Windows size. `electron` is the
 * Electron binary that scales the image.
 */
export function writeWindowsIcon(electron: string, source: string, out: string): void {
  const dir = mkdtempSync(join(tmpdir(), "ah-icon-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(
      electron,
      [
        join(import.meta.dirname, "windows-icon-render.mjs"),
        source,
        dir,
        ...WINDOWS_ICON_SIZES.map(String),
      ],
      { env, stdio: "inherit", timeout: 60_000 },
    );
    const images = WINDOWS_ICON_SIZES.map((size) => ({
      size,
      png: readFileSync(join(dir, `${size}.png`)),
    }));
    writeFileSync(out, icoFromPngs(images));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
