import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { senseisDiagramUrl, senseisDiagrams, senseisPage, senseisTarget, senseisTitle, tidySenseisSgf } from '../src/senseis';
import { ImportError } from '../src/importing';
import { getText, parseSgf } from '../src/sgf';

// a page as the site served it on 2026-10-30 (Latin-1, eight diagrams). (The tests run
// from a build directory: the fixture is found from the working directory, the project.)
const LADDER = readFileSync(resolve('tests/fixtures/senseis-ladder.html'), 'latin1');

test("Sensei's Library links, with the diagram wanted after a #", () => {
	assert.deepEqual(senseisTarget('https://senseis.xmp.net/?Ladder'), { page: 'Ladder', diagram: 1, url: 'https://senseis.xmp.net/?Ladder' });
	assert.deepEqual(senseisTarget('https://senseis.xmp.net/?Ladder#3')?.diagram, 3);
	assert.deepEqual(senseisTarget('http://www.senseis.xmp.net/?ChineseFuseki')?.page, 'ChineseFuseki');
	// the import prompt takes the page's name alone
	assert.deepEqual(senseisTarget('Ladder#2'), { page: 'Ladder', diagram: 2, url: 'https://senseis.xmp.net/?Ladder' });
	assert.equal(senseisTarget('Ladder')?.diagram, 1);
	// not pages: the site's editing and searching queries, other sites, a diagram file (an SGF link, handled as one)
	assert.equal(senseisTarget('https://senseis.xmp.net/?edit=Ladder'), null);
	assert.equal(senseisTarget('https://senseis.xmp.net/?search=ladder'), null);
	assert.equal(senseisTarget('https://senseis.xmp.net/?Ladder#0'), null);
	assert.equal(senseisTarget('https://senseis.xmp.net/diagrams/1/7b9ae89a223049f1956169bd3d567766.sgf'), null);
	assert.equal(senseisTarget('https://example.com/?Ladder'), null);
	assert.equal(senseisTarget('a page name with spaces'), null);
	assert.equal(senseisPage(senseisTarget('Ladder#3')!), 'https://senseis.xmp.net/?Ladder#3');
	assert.equal(senseisPage(senseisTarget('Ladder')!), 'https://senseis.xmp.net/?Ladder');
});

test("a page's diagrams, in order, each once; and its title", () => {
	const files = senseisDiagrams(LADDER);
	assert.equal(files.length, 8);
	assert.equal(files[0], 'https://senseis.xmp.net/diagrams/1/7b9ae89a223049f1956169bd3d567766.sgf');
	assert.equal(files[2], 'https://senseis.xmp.net/diagrams/18/d2790091125b320e0d0ed1100f4c9e42.sgf');
	assert.equal(new Set(files).size, 8); // (the picture of each diagram links the same file: counted once)
	assert.equal(senseisTitle(LADDER), 'Ladder');
	assert.equal(senseisTitle('<title>Chinese Fuseki at Sensei&#039;s Library</title>'), 'Chinese Fuseki');
	assert.equal(senseisTitle('<title>nothing here</title>'), '');
});

test('which diagram a link asks for, and what the page has not got', () => {
	const t = senseisTarget('Ladder#3')!;
	assert.equal(senseisDiagramUrl(t, 200, LADDER), 'https://senseis.xmp.net/diagrams/18/d2790091125b320e0d0ed1100f4c9e42.sgf');
	const fails = (target: string, status: number, html: string, msg: RegExp) =>
		assert.throws(() => senseisDiagramUrl(senseisTarget(target)!, status, html), (e) => e instanceof ImportError && msg.test(e.message));
	fails('Ladder#9', 200, LADDER, /has 8 diagrams, not 9/);
	fails('Ladder', 200, '<html><title>Ladder at Sensei\'s Library</title></html>', /has no diagram/);
	fails('NoSuchPage', 404, '', /no page NoSuchPage/);
	fails('Ladder', 500, '', /answered 500/);
});

test("a diagram's SGF, tidied: the caption alone, the page as the source, no move-number comments", () => {
	const raw = '(;GM[1]FF[4]SZ[19]\nGN[Ladder]\nPC[http://senseis.xmp.net/?Ladder]AP[GoWiki:2009]\nC[Diagram from http://senseis.xmp.net/?Ladder\n\nLadder]\nPL[B]\nAB[ed][ce]AW[dd][ee]CR[dd]\n;B[dc]C[B1]MN[1]\n;W[cc]C[W2]MN[2]\n;CR[dd]\n)';
	const root = parseSgf(tidySenseisSgf(raw, 'https://senseis.xmp.net/?Ladder#2'))[0];
	assert.equal(getText(root, 'C'), 'Ladder');
	assert.equal(getText(root, 'SO'), 'https://senseis.xmp.net/?Ladder#2');
	assert.equal(getText(root, 'GN'), 'Ladder');
	assert.deepEqual(root.props.CR, ['dd']); // (marks kept)
	const b1 = root.children[0];
	assert.deepEqual(b1.props.B, ['dc']);
	assert.equal(b1.props.C, undefined); // ("B1": gone)
	assert.deepEqual(b1.props.MN, ['1']); // (the number stays, as the site wrote it)
	assert.equal(b1.children[0].props.C, undefined);
	// a comment that is not a move number stays
	const kept = parseSgf(tidySenseisSgf('(;SZ[9]C[Diagram from http://x\n\nThe shape];B[aa]C[The key point])', 'p'))[0];
	assert.equal(getText(kept, 'C'), 'The shape');
	assert.equal(getText(kept.children[0], 'C'), 'The key point');
	assert.throws(() => tidySenseisSgf('<html>', 'p'), (e) => e instanceof ImportError);
});
