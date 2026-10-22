// Rough timings: what the plugin costs at startup, and what a board costs to draw.
import { chromium, open, sleep } from './lib.mjs';
import { statSync } from 'node:fs';

const JOSEKI = '(;GM[1]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])';
const KILL = '(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.](;B[ra];W[qa];B[sa])(;B[qa];W[ra]))';
function longGame(n) {
	let s = '(;GM[1]SZ[19]';
	let k = 0;
	for (let y = 0; y < 19 && k < n; y++) for (let x = y % 2; x < 19 && k < n; x += 2, k++) s += `;${k % 2 ? 'W' : 'B'}[${String.fromCharCode(97 + x)}${String.fromCharCode(97 + y)}]`;
	return s + ')';
}
const many = Array.from({ length: 40 }, (_, i) => `Problem ${i + 1}\n\n\`\`\`kifu\nnumbers: on\n${JOSEKI}\n\`\`\`\n`).join('\n');
const big = '```kifu\nnumbers: on\n' + longGame(180) + '\n```\n';

const browser = await chromium.launch();
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const evals = [], loads = [];
for (let i = 0; i < 9; i++) {
	const { page } = await open(browser, { files: { 'A.md': 'no boards here\n' }, panes: [{ path: 'A.md', mode: 'preview' }] });
	evals.push(await page.evaluate(() => window.harness.evalMs));
	loads.push(await page.evaluate(() => window.harness.loadMs));
	await page.context().close();
}
console.log(`main.js: ${(statSync(new URL('../../main.js', import.meta.url)).size / 1024).toFixed(1)} kB`);
console.log(`evaluate main.js      median ${median(evals).toFixed(2)} ms  (runs: ${evals.map((v) => v.toFixed(1)).join(' ')})`);
console.log(`onload()              median ${median(loads).toFixed(3)} ms  (runs: ${loads.map((v) => v.toFixed(2)).join(' ')})`);

const { page } = await open(browser, { files: { 'M.md': many, 'B.md': big }, panes: [] });
const t = await page.evaluate(async () => {
	const h = window.harness;
	const time = async (path) => {
		const t0 = performance.now();
		const v = h.app.workspace._open(path, 'preview');
		await Promise.resolve(); await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		const n = v.containerEl.querySelectorAll('.kifu-svg').length;
		const nodes = v.containerEl.querySelectorAll('.kifu-svg *').length;
		return { ms: performance.now() - t0, boards: n, nodes };
	};
	const first = await time('M.md');     // includes reading settings for the first time
	const again = await time('M.md');
	const bigOne = await time('B.md');
	// redraw cost of one step through a long game
	const s = h.plugin; // (session is private; drive it through the DOM instead)
	const svg = [...document.querySelectorAll('.kifu')].pop();
	svg.focus();
	const t0 = performance.now();
	for (let i = 0; i < 100; i++) svg.dispatchEvent(new KeyboardEvent('keydown', { key: i % 2 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
	const step = (performance.now() - t0) / 100;
	return { first, again, bigOne, step };
});
console.log(`40 small boards, first note   ${t.first.ms.toFixed(1)} ms total  (${(t.first.ms / 40).toFixed(2)} ms each, ${t.first.nodes / 40} DOM nodes per board)`);
console.log(`40 small boards, again        ${t.again.ms.toFixed(1)} ms total  (${(t.again.ms / 40).toFixed(2)} ms each)`);
console.log(`full board, 180 numbered      ${t.bigOne.ms.toFixed(1)} ms  (${t.bigOne.nodes} DOM nodes)`);
console.log(`one step through that game    ${t.step.toFixed(2)} ms`);
await page.context().close();

// A note full of problems: does a board cost more when there are many? (The reading view
// draws them all at once; an editor draws only those on screen.)
{
	const n = 320;
	const problems = Array.from({ length: n }, (_, i) => `## Problem ${i + 1}\n\nSome words about it.\n\n\`\`\`kifu\n${KILL}\n\`\`\`\n`).join('\n');
	const { page } = await open(browser, { files: { 'P.md': problems }, panes: [], height: 20000 });
	const r = await page.evaluate(async () => {
		const h = window.harness;
		const run = async () => {
			const t0 = performance.now();
			const v = h.app.workspace._open('P.md', 'preview');
			await new Promise((r) => setTimeout(r, 0));
			// (the boards settle whose block they stand on over the next frames)
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
			const ms = performance.now() - t0;
			h.app.workspace._leaves.find((l) => l.view === v).detach();
			return ms;
		};
		const first = await run();
		await new Promise((r) => setTimeout(r, 50));
		return { first, again: await run() };
	});
	console.log(`${n} problems in one note        ${r.first.toFixed(0)} ms (${(r.first / n).toFixed(2)} ms each); reopened ${r.again.toFixed(0)} ms (${(r.again / n).toFixed(2)} ms each)`);
	await page.context().close();
}

// The editor extension runs in every Live Preview editor, at every keystroke and cursor
// move: what it costs in a large note that has no boards or links at all, against the
// same editor without it.
{
	const line = 'The quick brown fox jumps over the lazy dog, again and again, until the line is long enough.\n';
	const prose = line.repeat(Math.ceil((500 * 1024) / line.length));
	const costs = {};
	for (const withExt of [false, true]) {
		const { page } = await open(browser, { files: { 'L.md': prose }, panes: [] });
		await page.evaluate((withExt) => {
			const h = window.harness;
			const saved = h.app._editorExtensions;
			if (!withExt) h.app._editorExtensions = [];
			window.openLivePreview('L.md');
			h.app._editorExtensions = saved;
		}, withExt);
		await sleep(200);
		costs[withExt] = await page.evaluate(() => {
			const cm = window.harness.views[0].cm;
			const len = cm.state.doc.length;
			const time = (fn, n) => { const out = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(i); out.push(performance.now() - t0); } return out; };
			time((i) => cm.dispatch({ selection: { anchor: (i * 991) % len } }), 20); // (warm up)
			return { key: time((i) => cm.dispatch({ changes: { from: len + i, insert: 'x' } }), 40), move: time((i) => cm.dispatch({ selection: { anchor: (i * 997) % len } }), 80) };
		});
		await page.context().close();
	}
	const show = (k) => `${median(costs[true][k]).toFixed(2)} ms with the extension, ${median(costs[false][k]).toFixed(2)} without`;
	console.log(`500 kB note, no boards: a keystroke ${show('key')}; a cursor move ${show('move')}`);
}
await browser.close();
