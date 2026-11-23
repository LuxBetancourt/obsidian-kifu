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
		for (const mode of ['source', 'live']) {
			const panes = mode === 'live' ? { live: ['P.md'] } : { panes: [{ path: 'P.md', mode: 'source' }] };
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
				// the current move's stone dragged by a finger to another point (Chromium: its
				// protocol can move a touch; WebKit's driver can only tap)
				if (engine === 'chromium') {
					const cdp = await page.context().newCDPSession(page);
					const a = await pointXY(page, 0, 'sa');
					const b = await pointXY(page, 0, 'pe');
					const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
					await touch('touchStart', a);
					for (let k = 1; k <= 5; k++) await touch('touchMove', { x: a.x + ((b.x - a.x) * k) / 5, y: a.y + ((b.y - a.y) * k) / 5 });
					await touch('touchEnd', null);
					await sleep(800);
					assert.match(await doc(page), /W\[qa\]\s*;B\[pe\]/);
					// (and back, to leave the rest as it was)
					await tool(page, 'Undo').tap();
					await sleep(800);
					assert.match(await doc(page), /W\[qa\]\s*;B\[sa\]/);
				}
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
	// The line between the move tree and the comment, dragged by a finger (Chromium: its
	// protocol can move a touch). Its grip is wider on a touch screen, and a drag on it must
	// not be taken by the browser for a scroll.
	if (engine === 'chromium') {
		await scenario(`${engine}, iPad (gen 7): the line above the comment in the move tree panel is dragged by a finger`, { device: devices['iPad (gen 7)'], files: { 'P.md': note }, autosave: 100, panes: [{ path: 'P.md', mode: 'source' }] }, async (page) => {
			await page.evaluate(() => window.harness.app._commands.find((c) => c.id === 'show-tree').callback());
			await sleep(50);
			await page.evaluate(() => document.querySelector('.kifu').dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
			await sleep(300);
			const split = await page.locator('.kifu-p-split').boundingBox();
			assert.ok(split.height >= 20, `a grip of ${split.height}px`);
			const foot = () => page.locator('.kifu-p-foot').boundingBox().then((b) => b.height);
			const before = await foot();
			const cdp = await page.context().newCDPSession(page);
			const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
			const x = split.x + split.width / 2;
			const y = split.y + split.height / 2;
			await touch('touchStart', { x, y });
			for (let k = 1; k <= 8; k++) await touch('touchMove', { x, y: y - (120 * k) / 8 });
			await touch('touchEnd', null);
			await sleep(100);
			assert.ok(Math.abs((await foot()) - (before + 120)) <= 2, `the comment is ${await foot()}px, not ${before + 120}px`);
		});
	}
	// A finger dragged on an unlocked board with a tool that draws (here an arrow) draws, and
	// the note, long enough to scroll, does not scroll instead. (Chromium: its protocol can move a touch.)
	if (engine === 'chromium') {
		const long = note + '\n' + Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i + 1}.`).join('\n\n') + '\n';
		await scenario(`${engine}, iPad (gen 7): a finger draws an arrow on an unlocked board, and the note does not scroll`, { device: devices['iPad (gen 7)'], files: { 'P.md': long }, autosave: 100, panes: [{ path: 'P.md', mode: 'source' }] }, async (page) => {
			await sleep(100);
			await lockBtn(page).tap();
			await tool(page, 'Arrow or line').tap();
			const scrolled = () => page.evaluate(() => Math.max(...[document.scrollingElement, ...document.querySelectorAll('*')].map((e) => e.scrollTop)));
			const before = await scrolled();
			const a = await pointXY(page, 0, 'pe');
			const b = await pointXY(page, 0, 'pk');
			const cdp = await page.context().newCDPSession(page);
			const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
			await touch('touchStart', a);
			for (let k = 1; k <= 8; k++) await touch('touchMove', { x: a.x + ((b.x - a.x) * k) / 8, y: a.y + ((b.y - a.y) * k) / 8 });
			await touch('touchEnd', null);
			await sleep(800);
			assert.match(await doc(page), /AR\[pe:pk\]/);
			assert.equal(await scrolled(), before);
			// and painting a run of stones with a finger (the click-and-drag of the stone and mark tools)
			await tool(page, 'Black stone').tap();
			const c = await pointXY(page, 0, 'ng');
			const d = await pointXY(page, 0, 'nk');
			await touch('touchStart', c);
			for (let k = 1; k <= 8; k++) await touch('touchMove', { x: c.x, y: c.y + ((d.y - c.y) * k) / 8 });
			await touch('touchEnd', null);
			await sleep(800);
			assert.match(await doc(page), /\[ng\]\[nh\]\[ni\]\[nj\]\[nk\]/);
			assert.equal(await scrolled(), before);
		});
	}
	failed += report();
	await browser.close();
}
process.exit(failed ? 1 : 0);
