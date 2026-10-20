import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanComment, fetchJoseki, josekiTarget } from '../src/josekipedia';
import { ImportError } from '../src/importing';
import { getText, parseSgf } from '../src/sgf';

test('Josekipedia links, and the moves alone', () => {
	assert.deepEqual(josekiTarget('https://www.josekipedia.com/#path:pdqfnc'), { path: ['pd', 'qf', 'nc'], url: 'https://www.josekipedia.com/#path:pdqfnc' });
	assert.deepEqual(josekiTarget('http://josekipedia.com/#path:pd')?.path, ['pd']);
	assert.deepEqual(josekiTarget('https://www.josekipedia.com/#path:')?.path, []); // the empty board
	assert.deepEqual(josekiTarget('pdqf')?.path, ['pd', 'qf']);
	assert.deepEqual(josekiTarget('path:pdqf')?.path, ['pd', 'qf']);
	assert.equal(josekiTarget('https://www.josekipedia.com/#path:pdq'), null); // half a move
	assert.equal(josekiTarget('https://www.josekipedia.com/info/tech.php'), null);
	assert.equal(josekiTarget('https://example.com/#path:pdqf'), null);
	assert.equal(josekiTarget('hello'), null);
});

test('Josekipedia comments: HTML entities, and UTF-8 that was read as Windows-1252', () => {
	assert.equal(cleanComment('It is called &#39;Hoshi&#39; &amp; &quot;star&quot;.'), 'It is called \'Hoshi\' & "star".');
	assert.equal(cleanComment('Invading at 3â€“3 under a 4â€“4 stone'), 'Invading at 3–3 under a 4–4 stone');
	assert.equal(cleanComment('cafÃ©'), 'café');
	assert.equal(cleanComment('  Ève à côté  '), 'Ève à côté'); // (proper text is left alone)
});

const NODES: Record<number, unknown> = {
	1: { _id: 1, C: '', _children: [{ _id: 39, B: 'qd', C: 'Komoku' }, { _id: 40, B: 'pd', C: 'Star point &#39;Hoshi&#39;' }] },
	40: { _id: 40, B: 'pd', C: 'Star point', _children: [{ _id: 42, W: 'qf', C: 'The approach' }, { _id: 453, W: 'qc', C: '3â€“3 invasion' }] },
	42: { _id: 42, W: 'qf', C: 'The approach', _children: [{ _id: 50, B: 'nc', C: 'Kosumi-like' }, { _id: 51, B: 'pf', C: '' }] },
};
const fake = (log: number[]) => async (id: number) => {
	log.push(id);
	return NODES[id] ? { status: 200, text: JSON.stringify(NODES[id]) } : { status: 200, text: `no node ${id}` };
};

test('a Josekipedia position: the line with its comments, then what may follow as variations', async () => {
	const log: number[] = [];
	const t = josekiTarget('https://www.josekipedia.com/#path:pdqf')!;
	const got = await fetchJoseki(t, fake(log));
	assert.deepEqual(log, [1, 40, 42]); // a request a move, and one for what follows
	assert.equal(got.moves, 2);
	assert.equal(got.about, '2 moves');
	const root = parseSgf(got.sgf)[0];
	assert.equal(getText(root, 'SO'), 'https://www.josekipedia.com/#path:pdqf');
	const b = root.children[0];
	assert.deepEqual(b.props.B, ['pd']);
	assert.equal(getText(b, 'C'), 'Star point \'Hoshi\'');
	const w = b.children[0];
	assert.deepEqual(w.props.W, ['qf']);
	assert.equal(getText(w, 'C'), 'The approach');
	assert.deepEqual(w.children.map((k) => k.props.B[0]), ['nc', 'pf']);
	assert.equal(getText(w.children[0], 'C'), 'Kosumi-like');
	assert.equal(w.children[1].props.C, undefined);
});

test('a Josekipedia position that is not there, and a site that answers wrong', async () => {
	const fails = async (path: string, get: (id: number) => Promise<{ status: number; text: string }>, msg: RegExp) =>
		assert.rejects(fetchJoseki(josekiTarget(path)!, get), (e) => e instanceof ImportError && msg.test(e.message));
	await fails('pdaa', fake([]), /no such position/);
	await fails('pd', async () => ({ status: 500, text: '' }), /answered 500/);
	await fails('pd', async () => ({ status: 200, text: '<html>' }), /sent no position/);
});
