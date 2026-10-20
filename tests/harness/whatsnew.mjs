// The animations of the "what's new" window: docs/whatsnew/*.gif. Each is a short
// recording of the built plugin in the stand-in, with a drawn pointer (a recording shows
// none), turned into a GIF by ffmpeg (which must be on the PATH). Run after a build:
//   node tests/harness/whatsnew.mjs
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, open, here, pointXY, sleep, toggleLock } from './lib.mjs';

const docs = path.resolve(here, '../../docs/whatsnew');
const tmp = path.resolve(here, '../out/whatsnew');
mkdirSync(docs, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const W = 560;
const H = 560;
const browser = await chromium.launch();

/** Record `fn` on a fresh page and write it as docs/whatsnew/<name>.gif. */
async function record(name, opts, fn) {
	const dir = path.join(tmp, name);
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
			#kifu-pointer.down { transform: scale(.7) }`,
	});
	// a pointer that follows the mouse, since the recording has none
	await page.evaluate(() => {
		const dot = document.createElement('div');
		dot.id = 'kifu-pointer';
		dot.style.left = '-50px';
		document.body.appendChild(dot);
		addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
		addEventListener('mousedown', () => dot.classList.add('down'), true);
		addEventListener('mouseup', () => dot.classList.remove('down'), true);
	});
	await sleep(500);
	await fn(page);
	await sleep(900);
	const video = page.video();
	await page.context().close();
	const webm = await video.path();
	if (errors.length) console.log(name, errors);
	execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-vf', 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none', '-loop', '0', path.join(docs, name + '.gif')]);
	console.log('wrote', name + '.gif');
}

/** Move the pointer to a point of the nth board, slowly enough to be followed. */
async function moveTo(page, board, pt, steps = 14) {
	const p = await pointXY(page, board, pt);
	await page.mouse.move(p.x, p.y, { steps });
	return p;
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

await browser.close();
for (const f of readdirSync(docs)) console.log(f);
