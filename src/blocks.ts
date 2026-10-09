/**
 * Finding one of our code blocks inside the text of a note, and rewriting its body.
 *
 * A block is known by its place among the note's blocks of our language (the third of
 * five, say) in the note as it read at a certain moment, and by its text. As the note
 * changes, the place is carried along the way an editor carries a cursor: what stands
 * before the change stays where it is, what stands after it moves with the text. An
 * edit is written only where place and text both still fit; whenever that can not be
 * established, we stop rather than guess.
 */

export interface FoundBlock {
	/** Line of the opening fence and of the closing fence. */
	open: number;
	close: number;
	/** What goes in front of each body line: indentation, or "> " inside a callout. */
	prefix: string;
	body: string;
}

export interface LineRange {
	lineStart: number;
	lineEnd: number;
}

/**
 * Where a block stands in its note: number `ord` (counting from 0) of the `total`
 * blocks of our language. Unlike a line number this stays true while text is typed
 * elsewhere, and unlike a block's text it tells blocks apart that read the same.
 */
export interface Place {
	ord: number;
	total: number;
}

/**
 * Why a block was not found: it is not there (any more) as we knew it; several read
 * the same and nothing says which is meant; or the note has changed in a way that
 * leaves it uncertain which block is ours.
 */
export type Missing = 'missing' | 'ambiguous' | 'unsure';
export type Located = { block: FoundBlock; ord: number } | { block: null; why: Missing };

/** The lines of a note, whichever way it ends them. */
export const linesOf = (text: string): string[] => text.split(/\r?\n/);

const MARKER = /[-*+]|\d{1,9}[.)]/g;
/** An opening fence, possibly inside quotes and list items ("> ```", "- ```", "   ```"). */
const FENCE = /^((?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))*[ \t]*)(`{3,}|~{3,})(.*)$/;

/** Remove a container prefix from a line the way a Markdown parser does. */
function stripPrefix(line: string, prefix: string): string {
	let i = 0;
	for (let k = 0; k < prefix.length; k++) {
		const p = prefix[k];
		if (p === '>') {
			while (line[i] === ' ') i++;
			if (line[i] !== '>') break;
			i++;
			// a quote marker takes one following space with it, whether or not the fence line had one
			if (line[i] === ' ') i++;
			if (prefix[k + 1] === ' ') k++;
		} else if (line[i] === ' ' || line[i] === '\t') {
			i++;
		}
		// (indentation that is missing is simply not there to remove)
	}
	return line.slice(i);
}

const quotes = (s: string): number => (s.match(/>/g) ?? []).length;

/** Has the quote or list item a fence sits in ended at this line? (That closes the fence too.) */
function containerEnded(line: string, prefix: string): boolean {
	if (!prefix) return false;
	const depth = quotes(prefix);
	if (depth) return quotes(/^[ \t>]*/.exec(line)?.[0] ?? '') < depth;
	if (!line.trim()) return false;
	return (/^[ \t]*/.exec(line)?.[0].length ?? 0) < prefix.length;
}

/** Compare block bodies the way the renderer hands them to us. */
export function normalize(body: string): string {
	return body.replace(/\r/g, '').replace(/\n+$/, '');
}

/** Compare block bodies ignoring every difference in white space. */
export function squash(body: string): string {
	return body.replace(/\s+/g, '');
}

/**
 * All fenced blocks of the given language, in order. Blocks without a closing fence are
 * left out. Where Markdown's finer points are concerned this errs on the side of finding
 * too many (a fence inside an indented code block or an HTML comment counts too): places
 * are only ever compared with places found the same way, so one block too many changes
 * nothing, while a block that was missed would leave its board with nowhere to save to.
 */
export function findBlocks(lines: string[], lang: string): FoundBlock[] {
	const out: FoundBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const m = FENCE.exec(lines[i]);
		// (a backtick fence can not have another backtick on its line: that is inline code)
		if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
			i++;
			continue;
		}
		// lines after the first have spaces where the first has its list marker
		const prefix = m[1].replace(MARKER, (s) => ' '.repeat(s.length));
		const fence = m[2];
		const info = m[3].trim().split(/\s+/)[0] ?? '';
		const ch = fence[0];
		let j = i + 1;
		let close = -1;
		for (; j < lines.length; j++) {
			if (containerEnded(lines[j], prefix)) break;
			// closing fence: same character, at least as long, nothing after it
			// (only spaces and tabs are indentation; a no-break space is not)
			const t = stripPrefix(lines[j], prefix).replace(/^[ \t]+|[ \t]+$/g, '');
			if (t.length >= fence.length && t[0] === ch && t === ch.repeat(t.length)) {
				close = j;
				break;
			}
		}
		if (close < 0) {
			// never closed: it ran to the end of its quote or list item (carry on after that),
			// or to the end of the note
			i = j;
			continue;
		}
		if (info.toLowerCase() === lang) {
			const body = lines.slice(i + 1, close).map((l) => stripPrefix(l, prefix));
			out.push({ open: i, close, prefix, body: body.join('\n') });
		}
		i = close + 1;
	}
	return out;
}

/** A note's text with its lines and our blocks found: worked out once per text. */
export interface Note {
	text: string;
	lines: string[];
	blocks: FoundBlock[];
}

const recent: (Note & { lang: string })[] = [];

/** Read a note. (The last few texts are remembered: the same one is asked about again and again.) */
export function readNote(text: string, lang: string): Note {
	for (const n of recent) if (n.lang === lang && n.text === text) return n;
	const lines = linesOf(text);
	const note = { text, lines, blocks: findBlocks(lines, lang), lang };
	recent.unshift(note);
	if (recent.length > 6) recent.pop();
	return note;
}

/**
 * How many lines two texts share at the start and at the end. Where lines repeat, the
 * two counts can lay claim to the same lines: `head` says which side gets them.
 */
function shared(a: string[], b: string[], head: boolean): [number, number] {
	// (the same two texts are asked about for every board of a note, one way and the
	// other: counted once)
	if (!counted || !((counted.a === a && counted.b === b) || (counted.a === b && counted.b === a))) {
		const n = Math.min(a.length, b.length);
		let pre = 0;
		while (pre < n && a[pre] === b[pre]) pre++;
		let post = 0;
		while (post < n && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
		counted = { a, b, n, pre, post };
	}
	const { n, pre, post } = counted;
	return head ? [pre, Math.min(post, n - pre)] : [Math.min(pre, n - post), post];
}
let counted: { a: string[]; b: string[]; n: number; pre: number; post: number } | null = null;

/**
 * A block stood at `place` when its note read `was`. Where does it stand in the note
 * as it reads `now`? The lines the two texts share at the start are the same lines,
 * and so are those they share at the end; what lies between is what changed. A block
 * wholly in the shared start is where it was; one wholly in the shared end has moved
 * by as many lines as the note grew. A block the change touches can not be followed,
 * nor one that could be followed two ways (one of two identical neighbours was taken
 * out: which?). Then the answer is null. This is how a hand edit that adds, removes or
 * moves blocks is told from one that leaves ours alone.
 *
 * (The block's text is no help here, even where it is the only one of its kind before
 * and after: one block may have stopped reading that while another started to.)
 *
 * The two texts should be one step apart, or as near to that as can be had: seen as a
 * single change, a block that is cut out above ours and pasted in below it has
 * touched everything in between.
 */
export function follow(was: Note, place: Place, now: Note): Place | null {
	const b = was.blocks[place.ord] as FoundBlock | undefined;
	if (!b || was.blocks.length !== place.total) return null;
	if (was.text === now.text) return place;
	const lineOf = (head: boolean): number => {
		const [pre, post] = shared(was.lines, now.lines, head);
		if (b.close < pre) return b.open;
		if (b.open >= was.lines.length - post) return b.open + now.lines.length - was.lines.length;
		return -1;
	};
	const open = lineOf(true);
	if (open < 0 || lineOf(false) !== open) return null;
	const ord = now.blocks.findIndex((x) => x.open === open);
	const n = now.blocks[ord] as FoundBlock | undefined;
	// (the same lines, read the same way; if not, what surrounds them has changed their meaning)
	if (!n || n.close - n.open !== b.close - b.open || n.body !== b.body) return null;
	return { ord, total: now.blocks.length };
}

/** Are two texts of a note the same, line ends aside? (An editor hands a note back with line ends of its own.) */
export function sameText(a: string, b: string): boolean {
	if (a === b) return true;
	if (!a.includes('\r') && !b.includes('\r')) return false;
	return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** Do two block bodies read the same, white space aside? */
export const alike = (a: string, b: string): boolean => squash(a) === squash(b);

/**
 * The numbers of the blocks that read `body`. White space does not count: a renderer
 * may hand us a block's text with its tabs or trailing blanks changed, and two blocks
 * that differ in nothing else are best treated as the look-alikes they are.
 */
export function reading(blocks: FoundBlock[], body: string): number[] {
	const want = squash(body);
	const out: number[] = [];
	blocks.forEach((b, i) => {
		if (squash(b.body) === want) out.push(i);
	});
	return out;
}

/**
 * Which block does a board stand on, when its renderer puts it on the lines `range`
 * and it was drawn from `body`? The block's number; -1 if no block on those lines
 * reads that (the drawing is out of date); null if several there do (a callout that
 * holds look-alikes: there is no telling them apart from here).
 */
export function blockOn(blocks: FoundBlock[], body: string, range: LineRange): number | null {
	const want = squash(body);
	let hit = -1;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		// (a section is at least as big as the block in it; an editor may only name one of its lines)
		if (b.open > range.lineEnd || b.close < range.lineStart || squash(b.body) !== want) continue;
		if (hit >= 0) return null;
		hit = i;
	}
	return hit;
}

/**
 * Pick the block an edit goes to. `place` is where the block is known to stand and
 * `raw` its text as the note last had it, letter for letter: the block there must
 * still read exactly that. (Should a block further down happen to read the same, it
 * is not thereby ours; and a change made by hand, be it one space, is not ours to
 * overwrite.) Without a place, `guess` allows taking the only block that reads `body`.
 */
export function locate(blocks: FoundBlock[], body: string, place: Place | null, raw: string | null, guess: boolean): Located {
	const no = (why: Missing): Located => ({ block: null, why });
	if (place) {
		const b = blocks[place.ord];
		// (blocks have come or gone: ours may be one of those that went)
		if (blocks.length !== place.total || !b) return no(reading(blocks, body).length ? 'unsure' : 'missing');
		const same = raw === null ? alike(b.body, body) : normalize(b.body) === normalize(raw);
		return same ? { block: b, ord: place.ord } : no('missing');
	}
	const hits = reading(blocks, body);
	if (!hits.length) return no('missing');
	if (!guess) return no('unsure');
	if (hits.length > 1) return no('ambiguous');
	const b = blocks[hits[0]];
	if (raw !== null && normalize(b.body) !== normalize(raw)) return no('missing');
	return { block: b, ord: hits[0] };
}

/** The lines to put between the fences of `block` for a new body. */
export function bodyLines(block: FoundBlock, body: string): string[] {
	if (!body) return [];
	const prefix = block.prefix;
	// Straight after a quote marker one space (or part of a tab) belongs to the marker:
	// a line that begins with white space of its own gets a space to give away.
	const tight = prefix.endsWith('>');
	return body.split('\n').map((l) => (l ? prefix + (tight && (l[0] === ' ' || l[0] === '\t') ? ' ' : '') + l : prefix.replace(/\s+$/, '')));
}

/**
 * Replace the body of `block` (found in the lines of this very text) in the text of a
 * whole note. Every other line comes back byte for byte, line endings included.
 */
export function replaceBody(text: string, block: FoundBlock, newBody: string): string {
	const raw = text.split('\n');
	const cr = raw[block.open].endsWith('\r') ? '\r' : '';
	raw.splice(block.open + 1, block.close - block.open - 1, ...bodyLines(block, newBody).map((l) => l + cr));
	return raw.join('\n');
}
