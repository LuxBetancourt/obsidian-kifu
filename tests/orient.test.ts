import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromShown, orientModel, rollOrient, shownColor, shownSize, swapWords, toShown } from '../src/orient';
import type { Model } from '../src/session';

test('every turn and mirror can be undone, and covers the board', () => {
	for (const [w, h] of [[19, 19], [9, 9], [13, 9]]) {
		for (let t = 0; t < (w === h ? 8 : 4); t++) {
			const o = { t, swap: false };
			const [sw, sh] = shownSize(o, w, h);
			const seen = new Set<number>();
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const [a, b] = toShown(o, x, y, w, h);
					assert.ok(a >= 0 && b >= 0 && a < sw && b < sh, `t=${t} ${w}x${h}`);
					seen.add(b * sw + a);
					assert.deepEqual(fromShown(o, a, b, w, h), [x, y]);
				}
			}
			assert.equal(seen.size, w * h); // no two points land on one
		}
	}
	// the eight are all different on a square board
	const pictures = new Set<string>();
	for (let t = 0; t < 8; t++) pictures.add(JSON.stringify([toShown({ t, swap: false }, 1, 0, 9, 9), toShown({ t, swap: false }, 0, 2, 9, 9)]));
	assert.equal(pictures.size, 8);
});

test('a board that is not square is never turned on its side', () => {
	for (let i = 0; i < 50; i++) {
		const v = i / 50;
		assert.ok(rollOrient(13, 9, () => v).t < 4);
	}
	// a square one can be; and the colours are swapped about half the time
	const seq = [0.99, 0.2];
	const o = rollOrient(9, 9, () => seq.shift() as number);
	assert.deepEqual(o, { t: 7, swap: true });
});

test('swapped colours: stones and the words for them', () => {
	const o = { t: 0, swap: true };
	assert.equal(shownColor(o, 1), 2);
	assert.equal(shownColor(o, 2), 1);
	assert.equal(shownColor(o, 0), 0);
	assert.equal(shownColor(null, 1), 1);
	assert.equal(swapWords(o, 'Black to play. White lives; black dies. WHITE, Blackwood.'), 'White to play. Black lives; white dies. BLACK, Blackwood.');
	assert.equal(swapWords({ t: 3, swap: false }, 'Black to play'), 'Black to play');
});

test('a picture turned and recoloured', () => {
	// 3 x 2: a black stone in the top left corner, a white one beside it, a label and the latest move
	const grid = new Uint8Array(6);
	grid[0] = 1;
	grid[1] = 2;
	const m: Model = {
		w: 3, h: 2,
		view: { x0: 0, y0: 0, x1: 1, y1: 0 },
		crop: null,
		grid,
		labels: new Map([[1, '2']]),
		marks: new Map([[0, 'TR']]),
		last: 1,
		notes: [],
		toPlay: 1,
		status: null,
		hint: 'Black to play',
		text: 'White is dead.',
	};
	const o = { t: 3, swap: true }; // mirrored both ways: turned half round
	const r = orientModel(m, o);
	assert.equal(r.w, 3);
	assert.equal(r.h, 2);
	assert.equal(r.grid[5], 2); // the black corner stone, now white, bottom right
	assert.equal(r.grid[4], 1);
	assert.equal(r.labels.get(4), '2');
	assert.equal(r.marks.get(5), 'TR');
	assert.equal(r.last, 4);
	assert.deepEqual(r.view, { x0: 1, y0: 1, x1: 2, y1: 1 });
	assert.equal(r.toPlay, 2);
	assert.equal(r.hint, 'White to play');
	assert.equal(r.text, 'Black is dead.');
	// turned on its side: the size changes with it
	const side = orientModel({ ...m, w: 3, h: 2 }, { t: 4, swap: false });
	assert.equal(side.w, 2);
	assert.equal(side.h, 3);
	assert.equal(side.grid[1 * 2 + 0], 2); // (x 1, y 0) is shown at (0, 1)
});
