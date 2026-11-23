import { test } from 'node:test';
import assert from 'node:assert/strict';
import { territoryScoring } from '../src/goscorer';
import { chainAt, deadFromMarks, guessDead, relatedStones, territoryMap } from '../src/territory';

/* Boards as rows: "." empty, "x" black, "o" white, "b" and "w" black and white stones marked dead. */
function board(rows: string): { w: number; h: number; grid: Uint8Array; dead: Uint8Array } {
	const r = rows.split('\n').map((s) => s.trim()).filter((s) => s);
	const h = r.length;
	const w = r[0].length;
	const grid = new Uint8Array(w * h);
	const dead = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const c = r[y][x];
			grid[y * w + x] = c === 'x' || c === 'b' ? 1 : c === 'o' || c === 'w' ? 2 : 0;
			dead[y * w + x] = c === 'b' || c === 'w' ? 1 : 0;
		}
	}
	return { w, h, grid, dead };
}
const rowsOf = (s: string): string[] => s.split('\n').map((r) => r.trim()).filter((r) => r);

/*
 * Some of goscorer's own test positions (github.com/lightvector/goscorer, MIT), each with the
 * territory its JavaScript version gives ("z" black's, "a" white's): the port must agree. (It was
 * checked against the original on all of goscorer's 97 test positions and thousands of random
 * boards when it was made; these keep it so.)
 */
const CASES: [string, string, string][] = [
	[
		'basic',
		`
		......x..
		.xx.x.x..
		......x..
		......x..
		oooooox..
		.....oxxx
		.....o.o.
		...o.o..o
		.....o...
		`,
		`
		......xzz
		.xx.x.xzz
		......xzz
		......xzz
		ooooooxzz
		aaaaaoxxx
		aaaaao.o.
		aaaoao..o
		aaaaao...
		`,
	],
	[
		'dead_stone_marking',
		`
		..w...xw.
		.xx.x.x.w
		......xxx
		......x.o
		oooooox..
		o.o.xoxxx
		oboxxo.o.
		ob.o.o..o
		.ooooo.b.
		`,
		`
		..w...xzz
		.xx.x.xzz
		......xxx
		......x.o
		oooooox..
		oao.xoxxx
		oaoxxo.o.
		oaao.o..o
		aooooo.b.
		`,
	],
	[
		'false_eyes',
		`
		.........
		xxxx.xx..
		.oxoxox..
		o.oo.ox..
		..oooox.x
		...o.x.x.
		....ooxox
		...o.o.ox
		.....ooo.
		`,
		`
		zzzzzzzzz
		xxxx.xxzz
		.oxoxoxzz
		oaoo.oxzz
		aaooooxzx
		aaao.x.x.
		aaaaooxox
		aaaoao.ox
		aaaaaooo.
		`,
	],
	[
		'basic_sekis',
		`
		.x.o.........x.x.
		ox.o..xwx..xx..oo
		ox.o.o.xx.x..ooo.
		ox.o..ooo..xxo.ox
		.x.o.b.......oxx.
		`,
		`
		.x.o.........x.x.
		ox.o..xwx..xx..oo
		ox.o.o.xx.x..ooo.
		ox.o..ooo..xxo.ox
		.x.o.b.......oxx.
		`,
	],
	[
		'basic_sekis_marked_dead',
		`
		.x.o.........x.x.
		wx.o..xox..xx..oo
		wx.o.o.xx.x..ooo.
		wx.o..ooo..xxo.ob
		.x.o.x.......obb.
		`,
		`
		.x.o.........x.x.
		wx.o..xox..xx..oo
		wx.o.o.xx.x..oooa
		wx.o..ooo..xxoaoa
		.x.o.x.......oaaa
		`,
	],
	[
		'more_fancy_sekis',
		`
		.ox.xoo....ox.xo.
		o.xwwxo.o..ox.x.o
		xxxxxxo..o.ooxxxx
		ooooooo.o...ooooo
		xxx..............
		oox..........xxxx
		.ox.....x...xxooo
		ooxxxxx..x..xo.o.
		.xoooox.x.x.xooxx
		x.o.box.....xo.o.
		`,
		`
		.ox.xoo....ox.xo.
		o.xwwxo.o..ox.x.o
		xxxxxxo..o.ooxxxx
		ooooooo.o...ooooo
		xxx..............
		oox..........xxxx
		.ox.....x...xxooo
		ooxxxxx..x..xo.o.
		.xoooox.x.x.xooxx
		x.o.box.....xo.o.
		`,
	],
	[
		'double_ko_death',
		`
		.o.o.........o.o.
		xx.o.........o.xx
		.xxo.o.....o.oxx.
		xoxxo.......oxxwx
		o.oxo.......oxw.w
		`,
		`
		.o.oaaaaaaaaao.o.
		xx.oaaaaaaaaao.xx
		.xxoaoaaaaaoaoxxz
		xoxxoaaaaaaaoxxzx
		o.oxoaaaaaaaoxzzz
		`,
	],
	[
		'hanezeki',
		`
		oxox.oxw.boxo
		oxoxoxxxoboxo
		oxoxox.xoboxo
		.xooox.xooox.
		xxoxxx.xxxoxx
		ooox.....xooo
		xxxx.....xxxx
		`,
		`
		oxox.oxw.boxo
		oxoxoxxxoboxo
		oxoxoxzxoboxo
		.xoooxzxooox.
		xxoxxxzxxxoxx
		oooxzzzzzxooo
		xxxxzzzzzxxxx
		`,
	],
	[
		'big_eye_seki',
		`
		.xoxxx
		xxoox.
		.xxooo
		ooxxx.
		.oooxx
		xxxo.x
		`,
		`
		.xoxxx
		xxoox.
		.xxooo
		ooxxx.
		.oooxx
		xxxo.x
		`,
	],
	[
		'bamboo_interleave_seki',
		`
		.xxxxxx.ox..
		xo..x.x.ox..
		xooooxooox..
		xx..xx.o.x..
		x.oo..oo.x..
		xxooxxoo.x..
		x.o.oo.o.x..
		ooooxxoo.x..
		xxxxxxxxx...
		`,
		`
		.xxxxxx.oxzz
		xo..x.x.oxzz
		xooooxoooxzz
		xx..xx.o.xzz
		x.oo..oo.xzz
		xxooxxoo.xzz
		x.o.oo.o.xzz
		ooooxxoo.xzz
		xxxxxxxxxzzz
		`,
	],
	[
		'three_point_false_eye',
		`
		........o....
		xoooox..o....
		xo.oox..o....
		xoo.oxoo.....
		.xoox.x.o....
		..xx..x.o....
		`,
		`
		........oaaaa
		xoooox..oaaaa
		xoaoox..oaaaa
		xooaoxooaaaaa
		.xoox.x.oaaaa
		..xx..x.oaaaa
		`,
	],
	[
		'various_corner_eyes',
		`
		...xo.......xox..x
		...xo.......xox...
		...xo.......xox...
		xxxxo.......xoxxxx
		oooox.......xooooo
		..oox.......xo....
		...ox.......xo....
		...ox.......xo....
		`,
		`
		zzzxo.......xoxzzx
		zzzxo.......xoxzzz
		zzzxo.......xoxzzz
		xxxxo.......xoxxxx
		oooox.......xooooo
		aaoox.......xoaaaa
		aaaox.......xoaaaa
		aaaox.......xoaaaa
		`,
	],
	[
		'narrow_board1',
		`
		.x.x.o.
		`,
		`
		.x.x.o.
		`,
	],
	[
		'narrow_board12',
		`
		.o
		o.
		xo
		x.
		.x
		wx
		`,
		`
		.o
		o.
		xo
		x.
		.x
		wx
		`,
	],
];

test('goscorer, ported: territory with seki, false eyes and dead stones as the original gives it', () => {
	for (const [name, position, want] of CASES) {
		const { w, h, grid, dead } = board(position);
		const t = territoryScoring(grid, dead, w, h).territory;
		const rows = rowsOf(position);
		const got = rows.map((r, y) => [...r].map((c, x) => (t[y * w + x] === 1 ? 'z' : t[y * w + x] === 2 ? 'a' : c)).join(''));
		assert.deepEqual(got, rowsOf(want), name);
	}
});

// Black's wall down the fourth column, white's down the sixth, nothing between; a white stone
// stranded in black's area and a black one in white's.
const WALLS = `
	...x.o...
	.o.x.o...
	...x.o...
	...x.o...
	...x.o...
	...x.o...
	...x.o.x.
	...x.o...
	...x.o...
`;

test('the guess: stones stranded in the other side\'s area are dead, the walls live, and the same board gets the same answer', () => {
	const { w, h, grid } = board(WALLS);
	const dead = guessDead(grid, w, h);
	const deadAt = [...dead.keys()].filter((i) => dead[i]);
	assert.deepEqual(deadAt, [1 * 9 + 1, 6 * 9 + 7]);
	assert.deepEqual(guessDead(grid, w, h), dead);
	// (an empty board: nothing to guess)
	assert.equal(guessDead(new Uint8Array(81), 9, 9).some((v) => v), false);
});

test('territory: each side\'s area, the dead stones in it, nothing in between; marks say back which stones are dead', () => {
	const { w, h, grid } = board(WALLS);
	const dead = guessDead(grid, w, h);
	const map = territoryMap(grid, dead, w, h);
	const show = rowsOf(WALLS).map((r, y) => [...r].map((c, x) => (map[y * w + x] === 1 ? 'z' : map[y * w + x] === 2 ? 'a' : c)).join(''));
	assert.deepEqual(show, ['zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa', 'zzzx.oaaa']);
	// the dead stones are on the other side's territory, so the marks say which they are
	assert.deepEqual(deadFromMarks(grid, map), dead);
});

test('territory: what runs out of the part of the board shown counts for nobody, and nothing while one colour has no living stones', () => {
	const { w, h, grid } = board(WALLS);
	const dead = guessDead(grid, w, h);
	// shown: the left half only; white's area runs off it, black's stays inside
	const map = territoryMap(grid, dead, w, h, { x0: 0, y0: 0, x1: 4, y1: 8 });
	assert.equal(map[0], 1);
	assert.equal(map[8], 0);
	assert.equal(map[6 * 9 + 7], 2, 'a dead stone stays dead'); // (black's stone in white's area: white's)
	// black stones alone: no territory, however enclosed
	const alone = board(`
		.x.
		x.x
		.x.
	`);
	assert.equal(territoryMap(alone.grid, new Uint8Array(9), 3, 3).some((v) => v), false);
});

test('what a click makes dead or alive: the stones a stone reaches through empty points, or its chain alone', () => {
	const { w, h, grid } = board(`
		.o.x.
		.o.x.
		...x.
		.o.x.
		...x.
	`);
	assert.deepEqual(relatedStones(grid, 1, w, h), [1, 6, 16]);
	assert.deepEqual(chainAt(grid, 1, w, h).sort((a, b) => a - b), [1, 6]);
	assert.deepEqual(relatedStones(grid, 0, w, h), []);
});
