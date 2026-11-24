// The animations of the "what's new" window: docs/whatsnew/*.gif. Each is a short
// recording of the built plugin in the stand-in, with a drawn pointer (a recording shows
// none) and the keys pressed shown as they are, turned into a GIF by ffmpeg (which must be
// on the PATH). Run after a build:
//   node tests/harness/whatsnew.mjs
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, open, here, pointXY, sleep, toggleLock, lockBtn, tool } from './lib.mjs';

const docs = path.resolve(here, '../../docs/whatsnew');
const tmp = path.resolve(here, '../out/whatsnew');
mkdirSync(docs, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const W = 560;
const H = 560;
const browser = await chromium.launch();

/** ONLY=pattern in the environment makes just the pictures whose names match. */
const wanted = (name) => !process.env.ONLY || new RegExp(process.env.ONLY).test(name);

/** Record `fn` on a fresh page and write it as docs/whatsnew/<name>.gif. */
async function record(name, opts, fn) {
	if (!wanted(name)) return;
	const dir = path.join(tmp, name);
	// (the recording starts with the page, blank until the plugin has drawn: the GIF starts after that)
	const t0 = Date.now();
	const { page, errors } = await open(browser, {
		device: { viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: W, height: H } } },
		...opts,
	});
	await page.addStyleTag({
		content: `
			.view-header { display: none }
			.markdown-preview-view, .cm-content { padding: 18px 28px }
			#kifu-pointer { position: fixed; z-index: 99; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
				background: rgba(80, 140, 255, .25); border: 2px solid rgba(40, 100, 230, .9); pointer-events: none; transition: transform .08s }
			#kifu-pointer.down { transform: scale(.7) }
			#kifu-key { position: fixed; z-index: 99; right: 22px; top: 22px; min-width: 22px; padding: 5px 11px; text-align: center;
				font: 600 17px/1.2 system-ui, sans-serif; color: #222; background: #fff; border: 1px solid #b8b8b8; border-bottom-width: 3px;
				border-radius: 7px; box-shadow: 0 2px 6px rgba(0,0,0,.12); opacity: 0; transition: opacity .25s }
			#kifu-key.on { opacity: 1; transition: none }`,
	});
	// a pointer that follows the mouse, since the recording has none; and each key pressed, for a moment
	await page.evaluate(() => {
		const dot = document.createElement('div');
		dot.id = 'kifu-pointer';
		dot.style.left = '-50px';
		document.body.appendChild(dot);
		addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
		addEventListener('mousedown', () => dot.classList.add('down'), true);
		addEventListener('mouseup', () => dot.classList.remove('down'), true);
		const cap = document.createElement('div');
		cap.id = 'kifu-key';
		document.body.appendChild(cap);
		let off = 0;
		addEventListener('keydown', (e) => {
			if (e.key === 'Shift' || e.key === 'Control') return;
			cap.textContent = e.key === 'Escape' ? 'Esc' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
			cap.classList.add('on');
			clearTimeout(off);
			off = setTimeout(() => cap.classList.remove('on'), 900);
		}, true);
	});
	const ready = (Date.now() - t0) / 1000;
	await sleep(500);
	await fn(page);
	await sleep(900);
	const video = page.video();
	await page.context().close();
	const webm = await video.path();
	if (errors.length) console.log(name, errors);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', ready.toFixed(2), '-i', webm, '-vf', 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none', '-loop', '0', path.join(docs, name + '.gif')]);
	console.log('wrote', name + '.gif');
}

/** Move the pointer to a point of the nth board, slowly enough to be followed. */
async function moveTo(page, board, pt, steps = 14) {
	const p = await pointXY(page, board, pt);
	await page.mouse.move(p.x, p.y, { steps });
	return p;
}

/** Move the pointer onto something (a button) and click it. */
async function press(page, target, steps = 9) {
	const b = await target.boundingBox();
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
	await sleep(200);
	await page.mouse.down();
	await sleep(90);
	await page.mouse.up();
}

/** A click on a point of the nth board. */
async function tap(page, board, pt) {
	await moveTo(page, board, pt, 9);
	await sleep(200);
	await page.mouse.down();
	await sleep(90);
	await page.mouse.up();
}

/** A drag from one point of the nth board to another. */
async function drag(page, board, from, to, steps = 12) {
	await moveTo(page, board, from, 9);
	await sleep(200);
	await page.mouse.down();
	await sleep(100);
	await moveTo(page, board, to, steps);
	await sleep(150);
	await page.mouse.up();
}

/** A key, then a moment to see what it did. */
async function key(page, k, after = 800) {
	await page.keyboard.press(k);
	await sleep(after);
}

// a made-up opening, long enough to step through
const GAME = '(;GM[1]FF[4]SZ[19]PB[Black]PW[White];B[pd];W[dp];B[pp];W[dc];B[de];W[ce];B[cf];W[cd];B[df];W[ec];B[jd];W[qn];B[nq];W[qf];B[nd];W[qq];B[pq];W[qp];B[qo];W[ro];B[po];W[rn];B[qh];W[of];B[mf];W[qd];B[qc];W[rc];B[pc];W[rd];B[og];W[pf];B[nf];W[rb])';

// a made-up game on a small board
const SMALL = '(;GM[1]FF[4]SZ[9];B[ee];W[gc];B[cg];W[cc];B[dc];W[cd];B[ge];W[gf])';

// 1. Dragging the current move's stone
await record('drag', {
	files: { 'Game.md': '# A game\n\n```kifu\nscale: 150%\n' + SMALL + '\n```\n' },
	panes: [{ path: 'Game.md', mode: 'source' }],
	autosave: 100,
	data: { revealPanel: false },
}, async (page) => {
	const box = await page.locator('.kifu-svg').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
	await sleep(300);
	await toggleLock(page);
	await sleep(800);
	// the last move, White's at G4, put on G2
	await moveTo(page, 0, 'gf');
	await sleep(400);
	await page.mouse.down();
	await sleep(250);
	await moveTo(page, 0, 'gg', 10);
	await moveTo(page, 0, 'gh', 10);
	await sleep(300);
	await page.mouse.up();
	await sleep(1200);
	// and back again
	await page.mouse.down();
	await moveTo(page, 0, 'gg', 10);
	await moveTo(page, 0, 'gf', 10);
	await sleep(200);
	await page.mouse.up();
	await sleep(600);
});

// 2. An SGF file embedded at a move, then at a point
await record('embed', {
	files: { 'game.sgf': GAME, 'Notes.md': '' },
	panes: [{ path: 'Notes.md', mode: 'source' }],
	autosave: 100,
}, async (page) => {
	// the link as text above the board (with an invisible joiner after the "!", so that it stays text)
	const show = (link) => page.evaluate((link) => window.harness.views[0]._edit(`${link.replace('!', '!⁠')}\n\n${link}\n`), link);
	await show('![[game.sgf#10]]');
	await sleep(1600);
	await show('![[game.sgf#20]]');
	await sleep(1600);
	await show('![[game.sgf#R4]]');
	await sleep(1800);
	await show('![[game.sgf]]');
	await sleep(1400);
});

// 3. A Josekipedia position, embedded, and a continuation played on it
await record('josekipedia', {
	files: { 'Joseki.md': '# Star point, approach\n\n![](https://www.josekipedia.com/#path:pdqf)\n' },
	panes: [],
}, async (page) => {
	await page.evaluate((nodes) => {
		const { requestUrl } = window.__obsidian;
		for (const [id, text] of Object.entries(nodes)) requestUrl.answers[`https://www.josekipedia.com/db/node.php?id=${id}`] = { status: 200, text };
		const h = window.harness;
		h.views.push(h.app.workspace._open('Joseki.md', 'preview'));
	// (fetched from Josekipedia as this runs: its contributors' comments are not kept in this repository)
	}, Object.fromEntries(await Promise.all([1, 40, 42].map(async (id) => [id, await (await fetch(`https://www.josekipedia.com/db/node.php?id=${id}`)).text()]))));
	await sleep(1800);
	await moveTo(page, 0, 'nc');
	await sleep(300);
	await page.mouse.down();
	await page.mouse.up();
	await moveTo(page, 0, 'jg', 10); // (out of the way)
	await sleep(2600);
	// back, and another one
	const reset = page.locator('.kifu-ctl .kifu-btn[aria-label^="Back to the starting position"]');
	const r = await reset.boundingBox();
	await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 12 });
	await page.mouse.down();
	await page.mouse.up();
	await sleep(900);
	await moveTo(page, 0, 'qh');
	await page.mouse.down();
	await page.mouse.up();
	await moveTo(page, 0, 'jj', 10);
	await sleep(2600);
});

// 4. Screenshots: an SGF file in a tab of its own, with the move tree panel; the game info form
async function shot(name, opts, fn) {
	if (!wanted(name)) return;
	const { page, errors } = await open(browser, { width: W, height: H, scale: 2, ...opts });
	await page.addStyleTag({ content: '.view-header { padding: 6px 12px; font-weight: 600; border-bottom: 1px solid #ddd }' });
	const clip = await fn(page);
	await page.screenshot({ path: path.join(docs, name + '.png'), clip });
	if (errors.length) console.log(name, errors);
	await page.context().close();
	console.log('wrote', name + '.png');
}

const INFO = '(;GM[1]FF[4]SZ[19]GN[Club league, round 3]PB[Kim]BR[3d]PW[Sato]WR[2d]KM[6.5]RE[B+4.5]DT[2026-10-12]' + GAME.slice(GAME.indexOf(';B['));

await shot('viewer', { files: { 'Club game.sgf': INFO }, panes: [], width: 900, height: 600 }, async (page) => {
	await page.evaluate(() => window.harness.plugin.showPanel(true));
	await page.evaluate(() => window.harness.app.workspace._openFile('Club game.sgf'));
	await sleep(600);
	return { x: 0, y: 0, width: 900, height: 600 };
});

await shot('gameinfo', { files: { 'Club game.sgf': INFO }, panes: [], width: 640, height: 1000, data: { revealPanel: false } }, async (page) => {
	await page.evaluate(() => window.harness.app.workspace._openFile('Club game.sgf'));
	await page.evaluate(() => window.harness.plugin.showPanel(true));
	await sleep(300);
	await toggleLock(page);
	await page.locator('.kifu-p-game .kifu-btn[aria-label^="Game info"]').click();
	await sleep(300);
	// the form by itself, as Obsidian shows it: a window over the page
	await page.addStyleTag({ content: '.modal-content.kifu-game-info { position: fixed; left: 20px; right: 20px; top: 20px; z-index: 50; background: #fff; border: 1px solid #ccc; border-radius: 8px; padding: 18px 22px; box-shadow: 0 6px 24px rgba(0,0,0,.18) } .kifu-game-info .setting-item { padding: 5px 0 } .kifu-game-info::before { content: "Game info"; display: block; font-weight: 600; font-size: 1.1em; margin-bottom: 8px }' });
	const box = await page.locator('.modal-content.kifu-game-info').boundingBox();
	return box;
});

// 5. Marking up a diagram: a shape, an arrow, an area highlighted and one dimmed, with the buttons' palettes
const FIGHT = '(;GM[1]FF[4]SZ[9]AB[ee][cg][dc][ge]AW[gc][cc][cd][gf])';

await record('markup', {
	files: { 'Fight.md': '# Black to play\n\n```kifu\nview: full\nscale: 160%\n' + FIGHT + '\n```\n' },
	panes: [{ path: 'Fight.md', mode: 'source' }],
	autosave: 100,
	data: { revealPanel: false },
}, async (page) => {
	const box = await page.locator('.kifu-svg').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
	await sleep(200);
	await press(page, lockBtn(page));
	await sleep(500);
	// a triangle: the button's palette comes up with it, and a click on the board puts it away
	await press(page, tool(page, 'Triangle, square'));
	await sleep(1000);
	await tap(page, 0, 'gf');
	await sleep(500);
	// an arrow, dragged
	await press(page, tool(page, 'Arrow or line'));
	await sleep(700);
	await drag(page, 0, 'ee', 'eg');
	await sleep(600);
	// an area highlighted, dragged across; another dimmed, chosen in the palette (with the
	// highlight in hand, it comes up as the pointer reaches the button)
	const area = tool(page, 'Highlight, dim');
	await press(page, area);
	await sleep(700);
	await drag(page, 0, 'af', 'dh');
	await sleep(600);
	const ab = await area.boundingBox();
	await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2, { steps: 9 });
	await sleep(600);
	await press(page, page.locator('.kifu-palette .kifu-btn[aria-label^="Dim"]'), 6);
	await sleep(200);
	await drag(page, 0, 'aa', 'dd');
	await sleep(700);
	// locked: the diagram as it reads
	await press(page, lockBtn(page));
	await sleep(1800);
});

// 6. Territory worked out at once, and a dead stone made alive by a click, then dead again
const END = '(;GM[1]FF[4]SZ[9]AB[ca][bb][cb][gb][bc][ad][bd][cd][ce][de][ee][fe][ff][gf][cg][fg][eh][gh][fi][gi]AW[da][db][fb][cc][dc][hc][dd][ed][fd][gd][ge][he][ie][hf][bg][gg][hg][hh][hi])';

await record('territory', {
	files: { 'Count.md': '# Who is ahead?\n\n```kifu\nscale: 160%\n' + END + '\n```\n' },
	panes: [{ path: 'Count.md', mode: 'source' }],
	autosave: 100,
	data: { revealPanel: false },
}, async (page) => {
	const box = await page.locator('.kifu-svg').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
	await sleep(300);
	await press(page, lockBtn(page));
	await sleep(700);
	await press(page, tool(page, 'Highlight, dim'));
	await sleep(1100);
	await press(page, page.locator('.kifu-palette .kifu-btn[aria-label^="Territory"]'), 10);
	await sleep(2200);
	// the white stone in black's corner alive after all, and black's territory shrinks; then dead again
	await tap(page, 0, 'bg');
	await sleep(1500);
	await tap(page, 0, 'bg');
	await sleep(1500);
	await press(page, lockBtn(page));
	await sleep(1500);
});

// 7. Keys: Enter unlocks, a letter takes up a tool, Esc locks. (Each key waits for the save of the
// clicks before it: a key pressed in the instant a save redraws the board is lost, and the GIF with it.)
await record('keys', {
	files: { 'Keys.md': '# From the keyboard\n\n```kifu\nview: full\nscale: 160%\n(;GM[1]FF[4]SZ[9])\n```\n' },
	panes: [{ path: 'Keys.md', mode: 'source' }],
	autosave: 100,
	data: { revealPanel: false },
}, async (page) => {
	const inHand = async (k, title) => {
		await key(page, k, 500);
		const on = await tool(page, title).evaluate((b) => b.classList.contains('is-active'));
		if (!on) throw new Error(`keys: ${k} did not take up ${title}`);
	};
	await page.locator('.kifu').first().evaluate((e) => e.focus());
	await sleep(500);
	await key(page, 'Enter', 1000);
	await inHand('b', 'Black stone');
	await tap(page, 0, 'cc');
	await tap(page, 0, 'gc');
	await sleep(700);
	await inHand('w', 'White stone');
	await tap(page, 0, 'cg');
	await tap(page, 0, 'gg');
	await sleep(700);
	await inHand('t', 'Triangle, square');
	await tap(page, 0, 'gg');
	await sleep(700);
	await inHand('a', 'Arrow or line');
	await drag(page, 0, 'cc', 'ee');
	await sleep(700);
	await inHand('h', 'Highlight, dim');
	await drag(page, 0, 'dd', 'ff');
	await sleep(700);
	await page.mouse.move(W - 40, H - 30, { steps: 10 });
	await key(page, 'Escape', 1800);
});

await browser.close();
for (const f of readdirSync(docs)) console.log(f);
