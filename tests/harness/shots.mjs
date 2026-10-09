// Renders a gallery of boards and saves screenshots for a look at the drawing itself.
import { chromium, open, out } from './lib.mjs';

const JOSEKI = '(;GM[1]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])';
const KILL = `(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.]
(;B[ra]C[The middle of three is the vital point.];W[qa];B[sa]C[White has no eyes.])
(;B[qa];W[ra]C[White captures and has two eyes.])
(;B[sa];W[ra]C[White captures and has two eyes.]))`;

// a long, legal-enough game for three-figure numbers: stones on a diagonal lattice never touch
function longGame(n) {
	let s = '(;GM[1]SZ[19]PB[Honinbo Shusaku]PW[Gennan Inseki]RE[B+2]';
	let k = 0;
	for (let y = 0; y < 19 && k < n; y++) for (let x = (y % 2); x < 19 && k < n; x += 2, k++) {
		s += `;${k % 2 ? 'W' : 'B'}[${String.fromCharCode(97 + x)}${String.fromCharCode(97 + y)}]`;
	}
	return s + ')';
}

const note = [
	'# Gallery',
	'A joseki as a numbered figure, cropped automatically.',
	'```kifu', 'numbers: on', JOSEKI, '```',
	'A problem. The saved lines answer your moves.',
	'```kifu', KILL, '```',
	'Marks and labels.',
	'```kifu', 'view: top-right 10x8', '(;SZ[19]AB[pd][qf][oc][re]AW[nc][pb][rd][ob]TR[pd][oe]SQ[nc][qh]CR[qf][ne]MA[pb][pg]LB[qc:a][kc:b][pf:1][jc:12][re:x][rd:y])', '```',
	'Nine by nine, with coordinates.',
	'```kifu', 'coords: on', '(;SZ[9];B[ee];W[eg];B[dg];W[df];B[cf];W[de];B[dh];W[fh])', '```',
	'Thirteen by thirteen at 80%.',
	'```kifu', 'scale: 80%', 'view: full', '(;SZ[13]AB[dd][jj]AW[jd][dj];B[gg])', '```',
].join('\n');

const big = ['# Full board', '```kifu', 'numbers: on', 'coords: on', longGame(140), '```', 'Text after.'].join('\n');

const browser = await chromium.launch();
for (const [name, opts] of [
	['gallery-1x', { scale: 1 }],
	['gallery-2x', { scale: 2 }],
	['gallery-dark', { scale: 1, dark: true }],
	['gallery-dark-theme', { scale: 1, dark: true, data: { style: 'theme' } }],
	['gallery-liberation', { scale: 1, font: 'Liberation Sans' }],
	['gallery-150', { scale: 1.5 }],
]) {
	const { page, errors } = await open(browser, { ...opts, height: 2300, files: { 'Gallery.md': note }, panes: [{ path: 'Gallery.md', mode: 'preview' }] });
	await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
	if (errors.length) console.log(name, 'ERRORS', errors);
	await page.context().close();
}
{
	const { page, errors } = await open(browser, { scale: 1, height: 760, files: { 'Big.md': big }, panes: [{ path: 'Big.md', mode: 'preview' }] });
	await page.screenshot({ path: `${out}/big-1x.png` });
	if (errors.length) console.log('big ERRORS', errors);
	await page.context().close();
}
await browser.close();
console.log('done');
