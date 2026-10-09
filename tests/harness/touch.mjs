// Touch screens: the built plugin in WebKit (the engine of Obsidian on iPad and iPhone)
// and in Chromium, with Playwright's tablet and phone profiles. Taps only, no mouse.
import assert from 'node:assert/strict';
import { chromium, webkit, devices, runner, pointXY, sleep, cap, stones, lockBtn, tool, isEditing, doc } from './lib.mjs';

const KILL = `(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.]
(;B[ra]C[The middle of three is the vital point.];W[qa];B[sa]C[White has no eyes.])
(;B[qa];W[ra]C[White captures and has two eyes.]))`;
const note = '# P\n\nIntro.\n\n```kifu\nview: top-right\n' + KILL + '\n```\n\nAfter.\n';

const tap = async (page, pt) => {
	const p = await pointXY(page, 0, pt);
	await page.touchscreen.tap(p.x, p.y);
};

let failed = 0;
for (const [engine, type] of [['webkit', webkit], ['chromium', chromium]]) {
	const browser = await type.launch();
	const { scenario, report } = runner(browser);
	for (const dev of ['iPad (gen 7)', 'iPad (gen 7) landscape', 'iPhone 15']) {
		for (const mode of ['preview', 'live']) {
			const panes = mode === 'live' ? { live: ['P.md'] } : { panes: [{ path: 'P.md', mode: 'preview' }] };
			await scenario(`${engine}, ${dev}, ${mode}: solve, unlock, edit and reset the crop by touch`, { device: devices[dev], files: { 'P.md': note }, autosave: 100, ...panes }, async (page) => {
				// as on a phone or tablet: no sidebar beside the note; and the button rules of
				// Obsidian's own stylesheet that bear on ours (on a tablet every button is padded
				// 20px a side, which once squeezed the icons to nothing)
				await page.addStyleTag({ content: `
					#right { display: none !important; }
					button { display: inline-flex; align-items: center; justify-content: center; padding: 4px 12px; }
					button:not(.clickable-icon) { background-color: #eee; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
					.is-tablet button:not(.clickable-icon) { padding: 4px 20px; }
				` });
				await page.evaluate((tablet) => document.body.classList.add('is-mobile', 'is-ios', tablet ? 'is-tablet' : 'is-phone'), dev.startsWith('iPad'));
				const iconsShown = () => page.evaluate(() => [...document.querySelectorAll('.kifu-btn')]
					.filter((b) => b.offsetParent !== null)
					.map((b) => { const r = b.querySelector('svg').getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }));
				const hiddenShown = () => page.evaluate(() => [...document.querySelectorAll('.kifu-btn[hidden]')].filter((b) => getComputedStyle(b).display !== 'none').length);
				await sleep(100);
				const cursor = () => page.evaluate(() => window.harness.views[0].cm?.state.selection.main.head ?? null);
				const before = await cursor();

				// with nothing to hover, the lock is always there, and on the screen
				assert.ok(Number(await page.evaluate(() => getComputedStyle(document.querySelector('.kifu-ctl')).opacity)) > 0);
				const lb = await lockBtn(page).boundingBox();
				assert.ok(lb.x >= 0 && lb.x + lb.width <= page.viewportSize().width, `lock at ${lb.x}..${lb.x + lb.width}`);

				// every icon is drawn at its size, and buttons that are hidden stay hidden
				assert.ok((await iconsShown()).every((w) => w >= 18), `icons: ${await iconsShown()}`);
				assert.equal(await hiddenShown(), 0);

				// solving: each tap plays, the saved reply follows
				await tap(page, 'ra');
				await sleep(700);
				await tap(page, 'sa');
				await sleep(200);
				assert.match(await cap(page), /^Correct/);
				// in Live Preview a tap on the board leaves the editor's cursor alone (or the block would open as text)
				assert.equal(await cursor(), before);
				assert.equal(await page.locator('.kifu-svg').count(), 1);

				// unlock, and edit with the tools
				await lockBtn(page).tap();
				assert.deepEqual(await isEditing(page), [true]);
				assert.ok((await iconsShown()).every((w) => w >= 18), `icons while editing: ${await iconsShown()}`);
				assert.equal(await hiddenShown(), 0);
				await tool(page, 'Black stone').tap();
				await tap(page, 'ss');
				assert.equal((await stones(page)).black, 10);
				await tool(page, 'Letter or number').tap();
				await page.locator('.kifu-label').tap();
				assert.equal(await page.evaluate(() => document.activeElement?.className), 'kifu-label');

				// a double tap with the crop tool goes back to the automatic crop, once (one undo brings it back)
				await tool(page, 'Choose the part').tap();
				await tap(page, 'pp');
				await sleep(60);
				await tap(page, 'pp');
				await sleep(800); // (edits are written 400 ms after the last one)
				assert.doesNotMatch(await doc(page), /view:/);
				await tool(page, 'Undo').tap();
				await sleep(800);
				assert.match(await doc(page), /view: top-right/);
				// two taps far apart in time are not a double tap
				await tap(page, 'pp');
				await sleep(600);
				await tap(page, 'pp');
				await sleep(800);
				assert.match(await doc(page), /view: top-right/);
			});
		}
	}
	failed += report();
	await browser.close();
}
process.exit(failed ? 1 : 0);
