// CPU profiles of the hot paths, with the functions named: rendering a note of 320
// boards in the reading view (first open, and reopened with its sessions known), stepping
// through a long game, and cursor moves in a 500 kB note in Live Preview (what the editor
// extension costs in a note with no boards at all). Builds an unminified bundle of the
// plugin for itself, so that the names survive; main.js is left alone.
//   node tests/harness/profile.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { here, out } from './lib.mjs';

const require = createRequire(import.meta.url);
const dev = path.join(out, 'main.dev.js');
await require('esbuild').build({
	entryPoints: [path.resolve(here, '../../src/main.ts')],
	bundle: true,
	format: 'cjs',
	target: 'es2022',
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	outfile: dev,
	logLevel: 'error',
});
process.env.KIFU_MAIN = dev;
const { chromium, open, sleep } = await import('./lib.mjs');

const KILL = '(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.](;B[ra];W[qa];B[sa])(;B[qa];W[ra]))';
const note = (n) => Array.from({ length: n }, (_, i) => `## Problem ${i + 1}\n\nSome words about it.\n\n\`\`\`kifu\n${KILL}\n\`\`\`\n`).join('\n');
const prose = (kb) => { const line = 'The quick brown fox jumps over the lazy dog, again and again, until the line is long enough.\n'; return line.repeat(Math.ceil((kb * 1024) / line.length)); };
function longGame(n) {
	let s = '(;GM[1]SZ[19]';
	let k = 0;
	for (let y = 0; y < 19 && k < n; y++) for (let x = y % 2; x < 19 && k < n; x += 2, k++) s += `;${k % 2 ? 'W' : 'B'}[${String.fromCharCode(97 + x)}${String.fromCharCode(97 + y)}]`;
	return s + ')';
}

/** Run `fn` under the profiler; print the functions with the most self time, and the total sampled. */
async function profile(page, label, fn, top = 16) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
	await cdp.send('Profiler.start');
	await fn();
	const { profile: p } = await cdp.send('Profiler.stop');
	await cdp.detach();
	const self = new Map();
	const byId = new Map(p.nodes.map((n) => [n.id, n]));
	let total = 0;
	for (let i = 0; i < p.samples.length; i++) {
		const f = byId.get(p.samples[i]).callFrame;
		const dt = (p.timeDeltas[i] ?? 0) / 1000;
		total += dt;
		// (the plugin is loaded as the body of a function: its frames have no URL, only a line)
		const where = f.url ? ` [${f.url.split('/').pop()}:${f.lineNumber + 1}]` : f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : '';
		const name = (f.functionName || '(anonymous)') + where;
		self.set(name, (self.get(name) ?? 0) + dt);
	}
	console.log(`\n--- ${label}: ${total.toFixed(0)} ms sampled`);
	for (const [name, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms.toFixed(1).padStart(7)} ms ${(100 * ms / total).toFixed(0).padStart(3)}%  ${name}`);
}

const browser = await chromium.launch();
{
	const { page } = await open(browser, { files: { 'N.md': note(320), 'G.md': '```kifu\n' + longGame(180) + '\n```\n' }, panes: [], height: 20000 });
	const run = () => page.evaluate(async () => {
		const h = window.harness;
		const v = h.app.workspace._open('N.md', 'preview');
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
		h.app.workspace._leaves.find((l) => l.view === v).detach();
	});
	await profile(page, '320 boards, first open (reading view)', run);
	await sleep(100);
	await profile(page, '320 boards, reopened', run);
	await page.evaluate(() => { window.harness.app.workspace._open('G.md', 'preview'); });
	await sleep(100);
	await profile(page, '200 steps through a 180-move game', () => page.evaluate(() => {
		const k = document.querySelector('.kifu');
		k.focus();
		for (let i = 0; i < 200; i++) k.dispatchEvent(new KeyboardEvent('keydown', { key: i % 2 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
	}));
	await page.context().close();
}
{
	const { page } = await open(browser, { files: { 'P.md': prose(500) }, live: ['P.md'] });
	await sleep(200);
	await profile(page, '500 kB note with no boards, 80 cursor moves (Live Preview)', () => page.evaluate(() => {
		const cm = window.harness.views[0].cm;
		const len = cm.state.doc.length;
		for (let i = 0; i < 80; i++) cm.dispatch({ selection: { anchor: (i * 997) % len } });
	}), 10);
	await page.context().close();
}
await browser.close();
