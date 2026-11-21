import type { PetRegion } from "../../../shared/bridge";

let mask: PetRegion[] | undefined;

/** Read the approved pose at display size. Each opaque run accepts the mouse. */
export function gripHits(root: HTMLElement): PetRegion[] | undefined {
  const stage = root.querySelector<HTMLElement>("[data-grip]");
  const img = stage?.querySelector("img");
  if (!stage || !img) return undefined;
  const base = root.getBoundingClientRect();
  const controls = Array.from(stage.querySelectorAll(".pet-dot-task, .pet-badge"), (control) => {
    const r = control.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
  });
  if (!img.naturalWidth) return controls;
  if (!mask) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return controls;
    ctx.drawImage(img, 0, 0, img.width, img.height);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    mask = [];
    for (let y = 0; y < img.height; y++) {
      let start = 0;
      for (let x = 0; x <= img.width; x++) {
        if (x < img.width && pixels[(y * img.width + x) * 4 + 3] >= 24) continue;
        if (x > start) mask.push({ x: start, y, width: x - start, height: 1 });
        start = x + 1;
      }
    }
  }
  const left = stage.dataset.grip === "left";
  const bounds = img.getBoundingClientRect();
  const x = Math.round(bounds.left - base.left);
  const y = Math.round(bounds.top - base.top);
  return mask
    .map((r) => ({
      ...r,
      x: x + (left ? img.width - r.x - r.width : r.x),
      y: y + r.y,
    }))
    .concat(controls);
}
