import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseSgf, serializeSgf, findGames, isClosed, getMove, boardSize, getText, setText,
	escapeText, unescapeText, points, pathTo, eachNode, xy2pt,
} from '../src/sgf';
import { Board, replay, buildFigure } from '../src/goban';
import {
	parseBlock, composeBlock, setOption, parseScale, parseNumbers, parseView, autoView,
	formatRect, starPoints, parseSize, pointName,
} from '../src/options';
import { Located, Place, blockOn, findBlocks, follow, linesOf, locate, readNote, reading, replaceBody, sameText } from '../src/blocks';
import { layoutLine, layoutTree, STRIDE } from '../src/tree';

/* ------------------------------------------------------------------ SGF */

test('sgf: parses variations and keeps unknown properties', () => {
	const src = '(;GM[1]FF[4]SZ[9]XX[custom\\]value]AB[cc][dd]AW[ee];B[aa](;W[bb]C[hi])(;W[cb];B[dc]))';
	const [root] = parseSgf(src);
	assert.deepEqual(root.props.AB, ['cc', 'dd']);
	assert.equal(root.props.XX[0], 'custom\\]value');
	assert.equal(root.children.length, 1);
	assert.equal(root.children[0].children.length, 2);
	assert.equal(getText(root.children[0].children[0], 'C'), 'hi');
	assert.deepEqual(boardSize(root), [9, 9]);
	// round trip is stable
	const out = serializeSgf(root);
	assert.equal(serializeSgf(parseSgf(out)[0]), out);
	assert.equal(out.replace(/\s/g, ''), src);
});

test('sgf: tolerant of whitespace, long names and junk', () => {
	const src = 'some header text\n( ; GaMe[1] SiZe[13:9]\n AddBlack [aa] [bb]\n ; Black[cc] Comment[a \\] b\\\\] )\ntrailing';
	const [root] = parseSgf(src);
	assert.deepEqual(boardSize(root), [13, 9]);
	assert.deepEqual(root.props.AB, ['aa', 'bb']);
	assert.equal(getText(root.children[0], 'C'), 'a ] b\\');
	const m = getMove(root.children[0], 13, 9);
	assert.deepEqual(m, { color: 1, x: 2, y: 2, pass: false });
});

test('sgf: collections, passes, compressed lists', () => {
	const text = '(;GM[1]C[one (with parens) and \\] bracket])\n\n(;GM[1]SZ[19];B[tt];W[]) junk (;GM[1]AB[aa:cb])';
	const parts = findGames(text);
	assert.equal(parts.length, 3);
	assert.equal(text.slice(...parts[0]), '(;GM[1]C[one (with parens) and \\] bracket])');
	assert.equal(text.slice(...parts[2]), '(;GM[1]AB[aa:cb])');
	const roots = parseSgf(text);
	assert.equal(roots.length, 3);
	assert.equal(getMove(roots[1].children[0])!.pass, true);
	assert.equal(getMove(roots[1].children[0].children[0])!.pass, true);
	assert.deepEqual(points(roots[2].props.AB), ['aa', 'ba', 'ca', 'ab', 'bb', 'cb']);
});

test('sgf: finding the games in a text that holds other things too', () => {
	const spans = (t: string) => findGames(t).map(([a, b]) => t.slice(a, b));
	// remarks in parentheses are not games, even with a parenthesis that is never closed
	assert.deepEqual(spans('(c) 1998 someone\n(;SZ[9]AB[cc])\n(see page 12)'), ['(;SZ[9]AB[cc])']);
	assert.deepEqual(spans('(note: see below\n(;SZ[9]AB[cc])'), ['(;SZ[9]AB[cc])']);
	assert.deepEqual(spans('a) first\n( ;SZ[9](;B[aa])(;B[bb]))\nb) second'), ['( ;SZ[9](;B[aa])(;B[bb]))']);
	// brackets and parentheses inside a comment do not count
	assert.deepEqual(spans('(;C[a ) and \\] and ( b];B[aa])(;B[bb])'), ['(;C[a ) and \\] and ( b];B[aa])', '(;B[bb])']);
	assert.deepEqual(spans('no games here (at all)'), []);
	// a game that is cut short runs to the end, and says so
	const cut = '(;SZ[9]AB[cc]\nsome notes';
	assert.deepEqual(spans(cut), [cut]);
	assert.equal(isClosed(cut), false);
	assert.equal(isClosed('(;SZ[9](;B[aa])'), false);
	assert.equal(isClosed('(;SZ[9]AB[cc])  \n'), true);
	assert.equal(isClosed('(;SZ[9](;B[aa])(;B[bb]))'), true);
	assert.equal(isClosed('(;SZ[9]C[unfinished)'), false);
});

test('sgf: text escaping protects code fences', () => {
	const t = 'line ] one \\ two\n```\n   ~~~ fence';
	const raw = escapeText(t);
	assert.ok(!/^\s*(```|~~~)/m.test(raw));
	assert.equal(unescapeText(raw), t);
	const [root] = parseSgf('(;C[x])');
	setText(root, 'C', t);
	assert.equal(getText(parseSgf(serializeSgf(root))[0], 'C'), t);
	setText(root, 'C', '');
	assert.equal(root.props.C, undefined);
});

test('sgf: scratch nodes are never written', () => {
	const [root] = parseSgf('(;SZ[9];B[aa])');
	const n = root.children[0];
	n.children.push({ parent: n, children: [], props: { W: ['bb'] }, temp: true });
	root.children.push({ parent: root, children: [], props: { B: ['cc'] }, temp: true });
	assert.equal(serializeSgf(root), '(;SZ[9];B[aa])');
});

test('sgf: very deep trees do not overflow the stack', () => {
	let s = '(;SZ[19]';
	for (let i = 0; i < 20000; i++) s += `;${i % 2 ? 'W' : 'B'}[${xy2pt(i % 19, (i * 7) % 19)}]`;
	s += ')';
	const [root] = parseSgf(s);
	let n = 0;
	eachNode(root, () => n++);
	assert.equal(n, 20001);
	assert.equal(serializeSgf(root).replace(/\n/g, ''), s);
	assert.equal(layoutTree(root).rows, 20001);
});

/* ---------------------------------------------------------------- rules */

function boardFrom(rows: string[]): Board {
	const h = rows.length;
	const w = rows[0].length;
	const b = new Board(w, h);
	rows.forEach((r, y) => [...r].forEach((c, x) => (b.g[y * w + x] = c === 'X' ? 1 : c === 'O' ? 2 : 0)));
	return b;
}
const show = (b: Board) =>
	Array.from({ length: b.h }, (_, y) =>
		Array.from({ length: b.w }, (_, x) => '.XO'[b.g[y * b.w + x]]).join(''),
	);

test('rules: capture, multi-group capture, suicide', () => {
	let b = boardFrom(['.O.', 'OXO', '...']);
	assert.equal(b.play(7, 2), 1);
	assert.deepEqual(show(b), ['.O.', 'O.O', '.O.']);

	b = boardFrom(['XO.', 'O..', '...']);
	assert.equal(b.legal(0, 1), false);
	// two separate groups captured by one move
	b = boardFrom(['OX.XO', 'X...X', '.....']);
	assert.equal(b.legal(2, 1), true);
	// a point surrounded by living enemy stones is suicide; the same point is fine for their owner
	b = boardFrom(['.X.', 'X.X', '.X.']);
	assert.equal(b.legal(4, 2), false);
	assert.equal(b.legal(4, 1), true);
	b = boardFrom(['.X.', 'X..', '...']);
	assert.equal(b.legal(0, 2), false);
	// replaying a suicide from a file removes the stones instead of refusing
	assert.equal(b.clone().play(0, 2), 1);
	// capturing makes an otherwise suicidal move legal
	b = boardFrom(['.XO.', 'XXO.', 'OO..']);
	assert.equal(b.legal(0, 2), true);
	const c = b.clone();
	assert.equal(c.play(0, 2), 3);
	assert.deepEqual(show(c), ['O.O.', '..O.', 'OO..']);
});

test('rules: ko', () => {
	// classic ko shape
	const b = boardFrom(['.XO.', 'XO.O', '.XO.', '....']);
	assert.equal(b.legal(6, 1), true);
	assert.equal(b.play(6, 1), 1); // black takes the stone at 5
	assert.equal(b.ko, 5);
	assert.equal(b.legal(5, 2), false); // white may not retake at once
	assert.equal(b.legal(5, 1), true); // ...though the one who took may fill the ko
	b.play(15, 2); // ko threat elsewhere
	assert.equal(b.ko, -1);
	assert.equal(b.legal(5, 2), true);
});

test('rules: replay tracks move numbers through captures and setup', () => {
	// B captures a W stone in the corner; W later plays on the freed point
	const [root] = parseSgf('(;SZ[5]AW[aa]AB[ba];B[ab];W[cc];B[dd];W[aa])');
	const last = pathTo(root.children[0].children[0].children[0].children[0]);
	const r = replay(last, 5, 5);
	assert.equal(r.moveNo, 4);
	assert.equal(r.board.g[0], 0); // W4 at aa has no liberties and captures nothing: it comes off again
	assert.equal(r.num[5], 1);
	const r2 = replay(last.slice(0, 2), 5, 5);
	assert.equal(r2.board.g[0], 0); // captured by move 1
	assert.equal(r2.num[5], 1);
	assert.equal(r2.last, 5);
	// MN renumbers
	const [g2] = parseSgf('(;SZ[9];B[aa]MN[51];W[bb];B[cc])');
	assert.equal(replay(pathTo(g2.children[0].children[0].children[0]), 9, 9).moveNo, 53);
});

test('rules: setup after move within a node, AE removes', () => {
	const [root] = parseSgf('(;SZ[5]AB[aa][bb];W[cc]AE[aa]AW[bb])');
	const r = replay(pathTo(root.children[0]), 5, 5);
	assert.equal(r.board.g[0], 0);
	assert.equal(r.board.g[6], 2);
	assert.equal(r.board.g[12], 2);
	const base = replay(pathTo(root.children[0]), 5, 5, true);
	assert.equal(base.board.g[0], 1);
	assert.equal(base.board.g[6], 1);
});

test('figure: captured stones stay and repeats become notes', () => {
	//   a b c d e        B1 at c4 takes the ko (capturing b4), W2 and B3 are played
	// 5 . X O . .        elsewhere, W4 retakes at b4.
	// 4 X O . O .
	// 3 . X O . .
	const sgf = '(;SZ[5]AB[ba][ab][bc]AW[ca][bb][db][cc];B[cb];W[ee];B[ed];W[bb])';
	const [root] = parseSgf(sgf);
	const path = pathTo(root.children[0].children[0].children[0].children[0]);
	const afterB1 = replay(path.slice(0, 2), 5, 5);
	assert.equal(afterB1.board.g[6], 0);
	assert.equal(afterB1.board.ko, 6);
	const live = replay(path, 5, 5);
	assert.equal(live.board.g[6], 2); // W back on b4
	assert.equal(live.board.g[7], 0); // and B1 is gone
	assert.equal(live.num[6], 4);
	const fig = buildFigure(path, 5, 5, 1, 1, (i) => pointName(i % 5, Math.floor(i / 5), 5));
	assert.equal(fig.grid[7], 1); // B1 is still drawn
	assert.equal(fig.labels.get(7), '1');
	assert.equal(fig.grid[6], 2); // so is the white stone it captured
	assert.equal(fig.labels.get(6), undefined);
	assert.equal(fig.labels.get(24), '2');
	assert.equal(fig.labels.get(19), '3');
	assert.deepEqual(fig.notes, [{ label: '4', color: 2, at: 'B4', atColor: 0 }]);
	// the same moves as a figure that starts at move 3 and calls it 1
	const fig2 = buildFigure(path, 5, 5, 3, 1, () => '?');
	assert.equal(fig2.grid[6], 2);
	assert.equal(fig2.labels.get(6), '2'); // W4 lands on a point that is empty by then
	assert.equal(fig2.grid[7], 1); // B1 stays although W4 captures it
	assert.equal(fig2.labels.get(7), undefined);
	assert.equal(fig2.labels.get(19), '1');
	assert.equal(fig2.notes.length, 0);
	// a numbered stone that is played on again is named by its number
	const [g3] = parseSgf('(;SZ[5]AB[ba][ab][bc]AW[ca][db][cc];W[bb];B[cb];W[ee];B[ed];W[bb])');
	const p3 = pathTo(g3.children[0].children[0].children[0].children[0].children[0]);
	assert.deepEqual(buildFigure(p3, 5, 5, 1, 1, () => '?').notes, [{ label: '5', color: 2, at: '1', atColor: 2 }]);
});

/* -------------------------------------------------------------- options */

test('options: block parsing and composing', () => {
	const src = 'view: top-right\nScale: 80%\n# a note\n\n(;SZ[9]\n;B[aa])\n';
	const b = parseBlock(src);
	assert.deepEqual(b.opts, { view: 'top-right', scale: '80%' });
	assert.deepEqual(b.header, ['view: top-right', 'Scale: 80%', '# a note', '']);
	assert.equal(b.rest, '(;SZ[9]\n;B[aa])');
	assert.deepEqual(b.games, [[0, 15]]);
	// put back together unchanged, it is the same text (minus the trailing newline)
	assert.equal(composeBlock(b.header, b.rest, b.rest, b.games[0]), src.trimEnd());
	assert.equal(composeBlock(b.header, b.rest, '(;SZ[9])', b.games[0]), 'view: top-right\nScale: 80%\n# a note\n\n(;SZ[9])');
	assert.equal(composeBlock([], '', null, null), '');
	assert.equal(composeBlock([], '', '(;SZ[9])', null), '(;SZ[9])');
	assert.equal(composeBlock(['a: 1'], '', '(;SZ[9])', null), 'a: 1\n(;SZ[9])');
	assert.equal(composeBlock(['a: 1'], '(;SZ[9])', null, [0, 8]), 'a: 1'); // the game taken out again
	assert.deepEqual(parseBlock('').header, []);
	assert.deepEqual(setOption(b.header, 'view', 'K10-T19'), ['view: K10-T19', 'Scale: 80%', '# a note', '']);
	assert.deepEqual(setOption(b.header, 'view', null), ['Scale: 80%', '# a note', '']);
	// a new option goes before the blank lines that end the header
	assert.deepEqual(setOption(['x: 1', ''], 'view', 'full'), ['x: 1', 'view: full', '']);
	assert.deepEqual(parseBlock('sgf: [[games/a b.sgf]]\ngame: 3').opts, { sgf: '[[games/a b.sgf]]', game: '3' });
});

test('options: only the game is ours; everything else in a block is kept', () => {
	// a second game, a remark in parentheses before the game, notes and stray option lines after it
	const src = 'caption: two games\n(Black to play and live)\n(;SZ[9];B[aa])\n(;SZ[9];B[bb]C[second])\ntrailing notes\nview: full';
	const b = parseBlock(src);
	assert.deepEqual(b.header, ['caption: two games']);
	assert.equal(b.games.length, 2);
	assert.equal(b.rest.slice(...b.games[0]), '(;SZ[9];B[aa])');
	const out = composeBlock(b.header, b.rest, '(;SZ[9];B[aa];W[cc])', b.games[0]);
	assert.equal(out, 'caption: two games\n(Black to play and live)\n(;SZ[9];B[aa];W[cc])\n(;SZ[9];B[bb]C[second])\ntrailing notes\nview: full');
	// a block with a remark but no game yet: the game is added after it
	const c = parseBlock('(c) 2001 Someone\nmore text');
	assert.equal(c.games.length, 0);
	assert.equal(composeBlock(c.header, c.rest, '(;SZ[9])', null), '(c) 2001 Someone\nmore text\n(;SZ[9])');
	assert.equal(parseBlock(composeBlock(c.header, c.rest, '(;SZ[9])', null)).games.length, 1);
});

test('options: scale, size, numbers', () => {
	assert.equal(parseScale('0.8'), 0.8);
	assert.equal(parseScale('80%'), 0.8);
	assert.equal(parseScale('150'), 1.5);
	assert.equal(parseScale('abc'), null);
	assert.equal(parseScale('0'), null);
	assert.deepEqual(parseSize('13'), [13, 13]);
	assert.deepEqual(parseSize('13x9'), [13, 9]);
	assert.equal(parseSize('1'), null);
	assert.deepEqual(parseNumbers('on'), { off: false, from: 1, to: null, start: null });
	assert.deepEqual(parseNumbers('off'), { off: true, from: 1, to: null, start: null });
	assert.deepEqual(parseNumbers('51-100'), { off: false, from: 51, to: 100, start: null });
	assert.deepEqual(parseNumbers('51-100 from 1'), { off: false, from: 51, to: 100, start: 1 });
	assert.deepEqual(parseNumbers('5- as 1'), { off: false, from: 5, to: null, start: 1 });
	assert.deepEqual(parseNumbers('-30'), { off: false, from: 1, to: 30, start: null });
	assert.deepEqual(parseNumbers('12'), { off: false, from: 12, to: null, start: null });
	assert.deepEqual(parseNumbers('on from 7'), { off: false, from: 1, to: null, start: 7 });
	assert.deepEqual(parseNumbers('from 7'), { off: false, from: 1, to: null, start: 7 });
	assert.equal(parseNumbers('banana'), null);
	assert.equal(parseNumbers(undefined), null);
});

test('options: views', () => {
	assert.equal(parseView('full', 19, 19), 'full');
	assert.equal(parseView('auto', 19, 19), 'auto');
	assert.deepEqual(parseView('top-right', 19, 19), { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.deepEqual(parseView('TR', 19, 19), { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.deepEqual(parseView('bottom left 8x6', 19, 19), { x0: 0, y0: 13, x1: 7, y1: 18 });
	assert.deepEqual(parseView('top 6', 19, 19), { x0: 0, y0: 0, x1: 18, y1: 5 });
	assert.deepEqual(parseView('top 11x6', 19, 19), { x0: 4, y0: 0, x1: 14, y1: 5 });
	assert.deepEqual(parseView('left', 19, 19), { x0: 0, y0: 0, x1: 9, y1: 18 });
	assert.deepEqual(parseView('right 7', 19, 19), { x0: 12, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(parseView('center', 19, 19), { x0: 4, y0: 4, x1: 14, y1: 14 });
	assert.deepEqual(parseView('center 5', 9, 9), { x0: 2, y0: 2, x1: 6, y1: 6 });
	assert.deepEqual(parseView('K10-T19', 19, 19), { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.deepEqual(parseView('t19:k10', 19, 19), { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.deepEqual(parseView('ja:sj', 19, 19), { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.equal(parseView('nonsense', 19, 19), null);
	assert.equal(parseView('I5-K9', 19, 19), null); // there is no I column
	assert.equal(formatRect({ x0: 9, y0: 0, x1: 18, y1: 9 }, 19, 19), 'K10-T19');
	assert.deepEqual(parseView(formatRect({ x0: 2, y0: 3, x1: 11, y1: 12 }, 19, 19), 19, 19), { x0: 2, y0: 3, x1: 11, y1: 12 });
	assert.deepEqual(parseView(formatRect({ x0: 2, y0: 3, x1: 30, y1: 12 }, 37, 37), 37, 37), { x0: 2, y0: 3, x1: 30, y1: 12 });
});

test('options: auto view', () => {
	const corner = parseSgf('(;SZ[19]AB[pb][qc][rc]AW[oc][pd][qd][rd];B[sb](;W[sc])(;W[qa]))')[0];
	assert.deepEqual(autoView(corner, 19, 19), { x0: 12, y0: 0, x1: 18, y1: 5 });
	assert.deepEqual(autoView(parseSgf('(;SZ[19])')[0], 19, 19), { x0: 0, y0: 0, x1: 18, y1: 18 });
	// a 9x9 with stones in the middle is shown whole
	assert.deepEqual(autoView(parseSgf('(;SZ[9]AB[ee]AW[dd])')[0], 9, 9), { x0: 0, y0: 0, x1: 8, y1: 8 });
	// middle of a side
	assert.deepEqual(autoView(parseSgf('(;SZ[19]AB[ha][ia]AW[hc][kc])')[0], 19, 19), { x0: 5, y0: 0, x1: 12, y1: 4 });
	// a label's text is not a second point...
	const plain = autoView(parseSgf('(;SZ[19]AB[qd])')[0], 19, 19);
	assert.deepEqual(autoView(parseSgf('(;SZ[19]AB[qd]LB[qd:ko])')[0], 19, 19), plain);
	// ...and a label on an empty point counts, whatever its text
	assert.deepEqual(autoView(parseSgf('(;SZ[19]AB[qd]LB[dq:12])')[0], 19, 19), { x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(autoView(parseSgf('(;SZ[19]AB[qd]LB[kd:12])')[0], 19, 19), { x0: 8, y0: 0, x1: 18, y1: 5 });
});

test('options: star points', () => {
	const key = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).sort().join(' ');
	assert.equal(starPoints(19, 19).length, 9);
	assert.equal(key(starPoints(13, 13)), '3,3 3,9 6,6 9,3 9,9');
	assert.equal(key(starPoints(9, 9)), '2,2 2,6 4,4 6,2 6,6');
	assert.equal(starPoints(5, 5).length, 0);
});

/* --------------------------------------------------------------- blocks */

const at = (lines: string[]) => findBlocks(lines, 'kifu');
const found = (r: Located) => (r.block ? r.block.open : r.why);
/** Rewrite the block that `place` and `raw` (or, failing those, the text alone) point at; or say why not. */
const rewrite = (text: string, oldBody: string, newBody: string, place: Place | null = null, raw: string | null = null, guess = true): string => {
	const r = locate(at(linesOf(text)), oldBody, place, raw, guess);
	return r.block ? replaceBody(text, r.block, newBody) : r.why;
};

test('blocks: find by content, with prefixes and nested fences', () => {
	const note = [
		'# Title',
		'',
		'````markdown',
		'```kifu',
		'not a real block',
		'```',
		'````',
		'',
		'```kifu',
		'view: auto',
		'(;SZ[9])',
		'```',
		'',
		'> [!note]',
		'> ```kifu',
		'> (;SZ[13])',
		'> ```',
		'',
		'- item',
		'  ~~~kifu extra',
		'  (;SZ[5])',
		'  ~~~',
		'inline ```kifu``` code',
		'```kifu',
		'```',
	];
	const blocks = at(note);
	assert.deepEqual(blocks.map((b) => [b.open, b.close, b.prefix, b.body]), [
		[8, 11, '', 'view: auto\n(;SZ[9])'],
		[14, 16, '> ', '(;SZ[13])'],
		[19, 21, '  ', '(;SZ[5])'],
		[23, 24, '', ''],
	]);
	assert.equal(found(locate(blocks, '(;SZ[13])\n', null, null, true)), 14);
	assert.equal(found(locate(blocks, 'nope', null, null, true)), 'missing');
	const out = rewrite(note.join('\n'), '(;SZ[13])', 'view: full\n\n(;SZ[13];B[aa])');
	assert.deepEqual(out.split('\n').slice(14, 19), ['> ```kifu', '> view: full', '>', '> (;SZ[13];B[aa])', '> ```']);
	// empty block gets a body, body can be emptied again
	const filled = rewrite(note.join('\n'), '', '(;SZ[19])');
	assert.deepEqual(filled.split('\n').slice(23), ['```kifu', '(;SZ[19])', '```']);
	assert.equal(rewrite(filled, '(;SZ[19])', ''), note.join('\n'));
	// which block it was comes back with it
	const r = locate(blocks, '(;SZ[5])', null, null, true);
	assert.deepEqual([r.block?.open, r.block && r.ord], [19, 2]);
});

test('blocks: a block is known by its place among the blocks, and identical ones are never guessed at', () => {
	const L = ['```kifu', '```', 'text', '```kifu', '```', 'more', '```kifu', '```'];
	const note = L.join('\n');
	// a board whose renderer puts it on lines 3-4 stands on the second of three
	assert.equal(blockOn(at(L), '', { lineStart: 3, lineEnd: 4 }), 1);
	assert.equal(rewrite(note, '', '(;SZ[9])', { ord: 1, total: 3 }), ['```kifu', '```', 'text', '```kifu', '(;SZ[9])', '```', 'more', '```kifu', '```'].join('\n'));
	assert.equal(rewrite(note, '', 'x', { ord: 2, total: 3 }).split('\n')[7], 'x');
	// text typed elsewhere moves the lines about, but not the order of the blocks
	const moved = ['one more line', '', ...L, '', 'and another'];
	assert.equal(blockOn(at(moved), '', { lineStart: 5, lineEnd: 6 }), 1);
	assert.equal(rewrite(moved.join('\n'), '', 'x', { ord: 1, total: 3 }).split('\n')[6], 'x');
	// an editor may name just one line of the block; a section may be bigger than the block
	assert.equal(blockOn(at(L), '', { lineStart: 7, lineEnd: 7 }), 2);
	assert.equal(blockOn(at(L), '', { lineStart: 5, lineEnd: 7 }), 2);
	// nothing known about which one: nothing is written
	assert.equal(rewrite(note, '', 'x'), 'ambiguous');
	// a board that stands on none of them: the block under it reads something else by now
	assert.equal(blockOn(at(L), '', { lineStart: 2, lineEnd: 2 }), -1);
	assert.equal(blockOn(at(L), 'X', { lineStart: 3, lineEnd: 4 }), -1);
	// two identical blocks inside one section (a callout): it holds both, and can not say which
	const callout = ['> [!example]', '> ```kifu', '> (;SZ[9]AB[cc])', '> ```', '> and again', '> ```kifu', '> (;SZ[9]AB[cc])', '> ```', '', 'end'];
	assert.equal(blockOn(at(callout), '(;SZ[9]AB[cc])', { lineStart: 0, lineEnd: 7 }), null);
	assert.equal(rewrite(callout.join('\n'), '(;SZ[9]AB[cc])', '(;SZ[9])'), 'ambiguous');
	// ...unless they read differently
	const mixed = callout.slice();
	mixed[6] = '> (;SZ[9]AB[dd])';
	assert.equal(blockOn(at(mixed), '(;SZ[9]AB[dd])', { lineStart: 0, lineEnd: 7 }), 1);
	// a single block that nothing is known about is found by its text, white space aside...
	assert.equal(rewrite('```kifu\n(;SZ[9]\n  ;B[aa])\n```', '(;SZ[9]\n;B[aa])', 'z'), '```kifu\nz\n```');
	// ...but not by one who has been told not to go by the text
	assert.equal(rewrite('```kifu\nX\n```', 'X', 'z', null, null, false), 'unsure');
	assert.equal(rewrite('```kifu\nY\n```', 'X', 'z', null, null, false), 'missing');
});

test('blocks: a text match alone is not proof that a block is ours', () => {
	const note = (...bodies: string[]) => bodies.flatMap((b) => ['```kifu', ...b.split('\n'), '```', 'between']).join('\n');
	// Two boards read the same; ours is the second. Then someone changes our block.
	// The one block that still reads the old text is the other board's, and stays untouched.
	const ours: Place = { ord: 1, total: 2 };
	assert.equal(rewrite(note('X', 'caption: mine\nX'), 'X', 'X2', ours, 'X'), 'missing');
	// a copy of the block is pasted in, or one is taken out: the count no longer fits
	assert.equal(rewrite(note('X', 'X', 'X'), 'X', 'X2', ours, 'X'), 'unsure');
	assert.equal(rewrite(note('X'), 'X', 'X2', ours, 'X'), 'unsure');
	// nothing changed: the second it is
	assert.equal(rewrite(note('X', 'X'), 'X', 'X2', ours, 'X'), note('X', 'X2'));
	// One block stops reading X and another starts to (X, Y becomes X+, X): as many as
	// before read X, and still the one that does now is not ours.
	const first: Place = { ord: 0, total: 2 };
	assert.equal(rewrite(note('X\nmore', 'X'), 'X', 'X2', first, 'X'), 'missing');
	// (going by the text alone would have written into it)
	assert.equal(rewrite(note('X\nmore', 'X'), 'X', 'X2'), note('X\nmore', 'X2'));
	// A change made by hand, be it one space, is not ours to overwrite...
	assert.equal(rewrite(note('C[Whiteplays]'), 'C[Whiteplays]', 'z', { ord: 0, total: 1 }, 'C[Whiteplays]'), note('z'));
	assert.equal(rewrite(note('C[White plays]'), 'C[Whiteplays]', 'z', { ord: 0, total: 1 }, 'C[Whiteplays]'), 'missing');
	// ...while a renderer that hands us the text with other white space than the note has does no harm
	assert.equal(rewrite(note('a\n\tb'), 'a\n  b', 'z', { ord: 0, total: 1 }, 'a\n\tb'), note('z'));
	assert.equal(rewrite(note('a\n\tb'), 'a\n  b', 'z', { ord: 0, total: 1 }), note('z'));
	// a single block, known to be the only one: found wherever it has moved to
	assert.equal(rewrite('more\ntext\n' + note('X'), 'X', 'Y', { ord: 0, total: 1 }, 'X'), 'more\ntext\n' + note('Y'));
	// notes that end their lines with CR LF are read like any other
	assert.deepEqual(at(linesOf(note('X', 'X').replace(/\n/g, '\r\n'))).map((b) => b.body), ['X', 'X']);
	assert.deepEqual(linesOf('a\r\nb\nc'), ['a', 'b', 'c']);
});

test('blocks: two that differ only in white space are look-alikes too', () => {
	// (the place decides, not the spelling)
	const ws = ['```kifu', 'size: 9', '```', '```kifu', 'size:9', '```'];
	assert.deepEqual(reading(at(ws), 'size: 9'), [0, 1]);
	assert.equal(blockOn(at(ws), 'size: 9', { lineStart: 3, lineEnd: 5 }), 1);
	assert.equal(rewrite(ws.join('\n'), 'size: 9', 'x'), 'ambiguous');
	assert.equal(rewrite(ws.join('\n'), 'size: 9', 'x', { ord: 0, total: 2 }).split('\n')[1], 'x');
	assert.equal(rewrite(ws.join('\n'), 'size: 9', 'x', { ord: 1, total: 2 }).split('\n')[4], 'x');
	// with the text as the note had it, each is only ever its own
	assert.equal(rewrite(ws.join('\n'), 'size: 9', 'x', { ord: 1, total: 2 }, 'size: 9'), 'missing');
	assert.equal(rewrite(ws.join('\n'), 'size: 9', 'x', { ord: 1, total: 2 }, 'size:9').split('\n')[4], 'x');
});

test('blocks: a place is carried along as the note changes, the way an editor carries a cursor', () => {
	const N = (...parts: string[]) => readNote(parts.join('\n'), 'kifu');
	const blk = (b: string) => '```kifu\n' + b + '\n```';
	const was = N('intro', blk('X'), 'one', blk('Y'), 'two', blk('X'), 'end');
	const second: Place = { ord: 1, total: 3 };
	// nothing changed
	assert.deepEqual(follow(was, second, N('intro', blk('X'), 'one', blk('Y'), 'two', blk('X'), 'end')), second);
	// text typed above, below or in between leaves it the second of three
	assert.deepEqual(follow(was, second, N('a new line', was.text)), second);
	assert.deepEqual(follow(was, second, N(was.text, 'more')), second);
	assert.deepEqual(follow(was, second, N('intro', blk('X'), 'one', 'and more', blk('Y'), 'two', blk('X'), 'end')), second);
	// a block added above makes it the third of four; one added below, the second of four
	assert.deepEqual(follow(was, second, N(blk('Q'), was.text)), { ord: 2, total: 4 });
	assert.deepEqual(follow(was, second, N(was.text, blk('Q'))), { ord: 1, total: 4 });
	// the block above is taken out: it is the first of two
	assert.deepEqual(follow(was, second, N('intro', 'one', blk('Y'), 'two', blk('X'), 'end')), { ord: 0, total: 2 });
	// another block is rewritten (that is what our own writes do): it stays where it is
	assert.deepEqual(follow(was, second, N('intro', blk('X\nmore'), 'one', blk('Y'), 'two', blk('X'), 'end')), second);
	assert.deepEqual(follow(was, { ord: 2, total: 3 }, N('intro', blk('X\nmore'), 'one', blk('Y'), 'two', blk('X'), 'end')), { ord: 2, total: 3 });
	// its own text is changed, or it is taken out: it can not be followed
	assert.equal(follow(was, second, N('intro', blk('X'), 'one', blk('Y2'), 'two', blk('X'), 'end')), null);
	assert.equal(follow(was, second, N('intro', blk('X'), 'one', 'two', blk('X'), 'end')), null);
	// Blocks trade places (the first is cut and pasted at the end): the count is the same,
	// and yet nothing that was known about the places of the others holds. That is said,
	// not papered over...
	const traded = N('intro', 'one', blk('Y'), 'two', blk('X'), 'end', blk('X'));
	assert.equal(follow(was, second, traded), null);
	assert.equal(follow(was, { ord: 0, total: 3 }, traded), null);
	assert.equal(follow(was, { ord: 2, total: 3 }, traded), null);
	// ...unless the move is seen as the two steps it is made of: first the cut, then the paste
	const cut = N('intro', 'one', blk('Y'), 'two', blk('X'), 'end');
	assert.deepEqual(follow(was, second, cut), { ord: 0, total: 2 });
	assert.deepEqual(follow(cut, { ord: 0, total: 2 }, traded), { ord: 0, total: 3 });
	assert.deepEqual(follow(cut, follow(was, { ord: 2, total: 3 }, cut) as Place, traded), { ord: 1, total: 3 });
	assert.equal(follow(was, { ord: 0, total: 3 }, cut), null);
	// Being the only block of its text does not make a block findable by that: here the
	// second stops reading Y while the first starts to, in one go.
	assert.equal(follow(was, second, N('intro', blk('Y'), 'one', blk('X'), 'two', blk('X'), 'end')), null);
	// One of two identical neighbours is taken out. Which? It reads the same either way,
	// so neither is followed...
	const twins = N(blk('T'), '', blk('T'), 'end');
	assert.equal(follow(twins, { ord: 0, total: 2 }, N(blk('T'), 'end')), null);
	assert.equal(follow(twins, { ord: 1, total: 2 }, N(blk('T'), 'end')), null);
	// ...while the one that is clearly still there is
	const apart = N(blk('T'), 'one', blk('T'), 'two', blk('T'), 'end');
	assert.deepEqual(follow(apart, { ord: 2, total: 3 }, N(blk('T'), 'one', 'two', blk('T'), 'end')), { ord: 1, total: 2 });
	assert.deepEqual(follow(apart, { ord: 0, total: 3 }, N(blk('T'), 'one', 'two', blk('T'), 'end')), { ord: 0, total: 2 });
	assert.equal(follow(apart, { ord: 1, total: 3 }, N(blk('T'), 'one', 'two', blk('T'), 'end')), null);
	// a place that never fitted the text it is said to be from is not followed anywhere
	assert.equal(follow(was, { ord: 1, total: 2 }, was), null);
	assert.equal(follow(was, { ord: 5, total: 3 }, was), null);
	// line ends do not matter
	assert.deepEqual(follow(was, second, readNote('first\r\n' + was.text.replace(/\n/g, '\r\n'), 'kifu')), second);
	// a fence that is opened above it and never closed changes what its lines mean
	assert.equal(follow(was, second, N('````text', was.text)), null);
	// (asked again about the same two texts, and then about others: the answers do not get mixed up)
	assert.deepEqual(follow(was, { ord: 2, total: 3 }, cut), { ord: 1, total: 2 });
	assert.deepEqual(follow(cut, { ord: 1, total: 2 }, was), { ord: 2, total: 3 });
	assert.deepEqual(follow(was, { ord: 2, total: 3 }, cut), { ord: 1, total: 2 });
});

test('blocks: two texts of a note are the same when only their line ends differ', () => {
	assert.equal(sameText('a\nb\n', 'a\nb\n'), true);
	assert.equal(sameText('a\r\nb\r\n', 'a\nb\n'), true);
	assert.equal(sameText('a\nb\n', 'a\r\nb\n'), true);
	assert.equal(sameText('a\nb\n', 'a\nb'), false);
	assert.equal(sameText('a\nb\n', 'a\nc\n'), false);
	assert.equal(sameText('a\r\nb', 'a\r\nc'), false);
	// (a lone return is not a line end)
	assert.equal(sameText('a\rb\n', 'a\nb\n'), false);
});

test('blocks: every other line of the note comes back byte for byte', () => {
	// a note with mixed line endings keeps each line's own ending
	const mixed = 'line1\nline2\r\n```kifu\n```\nlast\r\n';
	assert.equal(rewrite(mixed, '', '(;SZ[9])'), 'line1\nline2\r\n```kifu\n(;SZ[9])\n```\nlast\r\n');
	const crlf = 'a\r\n```kifu\r\nold\r\n```\r\nb';
	assert.equal(rewrite(crlf, 'old', 'new1\nnew2'), 'a\r\n```kifu\r\nnew1\r\nnew2\r\n```\r\nb');
	assert.equal(rewrite(crlf, 'old', 'new', { ord: 0, total: 1 }, 'old'), 'a\r\n```kifu\r\nnew\r\n```\r\nb');
});

test('blocks: fences in lists and quotes, as Markdown reads them', () => {
	// the fence sits on the list marker's own line; the body is indented to match
	const list = ['- ```kifu', '  (;SZ[9])', '  ```', '1. ```kifu', '   (;SZ[13])', '   ```', '> - ```kifu', '>   (;SZ[5])', '>   ```'];
	assert.deepEqual(at(list).map((b) => [b.open, b.close, b.prefix, b.body]), [
		[0, 2, '  ', '(;SZ[9])'],
		[3, 5, '   ', '(;SZ[13])'],
		[6, 8, '>   ', '(;SZ[5])'],
	]);
	assert.equal(rewrite(list.join('\n'), '(;SZ[13])', 'a\nb').split('\n').slice(3, 7).join('|'), '1. ```kifu|   a|   b|   ```');
	// a quote marker with no space after it; a body line that is itself indented keeps its indent
	const tight = ['>```kifu', '>(;SZ[9]', '>  ;B[aa])', '>```'];
	assert.deepEqual(at(tight)[0].body, '(;SZ[9]\n ;B[aa])');
	assert.equal(rewrite(tight.join('\n'), '(;SZ[9]\n ;B[aa])', 'X'), '>```kifu\n>X\n>```');
	// ...also when we write it: the marker takes one space, so a line with spaces of its own gets one more
	const spaced = rewrite(tight.join('\n'), '(;SZ[9]\n ;B[aa])', '(;C[a\n  two spaces\n\ttab])');
	assert.equal(spaced, '>```kifu\n>(;C[a\n>   two spaces\n> \ttab])\n>```');
	assert.equal(at(spaced.split('\n'))[0].body, '(;C[a\n  two spaces\n\ttab])');
	// an unclosed fence ends with its quote or list item; what follows is found normally
	const open = ['> ```js', '> never closed', '', '```kifu', 'A', '```', '- ```text', '  also open', 'back at the margin', '```kifu', 'B', '```'];
	assert.deepEqual(at(open).map((b) => b.body), ['A', 'B']);
	// a block whose own closing fence is missing is left alone
	assert.equal(found(locate(at(['text', '```kifu', '(;SZ[9])']), '(;SZ[9])', null, null, true)), 'missing');
	// only spaces and tabs indent a closing fence: a no-break space does not close the block
	assert.deepEqual(at(['```kifu', '\u00a0```', '```']).map((b) => b.body), ['\u00a0```']);
});

/* ----------------------------------------------------------------- tree */

test('tree layout: main line straight down, variations to the right', () => {
	const [root] = parseSgf('(;SZ[9];B[aa](;W[bb];B[cc](;W[dd])(;W[ee]))(;W[ff];B[gg];W[hh])(;W[ii]))');
	const L = layoutTree(root);
	const pos = (n: any) => { const v = L.at.get(n)!; return [v % STRIDE, Math.floor(v / STRIDE)]; };
	const b1 = root.children[0];
	const [w1, w2, w3] = b1.children;
	assert.deepEqual(pos(root), [0, 0]);
	assert.deepEqual(pos(b1), [0, 1]);
	assert.deepEqual(pos(w1), [0, 2]);
	assert.deepEqual(pos(w1.children[0]), [0, 3]);
	assert.deepEqual(pos(w1.children[0].children[0]), [0, 4]);
	assert.deepEqual(pos(w1.children[0].children[1]), [1, 4]); // deepest variation sits closest
	assert.deepEqual(pos(w2), [2, 2]); // must clear column 1 at row 4
	assert.deepEqual(pos(w2.children[0].children[0]), [2, 4]);
	assert.deepEqual(pos(w3), [3, 2]);
	assert.equal(L.cols, 4);
	assert.equal(L.rows, 5);
	assert.equal(L.count, 10);
	// no two nodes share a cell
	assert.equal(L.cells.size, L.count);
});

test('tree layout: one line of play on its own', () => {
	const [root] = parseSgf('(;SZ[9];B[aa](;W[bb];B[cc])(;W[dd]))');
	const line = [root, root.children[0], root.children[0].children[1]];
	const L = layoutLine(line);
	assert.deepEqual([L.cols, L.rows, L.count], [1, 3, 3]);
	assert.deepEqual(line.map((n) => L.at.get(n)), [0, STRIDE, 2 * STRIDE]);
	assert.equal(L.cells.get(2 * STRIDE), line[2]);
	assert.equal(L.at.has(root.children[0].children[0]), false);
});
