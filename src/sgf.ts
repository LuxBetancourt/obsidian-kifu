/**
 * A small, forgiving SGF reader and writer.
 *
 * Property values are kept exactly as they appear in the file (still escaped), so
 * anything this plugin does not understand survives a round trip untouched.
 */

export interface SgfNode {
	parent: SgfNode | null;
	children: SgfNode[];
	props: Record<string, string[]>;
	/** Scratch node: exists only while a position is being played out. Never written. */
	temp?: boolean;
}

export const BLACK = 1;
export const WHITE = 2;
export type Color = 1 | 2;

export interface Move {
	color: Color;
	x: number;
	y: number;
	pass: boolean;
}

export function newNode(parent: SgfNode | null, props: Record<string, string[]> = {}): SgfNode {
	return { parent, children: [], props };
}

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/** Parse SGF text into its game trees (a file may hold a whole collection). */
export function parseSgf(text: string): SgfNode[] {
	const roots: SgfNode[] = [];
	const stack: (SgfNode | null)[] = [];
	let cur: SgfNode | null = null;
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (c === 40 /* ( */) {
			stack.push(cur);
			i++;
		} else if (c === 41 /* ) */) {
			cur = stack.pop() ?? null;
			i++;
		} else if (c === 59 /* ; */) {
			i++;
			if (!stack.length) continue; // stray text outside any game
			const node = newNode(cur);
			if (cur) cur.children.push(node);
			else roots.push(node);
			cur = node;
		} else if (c >= 65 && c <= 90 && stack.length) {
			// Property identifier. Old files spell names out ("AddBlack"): only capitals count.
			let id = '';
			for (; i < n; i++) {
				const d = text.charCodeAt(i);
				if (d >= 65 && d <= 90) id += text[i];
				else if (d < 97 || d > 122) break;
			}
			while (i < n && isWs(text.charCodeAt(i))) i++;
			if (text.charCodeAt(i) !== 91 /* [ */) continue;
			if (!cur) {
				// "(GM[1]..." without the leading semicolon
				cur = newNode(null);
				roots.push(cur);
			}
			const vals = (cur.props[id] ??= []);
			while (text.charCodeAt(i) === 91) {
				let j = i + 1;
				for (;;) {
					const k = text.indexOf(']', j);
					if (k < 0) {
						j = n;
						break;
					}
					let slashes = 0;
					for (let q = k - 1; q > i && text.charCodeAt(q) === 92; q--) slashes++;
					j = k;
					if (slashes % 2 === 0) break;
					j = k + 1;
				}
				vals.push(text.slice(i + 1, j));
				i = j + 1;
				while (i < n && isWs(text.charCodeAt(i))) i++;
			}
		} else {
			i++;
		}
	}
	return roots;
}

/** Walk from an opening parenthesis to the one that closes it, stepping over property values. -1: it never closes. */
function closing(text: string, from: number): number {
	const n = text.length;
	let depth = 0;
	for (let i = from; i < n; i++) {
		const c = text.charCodeAt(i);
		if (c === 91 /* [ */) {
			for (i++; i < n; i++) {
				const d = text.charCodeAt(i);
				if (d === 92) i++;
				else if (d === 93) break;
			}
		} else if (c === 40) {
			depth++;
		} else if (c === 41 && --depth === 0) {
			return i;
		}
	}
	return -1;
}

/**
 * The games in a text, as [start, end) offsets: every "(;" and what it holds, up
 * to the parenthesis that closes it. Anything else in the text (a copyright line,
 * a remark, even one with a stray parenthesis in it) is not a game and is left
 * alone. A last game that is never closed runs to the end of the text.
 */
export function findGames(text: string): [number, number][] {
	const out: [number, number][] = [];
	const start = /\(\s*;/g;
	for (;;) {
		const m = start.exec(text);
		if (!m) break;
		const end = closing(text, m.index);
		if (end < 0) {
			out.push([m.index, text.length]);
			break;
		}
		out.push([m.index, end + 1]);
		start.lastIndex = end + 1;
	}
	return out;
}

/** Is this game closed properly? (A file may have been cut short; then it is best not written to.) */
export function isClosed(game: string): boolean {
	const t = game.replace(/\s+$/, '');
	return closing(t, 0) === t.length - 1;
}

/** Write a game tree. Scratch nodes are left out. */
export function serializeSgf(root: SgfNode): string {
	const out: string[] = ['('];
	let col = 1;
	const walk = (first: SgfNode): void => {
		let node = first;
		for (;;) {
			let s = ';';
			for (const id in node.props) {
				const vals = node.props[id];
				if (!vals.length) continue;
				s += id;
				for (const v of vals) s += '[' + v + ']';
			}
			if (col > 1 && col + s.length > 78) {
				out.push('\n');
				col = 0;
			}
			out.push(s);
			const nl = s.lastIndexOf('\n');
			col = nl < 0 ? col + s.length : s.length - nl - 1;
			const kids = node.children.filter((k) => !k.temp);
			if (kids.length === 1) {
				node = kids[0];
				continue;
			}
			for (const k of kids) {
				out.push('\n(');
				col = 1;
				walk(k);
				out.push(')');
				col++;
			}
			return;
		}
	};
	walk(root);
	out.push(')');
	return out.join('');
}

/** Turn a raw property value into plain text. */
export function unescapeText(v: string): string {
	if (v.indexOf('\\') < 0) return v;
	return v.replace(/\\(\r\n|\n\r|[\s\S])/g, (_m, c: string) => (c === '\n' || c === '\r' || c.length === 2 ? '' : c));
}

/**
 * Turn plain text into a raw property value. A line that would start with a
 * code fence gets a (harmless) escape so it can never close a Markdown code block.
 */
export function escapeText(s: string): string {
	return s
		.replace(/\r\n?/g, '\n')
		.replace(/[\\\]]/g, '\\$&')
		.replace(/(^|\n)([ \t]*)(`{3}|~{3})/g, '$1$2\\$3');
}

export function getText(node: SgfNode, id: string): string {
	const v = node.props[id];
	return v && v.length ? unescapeText(v[0]) : '';
}

export function setText(node: SgfNode, id: string, text: string): void {
	if (text) node.props[id] = [escapeText(text)];
	else delete node.props[id];
}

/** a–z are 0–25, A–Z are 26–51. */
export function coord(c: number): number {
	if (c >= 97 && c <= 122) return c - 97;
	if (c >= 65 && c <= 90) return c - 39;
	return -1;
}

export function xy2pt(x: number, y: number): string {
	const ch = (v: number) => String.fromCharCode(v < 26 ? 97 + v : 39 + v);
	return ch(x) + ch(y);
}

/** Expand a point list, including compressed rectangles such as "aa:cc". */
export function points(vals: string[] | undefined): string[] {
	if (!vals) return [];
	const out: string[] = [];
	for (const v of vals) {
		if (v.length >= 5 && v[2] === ':') {
			const x0 = coord(v.charCodeAt(0));
			const y0 = coord(v.charCodeAt(1));
			const x1 = coord(v.charCodeAt(3));
			const y1 = coord(v.charCodeAt(4));
			if (x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0) continue;
			for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
				for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push(xy2pt(x, y));
			}
		} else if (v.length >= 2) {
			out.push(v.slice(0, 2));
		}
	}
	return out;
}

/** The move played in a node, if any. Off-board points (such as "tt") are passes. */
export function getMove(node: SgfNode, w = 19, h = 19): Move | null {
	let v = node.props.B;
	let color: Color = BLACK;
	if (!v) {
		v = node.props.W;
		color = WHITE;
	}
	if (!v) return null;
	const s = v[0] ?? '';
	const x = s.length >= 2 ? coord(s.charCodeAt(0)) : -1;
	const y = s.length >= 2 ? coord(s.charCodeAt(1)) : -1;
	if (x < 0 || y < 0 || x >= w || y >= h) return { color, x: -1, y: -1, pass: true };
	return { color, x, y, pass: false };
}

export function boardSize(root: SgfNode): [number, number] {
	const m = /^\s*(\d+)\s*(?::\s*(\d+))?/.exec(root.props.SZ?.[0] ?? '');
	if (!m) return [19, 19];
	const clamp = (v: number) => Math.max(2, Math.min(52, v || 19));
	const w = clamp(parseInt(m[1]));
	return [w, m[2] ? clamp(parseInt(m[2])) : w];
}

/** Nodes from the root down to (and including) the given node. */
export function pathTo(node: SgfNode): SgfNode[] {
	const path: SgfNode[] = [];
	for (let n: SgfNode | null = node; n; n = n.parent) path.push(n);
	return path.reverse();
}

/** Child indexes leading from the root to a node; survives a re-parse of the same tree. */
export function pathIndexes(node: SgfNode): number[] {
	const idx: number[] = [];
	for (let n = node; n.parent; n = n.parent) idx.push(n.parent.children.indexOf(n));
	return idx.reverse();
}

export function followIndexes(root: SgfNode, idx: number[]): SgfNode {
	let n = root;
	for (const i of idx) {
		const next = n.children[i];
		if (!next) break;
		n = next;
	}
	return n;
}

/** Visit every node of a tree without recursion (game records can be very deep). */
export function eachNode(root: SgfNode, fn: (n: SgfNode) => void): void {
	const stack: SgfNode[] = [root];
	while (stack.length) {
		const n = stack.pop() as SgfNode;
		fn(n);
		for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
	}
}
