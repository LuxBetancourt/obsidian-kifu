import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ogsApi, ogsPage, ogsTarget, puzzleToSgf, readOgsGame, readOgsPuzzle, tidyGame } from '../src/ogs';
import { ImportError } from '../src/importing';
import { getText, parseSgf } from '../src/sgf';

test('what was typed: links say what they are, numbers take the kind chosen', () => {
	assert.deepEqual(ogsTarget('https://online-go.com/game/12345', 'puzzle'), { kind: 'game', id: 12345 });
	assert.deepEqual(ogsTarget('online-go.com/game/view/77', 'puzzle'), { kind: 'game', id: 77 });
	assert.deepEqual(ogsTarget('https://online-go.com/review/1000000', 'game'), { kind: 'review', id: 1000000 });
	assert.deepEqual(ogsTarget('https://online-go.com/demo/5', 'game'), { kind: 'review', id: 5 });
	assert.deepEqual(ogsTarget('https://online-go.com/puzzle/2?x=1', 'game'), { kind: 'puzzle', id: 2 });
	assert.deepEqual(ogsTarget(' 42 ', 'puzzle'), { kind: 'puzzle', id: 42 });
	assert.deepEqual(ogsTarget('#42', 'game'), { kind: 'game', id: 42 });
	assert.equal(ogsTarget('0', 'game'), null);
	assert.equal(ogsTarget('a game', 'game'), null);
	assert.equal(ogsTarget('https://example.com/game/5', 'game'), null);
	assert.equal(ogsPage({ kind: 'puzzle', id: 2 }), 'https://online-go.com/puzzle/2');
	assert.equal(ogsApi({ kind: 'game', id: 1 }), 'https://online-go.com/api/v1/games/1/sgf');
	assert.equal(ogsApi({ kind: 'review', id: 3 }), 'https://online-go.com/api/v1/reviews/3/sgf');
	assert.equal(ogsApi({ kind: 'puzzle', id: 2 }), 'https://online-go.com/api/v1/puzzles/2');
});

// Made up, in the manner of OGS: every move a variation one deeper, and chat it could not write.
const GAME = '(;FF[4] CA[UTF-8] GM[1] PC[OGS: https://online-go.com/game/9] PB[alice] PW[bob] BR[7k] WR[?] RE[W+R] SZ[9] ' +
	'C[alice: [object Object\\]\nbob: good game\nalice: [object Object\\]] ;B[ee] (;W[cc] (;B[gg] (;W[cg]C[bob: [object Object\\]]))))';

test('a game as OGS writes it, tidied', () => {
	const sgf = tidyGame(GAME, { kind: 'game', id: 9 });
	const root = parseSgf(sgf)[0];
	// the moves are a plain sequence
	let n = root;
	const moves: string[] = [];
	while (n.children.length === 1) {
		n = n.children[0];
		moves.push((n.props.B ? 'B' : 'W') + (n.props.B ?? n.props.W)[0]);
	}
	assert.deepEqual(moves, ['Bee', 'Wcc', 'Bgg', 'Wcg']);
	assert.ok(!sgf.includes('(;W'), sgf); // no needless variations left
	// the chat OGS could not write is gone, the rest stays
	assert.equal(getText(root, 'C'), 'bob: good game');
	assert.equal(n.props.C, undefined);
	assert.equal(getText(root, 'SO'), 'https://online-go.com/game/9');
	const f = readOgsGame({ kind: 'game', id: 9 }, 200, GAME);
	assert.equal(f.about, 'alice (7k) vs bob, W+R');
});

test('a puzzle turned into SGF: setup, turns, verdicts, comments, marks, the main line first', () => {
	const puzzle = {
		width: 9, height: 9, initial_player: 'white', puzzle_type: 'life_and_death',
		puzzle_description: '**White** to live',
		initial_state: { black: 'aabb', white: 'cc' },
		move_tree: {
			x: -1, y: -1,
			marks: [{ x: 3, y: 3, marks: { triangle: true } }],
			trunk_next: { x: 4, y: 4, text: 'the main line', branches: [{ x: 5, y: 5, correct_answer: true }] },
			branches: [
				{ x: 0, y: 8, branches: [{ x: 1, y: 8, wrong_answer: true, text: 'dead', marks: [{ x: 2, y: 8, marks: { letter: 'A', cross: true } }] }] },
			],
		},
	};
	const root = parseSgf(puzzleToSgf(puzzle, { kind: 'puzzle', id: 2 }, 'Life and death 1'))[0];
	assert.deepEqual(root.props.SZ, ['9']);
	assert.deepEqual(root.props.AB, ['aa', 'bb']);
	assert.deepEqual(root.props.AW, ['cc']);
	assert.deepEqual(root.props.PL, ['W']);
	assert.equal(getText(root, 'C'), 'White to live'); // (Markdown bold made plain)
	assert.equal(getText(root, 'GN'), 'Life and death 1');
	assert.equal(getText(root, 'SO'), 'https://online-go.com/puzzle/2');
	assert.deepEqual(root.props.TR, ['dd']);
	const [main, side] = root.children;
	assert.deepEqual(main.props.W, ['ee']); // white moves first; the trunk is the first line
	assert.equal(getText(main, 'C'), 'the main line');
	assert.deepEqual(main.children[0].props.B, ['ff']);
	assert.deepEqual(main.children[0].props.TE, ['1']);
	assert.deepEqual(side.props.W, ['ai']);
	const end = side.children[0];
	assert.deepEqual(end.props.B, ['bi']);
	assert.deepEqual(end.props.BM, ['1']);
	assert.equal(getText(end, 'C'), 'dead');
	assert.deepEqual(end.props.LB, ['ci:A']);
	assert.deepEqual(end.props.MA, ['ci']);
	// a board that is not square
	assert.deepEqual(parseSgf(puzzleToSgf({ width: 13, height: 9, move_tree: {} }, { kind: 'puzzle', id: 1 }, ''))[0].props.SZ, ['13:9']);
	// what is said about it
	const f = readOgsPuzzle({ kind: 'puzzle', id: 2 }, 200, () => ({ name: 'Life and death 1', owner: { username: 'someone' }, puzzle }));
	assert.equal(f.about, 'Life and death 1, Life and death, by someone');
});

test('what OGS answered when it went wrong', () => {
	const fails = (f: () => unknown, msg: RegExp) => assert.throws(f, (e) => e instanceof ImportError && msg.test(e.message));
	fails(() => readOgsGame({ kind: 'game', id: 5 }, 404, 'detail'), /OGS has no game 5, or it is not public/);
	fails(() => readOgsGame({ kind: 'review', id: 1 }, 500, 'Error: TypeError'), /OGS answered 500 for review 1/);
	fails(() => readOgsGame({ kind: 'game', id: 5 }, 200, 'not a game'), /no game for game 5/);
	fails(() => readOgsPuzzle({ kind: 'puzzle', id: 3 }, 404, () => ({ error: 'Puzzle not found or inaccessible' })), /OGS has no puzzle 3/);
	fails(() => readOgsPuzzle({ kind: 'puzzle', id: 3 }, 200, () => { throw new Error('not JSON'); }), /no puzzle for puzzle 3/);
	fails(() => readOgsPuzzle({ kind: 'puzzle', id: 3 }, 200, () => ({ id: 3 })), /no puzzle for puzzle 3/);
});
