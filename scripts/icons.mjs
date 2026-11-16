// Render the icon SVGs to the PNG sizes Chrome wants: node scripts/icons.mjs
//
// icon-16.svg is drawn on the 16 px grid and renders the toolbar sizes, 16
// and 32 (1x and 2x); the master scaled that far down goes soft. icon.svg
// renders 48, which fills its square, and 128, the install-dialog and Web
// Store icon, which Chrome's guidance wants as 96x96 art inside 16 px of
// transparent padding. The art's bounds are measured from a render, so
// nothing here changes when the art does.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
const uri = async name => `data:image/svg+xml;base64,${(await readFile(dir + name)).toString('base64')}`;
const master = await uri('icon.svg');
const small = await uri('icon-16.svg');
const PAD = 17; // 16, plus a pixel for antialiased edges

const browser = await chromium.launch();
const page = await browser.newPage();

// Bounds of everything icon.svg paints, in its 128-unit viewBox.
const art = await page.evaluate(async src => {
  const N = 1024;
  const img = new Image();
  img.src = src;
  await img.decode();
  const g = new OffscreenCanvas(N, N).getContext('2d');
  g.drawImage(img, 0, 0, N, N);
  const alpha = g.getImageData(0, 0, N, N).data;
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!alpha[(y * N + x) * 4 + 3]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const k = 128 / N;
  return { x: x0 * k, y: y0 * k, w: (x1 + 1 - x0) * k, h: (y1 + 1 - y0) * k };
}, master);

// Draw icon.svg so its art spans `box` px, centered in a `size` square.
function fit(size, box) {
  const scale = box / Math.max(art.w, art.h);
  return { px: 128 * scale, left: size / 2 - (art.x + art.w / 2) * scale, top: size / 2 - (art.y + art.h / 2) * scale };
}

const renders = [
  [16, small, { px: 16, left: 0, top: 0 }],
  [32, small, { px: 32, left: 0, top: 0 }],
  [48, master, fit(48, 48)],
  [128, master, fit(128, 128 - 2 * PAD)],
];
for (const [size, src, { px, left, top }] of renders) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style>
    <img src="${src}" width="${px}" height="${px}"
      style="display:block;position:absolute;left:${left}px;top:${top}px">`);
  await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons/icon-{16,32,48,128}.png');
