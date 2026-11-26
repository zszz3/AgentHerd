// Run by Electron from windows-icon.ts: scales <source> to each <size> and writes <dir>/<size>.png.
// Usage: electron windows-icon-render.mjs <source> <dir> <size>...

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, nativeImage } from "electron";

const [source, dir, ...sizes] = process.argv.slice(2);
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(() => {
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) throw new Error(`cannot read ${source}`);
    for (const size of sizes.map(Number)) {
      const scaled = image.resize({ width: size, height: size, quality: "best" });
      writeFileSync(join(dir, `${size}.png`), scaled.toPNG());
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
