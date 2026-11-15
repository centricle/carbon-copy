// Render icons/icon.svg to the PNG sizes Chrome wants. Rerun after editing
// the SVG: node scripts/icons.mjs
//
// 16, 32 and 48 fill their square. 128 is the install-dialog and Web Store
// icon, which Chrome's guidance wants as 96x96 art inside 16 px of
// transparent padding, so the art is fitted inside that margin and centered.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
const svg = (await readFile(`${dir}icon.svg`)).toString('base64');

// Where icon.svg actually draws, strokes included, in its 128-unit viewBox.
// Update it if the art changes.
const ART = { x: 10.5, y: 8, w: 103.5, h: 117.5 };
const PAD = 17; // 16, plus a pixel for antialiased edges

function placement(size) {
  if (size !== 128) return { px: size, left: 0, top: 0 };
  const scale = (size - 2 * PAD) / Math.max(ART.w, ART.h);
  const px = 128 * scale;
  return { px, left: size / 2 - (ART.x + ART.w / 2) * scale, top: size / 2 - (ART.y + ART.h / 2) * scale };
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  const { px, left, top } = placement(size);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style>
    <img src="data:image/svg+xml;base64,${svg}" width="${px}" height="${px}"
      style="display:block;position:absolute;left:${left}px;top:${top}px">`);
  await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons/icon-{16,32,48,128}.png');
