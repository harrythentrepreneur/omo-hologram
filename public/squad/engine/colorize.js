// public/squad/engine/colorize.js
//
// Recolor pipeline for the squad office. Two modes, both ported from
// pablodelucca/pixel-agents/webview-ui/src/office/colorize.ts (MIT):
//
//   • colorize(img, {h,s,b,c}) — Photoshop "Colorize"-style. Grayscales the
//     source's perceived luminance and re-paints into a fixed hue/saturation.
//     Use for floor tiles where the source is grey concrete and we want a
//     uniform warm cream/sand.
//
//   • adjust(img, {h,s,b,c}) — Hue/Sat/Brightness/Contrast shift of the
//     original colors. Use for walls and furniture where we want to keep
//     the highlights/shadows but nudge the palette warmer.
//
// Both return an HTMLCanvasElement sized to the source image — drawImage
// accepts it as a source so the rest of the renderer doesn't change.

function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return { canvas: c, ctx };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

function hslToRgb(h, s, l) {
  const C = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const X = C * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1)      { r1 = C; g1 = X; b1 = 0; }
  else if (hp < 2) { r1 = X; g1 = C; b1 = 0; }
  else if (hp < 3) { r1 = 0; g1 = C; b1 = X; }
  else if (hp < 4) { r1 = 0; g1 = X; b1 = C; }
  else if (hp < 5) { r1 = X; g1 = 0; b1 = C; }
  else             { r1 = C; g1 = 0; b1 = X; }
  const m = l - C / 2;
  return [clamp255((r1 + m) * 255), clamp255((g1 + m) * 255), clamp255((b1 + m) * 255)];
}

function rgbToHsl(r, g, b) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rf)      h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
  else if (max === gf) h = ((bf - rf) / d + 2) * 60;
  else                 h = ((rf - gf) / d + 4) * 60;
  return [h, s, l];
}

// Photoshop-style Colorize.
// color = { h: 0–360, s: 0–100, b: -100–100, c: -100–100 }
export function colorize(img, color) {
  const { canvas, ctx } = imageToCanvas(img);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const sat = color.s / 100;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    let lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    if (color.c) lum = 0.5 + (lum - 0.5) * ((100 + color.c) / 100);
    if (color.b) lum = lum + color.b / 200;
    lum = clamp01(lum);
    const [r, g, b] = hslToRgb(color.h, sat, lum);
    px[i]     = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// HSL-adjust. Keeps the source's hue distribution intact, shifts everything.
// color = { h: -180–180 (hue rotation), s: -100–100, b: -100–100, c: -100–100 }
export function adjust(img, color) {
  const { canvas, ctx } = imageToCanvas(img);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    let [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    h = (((h + color.h) % 360) + 360) % 360;
    s = clamp01(s + color.s / 100);
    if (color.c) l = 0.5 + (l - 0.5) * ((100 + color.c) / 100);
    if (color.b) l = l + color.b / 200;
    l = clamp01(l);
    const [r, g, b] = hslToRgb(h, s, l);
    px[i]     = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}
