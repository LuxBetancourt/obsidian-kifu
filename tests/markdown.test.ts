// The code that finds a block in a note and rewrites it, checked against a real
// CommonMark parser on thousands of generated notes: blocks at the top level, in
// callouts and quotes, in lists, with comments that look like Markdown themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { Place, alike, blockOn, findBlocks, linesOf, locate, normalize, replaceBody } from '../src/blocks';
import { escapeText } from '../src/sgf';

interface Code {
	open: number;
	close: number;
	body: string;
}

/** The kifu blocks of a note as CommonMark reads it. */
function parsed(text: string): Code[] {
	const out: Code[] = [];
	const walk = (n: any): void => {
		if (n.type === 'code' && typeof n.lang === 'string' && n.lang.toLowerCase() === 'kifu') {
			out.push({ open: n.position.start.line - 1, close: n.position.end.line - 1, body: n.value });
		}
		for (const c of n.children ?? []) walk(c);
	};
	walk(fromMarkdown(text));
	return out;
}

let seed = 987654321;
const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

const comment = (t: string): string => `(;SZ[9]AB[cc]C[${escapeText(t)}];B[dd])`;
const BODIES = [
	'',
	'(;SZ[9])',
	'(;SZ[9]AB[cc])',
	'view: auto\n(;SZ[9]AB[cc])',
	'sgf: [[x.sgf]]',
	'(;SZ[19]\n(;B[aa])\n(;B[bb]))',
	comment('first\n\nsecond paragraph'),
	comment('  indented line\n\tand a tab'),
	comment('> quoted\n- list\n# heading\n1. one'),
	comment('```\nfence\n~~~'),
	comment('trailing space \nnext'),
	comment('   ```js'),
	comment('a\n\n\nb'),
];
const PLACES: { name: string; head: string[]; prefix: string }[] = [
	{ name: 'top level', head: [], prefix: '' },
	{ name: 'callout, "> "', head: ['> [!note] title'], prefix: '> ' },
	{ name: 'callout, ">"', head: ['>[!note] title'], prefix: '>' },
	{ name: 'quote in a quote', head: ['> > deep'], prefix: '> > ' },
	{ name: 'list item, 2 spaces', head: ['- item'], prefix: '  ' },
	{ name: 'list item, tab', head: ['- item'], prefix: '\t' },
	{ name: 'list item, 4 spaces', head: ['- item'], prefix: '    ' },
	{ name: 'numbered item', head: ['1. item'], prefix: '   ' },
	{ name: 'nested list', head: ['- a', '  - b'], prefix: '    ' },
	{ name: 'list in a quote', head: ['> - item'], prefix: '>   ' },
	{ name: 'indented two spaces', head: [], prefix: '  ' },
];

test('finding and rewriting blocks agrees with a CommonMark parser', () => {
	const seen = new Map<string, number>();
	for (let iter = 0; iter < 6000; iter++) {
		const lines: string[] = ['# Note', ''];
		const places: string[] = [];
		const count = 1 + Math.floor(rnd() * 3);
		for (let b = 0; b < count; b++) {
			const place = pick(PLACES);
			const body = pick(BODIES);
			const fence = pick(['```', '```', '````', '~~~']);
			lines.push(...place.head, place.prefix + fence + 'kifu');
			for (const l of body ? body.split('\n') : []) {
				// (a tab straight after ">" is half marker, half text, and reads back as spaces:
				// we never write that, and it has a test of its own below)
				const gap = place.prefix.endsWith('>') && l[0] === '\t' ? ' ' : '';
				lines.push(l ? place.prefix + gap + l : place.prefix.replace(/\s+$/, ''));
			}
			lines.push(place.prefix + fence, '', 'Some text between.', '');
			places.push(place.name);
		}
		const text = lines.join(rnd() < 0.2 ? '\r\n' : '\n');
		const plain = text.replace(/\r\n/g, '\n');
		const before = parsed(plain);
		// (the generator can produce something CommonMark reads otherwise, a fence inside a comment say: not this test's business)
		if (before.length !== count) continue;

		// 1. we see the same blocks, on the same lines, with the same text
		const ours = findBlocks(plain.split('\n'), 'kifu');
		assert.deepEqual(
			ours.map((b) => [b.open, b.close, normalize(b.body)]),
			before.map((b) => [b.open, b.close, normalize(b.body)]),
			JSON.stringify(text),
		);

		// 2. rewriting one of them changes that one and nothing else
		const k = Math.floor(rnd() * count);
		const target = before[k];
		const next = pick(BODIES);
		// what a board on that block would know: where its renderer puts it (and what the note
		// held there), its place alone, or nothing
		const r = rnd();
		const noteBlocks = findBlocks(linesOf(text), 'kifu');
		const twins = before.filter((b) => alike(b.body, target.body)).length > 1;
		let place: Place | null = null;
		let raw: string | null = null;
		if (r < 0.7) {
			const ord = blockOn(noteBlocks, target.body, { lineStart: target.open, lineEnd: target.close });
			assert.equal(ord, k, JSON.stringify({ text, k }));
			place = { ord: k, total: noteBlocks.length };
			if (r < 0.4) raw = noteBlocks[k].body;
		}
		const where = locate(noteBlocks, target.body, place, raw, true);
		if (!place && twins) {
			assert.equal(where.block === null && where.why, 'ambiguous', JSON.stringify(text));
			continue;
		}
		const res = { text: where.block ? replaceBody(text, where.block, next) : null };
		assert.notEqual(res.text, null, 'not found in ' + JSON.stringify(text));
		const out = res.text as string;
		const after = parsed(out.replace(/\r\n/g, '\n'));
		const context = JSON.stringify({ text, next, out });
		assert.equal(after.length, before.length, context);
		for (let i = 0; i < before.length; i++) {
			assert.equal(normalize(after[i].body), normalize(i === k ? next : before[i].body), `block ${i} of ` + context);
		}
		// every line outside the block comes back byte for byte
		const a = text.split('\n');
		const b = out.split('\n');
		const tail = a.length - 1 - target.close;
		assert.deepEqual(b.slice(0, target.open + 1), a.slice(0, target.open + 1), context);
		assert.deepEqual(b.slice(b.length - 1 - tail), a.slice(target.close), context);
		seen.set(places[k], (seen.get(places[k]) ?? 0) + 1);
	}
	// every kind of place was really exercised
	for (const p of PLACES) assert.ok((seen.get(p.name) ?? 0) > 150, `${p.name}: ${seen.get(p.name) ?? 0}`);
});

test('a tab straight after a quote marker: found by its text all the same', () => {
	// CommonMark counts part of that tab as the marker's own space, so a parser hands back
	// two spaces where the note has a tab. The block is still found, and rewritten in place.
	const note = ['>```kifu', '>(;SZ[9]C[a', '>\tb])', '>```'].join('\n');
	assert.deepEqual(parsed(note).map((b) => b.body), ['(;SZ[9]C[a\n  b])']);
	const where = locate(findBlocks(linesOf(note), 'kifu'), '(;SZ[9]C[a\n  b])', null, null, true);
	assert.notEqual(where.block, null);
	const out = where.block ? replaceBody(note, where.block, '(;SZ[9]C[a\n\tb]AB[cc])') : '';
	assert.equal(out, ['>```kifu', '>(;SZ[9]C[a', '> \tb]AB[cc])', '>```'].join('\n'));
	// what we wrote reads back with its tab
	assert.deepEqual(parsed(out).map((b) => b.body), ['(;SZ[9]C[a\n\tb]AB[cc])']);
});
