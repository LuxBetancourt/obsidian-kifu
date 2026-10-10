import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError, problemId, problemUrl, readProblem, tidyProblem } from '../src/goproblems';
import { getText, parseSgf } from '../src/sgf';
import { nodeMark } from '../src/session';

// Made up, in the manner of goproblems.com files: repeated property names, placeholder
// players, and correct lines marked by RIGHT at the end of a comment, run on or not.
const SGF = '(;AW[pe]AW[pf]AB[pg]AB[ph]C[black to live]SZ[19]PW[White]PB[Black]GN[White (W) vs. Black (B)]' +
	'(;B[sh](;W[sj];B[qf]C[RIGHT])(;W[rg];B[sj]C[snapbackRIGHT]))' +
	'(;B[rg];W[qf]C[black has nothing now])' +
	'(;B[qf]BM[1];W[rg]C[not RIGHT here: only at either end]))';

test('the problem number in what was typed', () => {
	assert.equal(problemId('5'), 5);
	assert.equal(problemId(' #1234 '), 1234);
	assert.equal(problemId('https://www.goproblems.com/problems/5'), 5);
	assert.equal(problemId('goproblems.com/problems/25000?tab=comments'), 25000);
	assert.equal(problemId('https://goproblems.com/en/problems/77'), 77);
	assert.equal(problemId('https://www.goproblems.com/prob.php?id=42'), 42);
	assert.equal(problemId(''), null);
	assert.equal(problemId('zero'), null);
	assert.equal(problemId('0'), null);
	assert.equal(problemId('https://example.com/problems/5'), null);
	assert.equal(problemUrl(5), 'https://www.goproblems.com/problems/5');
});

test('a goproblems.com SGF tidied for a note', () => {
	const root = parseSgf(tidyProblem(SGF, 5))[0];
	assert.deepEqual(root.props.AW, ['pe', 'pf']); // repeated names: every stone kept
	assert.deepEqual(root.props.AB, ['pg', 'ph']);
	assert.equal(getText(root, 'C'), 'black to live');
	assert.equal(root.props.PB, undefined); // placeholders gone
	assert.equal(root.props.PW, undefined);
	assert.equal(getText(root, 'GN'), 'goproblems.com #5');
	assert.equal(getText(root, 'SO'), 'https://www.goproblems.com/problems/5');
	const [a, b] = root.children[0].children;
	// "RIGHT" alone: the comment goes, the move is marked correct
	assert.equal(a.children[0].props.C, undefined);
	assert.deepEqual(a.children[0].props.TE, ['1']);
	// run on: the word before it stays
	assert.equal(getText(b.children[0], 'C'), 'snapback');
	assert.deepEqual(b.children[0].props.TE, ['1']);
	// no marker: left alone
	assert.equal(getText(root.children[1].children[0], 'C'), 'black has nothing now');
	assert.equal(root.children[1].children[0].props.TE, undefined);
	// "RIGHT" in the middle of a comment is just a word
	assert.equal(root.children[2].children[0].props.TE, undefined);
	assert.equal(getText(root.children[2].children[0], 'C'), 'not RIGHT here: only at either end');
	// a player's real name is kept
	assert.equal(getText(parseSgf(tidyProblem('(;PB[Cho Chikun]PW[White];B[aa])', 1))[0], 'PB'), 'Cho Chikun');
});

test('a run-on RIGHT reads as correct even untidied (an SGF file from the site, say)', () => {
	assert.equal(nodeMark(parseSgf('(;B[aa]C[snapbackRIGHT])')[0].children[0] ?? parseSgf('(;B[aa]C[snapbackRIGHT])')[0]), 'correct');
	assert.equal(nodeMark(parseSgf('(;B[aa]C[RIGHT])')[0]), 'correct');
	assert.equal(nodeMark(parseSgf('(;B[aa]C[a bright idea])')[0]), null);
});

test('what the API answered', () => {
	const ok = readProblem(5, 200, () => ({ sgf: SGF, genre: 'life and death', rank: { value: 14, unit: 'kyu' }, author: { name: 'adum' } }), false);
	assert.match(ok.sgf, /^\(;/);
	assert.equal(ok.about, 'Life and death, 14 kyu, by adum');
	assert.equal(readProblem(5, 200, () => ({ sgf: SGF }), false).about, '');
	const fails = (status: number, json: () => unknown, withKey: boolean, msg: RegExp) =>
		assert.throws(() => readProblem(7, status, json, withKey), (e) => e instanceof ImportError && msg.test(e.message));
	fails(404, () => ({}), false, /has no problem 7/);
	fails(403, () => ({}), false, /not public\. An API token/);
	fails(401, () => ({}), true, /refused the API token/);
	fails(500, () => ({}), false, /answered 500/);
	fails(200, () => { throw new Error('not JSON'); }, false, /without its SGF/);
	fails(200, () => ({ sgf: '' }), false, /without its SGF/);
});
