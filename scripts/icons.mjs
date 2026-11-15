// Render icons/icon.svg to the PNG sizes Chrome wants. Rerun after editing
// the SVG: node scripts/icons.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
const svg = (await readFile(`${dir}icon.svg`)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>
    <img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block">`);
  await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons/icon-{16,32,48,128}.png');
