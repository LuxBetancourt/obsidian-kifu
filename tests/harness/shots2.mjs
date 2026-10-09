// Close-ups of the editing tools, the lock and the panel, in both themes.
import { chromium, open, out, pointXY, clickPoint, sleep } from './lib.mjs';
const KILL = `(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.]
(;B[ra]C[The middle of three is the vital point.];W[qa];B[sa]C[White has no eyes.])
(;B[qa];W[ra]C[White captures and has two eyes.])
(;B[sa];W[ra]C[White captures and has two eyes.]))`;
const note = ['# Problems', '', 'Intro text.', '', '```kifu', KILL, '```', '', 'Text after the board.', ''].join('\n');
const browser = await chromium.launch();
for (const dark of [false, true]) {
	const { page, errors } = await open(browser, { scale: 2, dark, width: 1100, height: 760, files: { 'E.md': note }, panes: [{ path: 'E.md', mode: 'source' }], autosave: 100 });
	let p = await pointXY(page, 0, 'pc');
	await page.mouse.move(p.x, p.y);
	await sleep(300);
	await page.screenshot({ path: `${out}/hover-${dark ? 'dark' : 'light'}.png`, clip: { x: 150, y: 100, width: 520, height: 260 } });
	await page.locator('.kifu-ctl .kifu-btn[aria-label*="nlock"]').click();
	await page.locator('.kifu-tools .kifu-btn[aria-label^="Letter"]').click();
	await clickPoint(page, 0, 'dd');
	await page.locator('.kifu-tools .kifu-btn[aria-label^="Play"]').click();
	await clickPoint(page, 0, 'ra');
	await sleep(300);
	const bar = await page.locator('.kifu-tools').boundingBox();
	await page.screenshot({ path: `${out}/tools-${dark ? 'dark' : 'light'}.png`, clip: { x: bar.x - 20, y: bar.y - 60, width: bar.width + 40, height: bar.height + 80 } });
	await page.screenshot({ path: `${out}/edit-${dark ? 'dark' : 'light'}.png` });
	if (errors.length) console.log(errors);
	await page.context().close();
}
await browser.close();
