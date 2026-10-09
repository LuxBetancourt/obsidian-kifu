// Rough timings: what the plugin costs at startup, and what a board costs to draw.
import { chromium, open, mainJs } from './lib.mjs';
import { statSync } from 'node:fs';

const JOSEKI = '(;GM[1]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])';
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
await browser.close();
