/** The text of a board block: option lines, then (optionally) inline SGF. */

import { SgfNode, coord, eachNode, findGames, getMove, points, xy2pt } from './sgf';

export interface Block {
	/** The lines before the SGF, exactly as written. */
	header: string[];
	opts: Record<string, string>;
	/** Everything from the first line that starts with "(" on, exactly as written. */
	rest: string;
	/** All the games found in `rest`, as [start, end) offsets. */
	games: [number, number][];
}

/** Visible part of the board; inclusive, 0-based, y grows downwards. */
export interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const OPTION = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;

export function parseBlock(source: string): Block {
	const text = source.replace(/\r/g, '').replace(/\n+$/, '');
	const lines = text === '' ? [] : text.split('\n');
	const header: string[] = [];
	const opts: Record<string, string> = {};
	let k = 0;
	for (; k < lines.length; k++) {
		const t = lines[k].trim();
		if (t.startsWith('(')) break;
		header.push(lines[k]);
		const m = OPTION.exec(t);
		if (m) opts[m[1].toLowerCase()] = m[2].trim();
	}
	const rest = lines.slice(k).join('\n');
	return { header, opts, rest, games: findGames(rest) };
}

/**
 * Put a block body back together. Only the game is ours to change: whatever else
 * was written after the option lines (another game, a remark) is kept as it is.
 * `game` is the new text of the game (null: the block should hold no game of
 * ours), `range` is where the old one sits in `rest` (null: there was none).
 */
export function composeBlock(header: string[], rest: string, game: string | null, range: [number, number] | null): string {
	let tail = rest;
	if (range) tail = rest.slice(0, range[0]) + (game ?? '') + rest.slice(range[1]);
	else if (game) tail = rest ? rest + '\n' + game : game;
	if (game === null && range) tail = tail.replace(/^\n+/, '');
	const head = header.join('\n');
	return head && tail ? head + '\n' + tail : head || tail;
}

/** Set, replace or (with null) remove one option line. Returns a new header. */
export function setOption(header: string[], key: string, value: string | null): string[] {
	const out: string[] = [];
	let done = false;
	for (const line of header) {
		const m = OPTION.exec(line.trim());
		if (m && m[1].toLowerCase() === key) {
			if (value !== null && !done) out.push(`${key}: ${value}`);
			done = true;
		} else {
			out.push(line);
		}
	}
	if (!done && value !== null) {
		// after the last line that says something, before any blank lines that end the header
		let at = out.length;
		while (at > 0 && !out[at - 1].trim()) at--;
		out.splice(at, 0, `${key}: ${value}`);
	}
	return out;
}

export function parseBool(v: string | undefined): boolean | null {
	if (v === undefined) return null;
	if (/^(on|yes|true|1|show)$/i.test(v)) return true;
	if (/^(off|no|false|0|hide|none)$/i.test(v)) return false;
	return null;
}

/** "0.8", "80%" and "80" all mean 80 %. */
export function parseScale(v: string | undefined): number | null {
	if (!v) return null;
	const m = /^(\d*\.?\d+)\s*(%)?$/.exec(v.trim());
	if (!m) return null;
	let n = parseFloat(m[1]);
	if (m[2] || n > 5) n /= 100;
	if (!(n > 0)) return null;
	return Math.max(0.25, Math.min(4, n));
}

/** "13", "13x9" (columns x rows). */
export function parseSize(v: string | undefined): [number, number] | null {
	const m = /^(\d+)\s*(?:[x×:]\s*(\d+))?$/i.exec((v ?? '').trim());
	if (!m) return null;
	const w = parseInt(m[1]);
	const h = m[2] ? parseInt(m[2]) : w;
	if (w < 2 || h < 2 || w > 52 || h > 52) return null;
	return [w, h];
}

export interface Numbers {
	off: boolean;
	/** First move that gets a number. */
	from: number;
	/** Last move of the figure (decides which position is shown), or null. */
	to: number | null;
	/** Number printed on move `from`, or null to print real move numbers. */
	start: number | null;
}

/**
 * "on", "off", "51-100", "51-", "-30", "51", each optionally followed by "from N"
 * (also "as N") to choose the number printed on the first numbered move.
 */
export function parseNumbers(v: string | undefined): Numbers | null {
	if (v === undefined) return null;
	let s = v.trim().toLowerCase();
	if (/^(off|no|none|false|hide)$/.test(s)) return { off: true, from: 1, to: null, start: null };
	let start: number | null = null;
	const sm = /(?:^|\s)(?:from|as|start(?:ing)?(?:\s+at)?)\s*=?\s*(\d+)\s*$/.exec(s);
	if (sm) {
		start = parseInt(sm[1]);
		s = s.slice(0, sm.index).trim();
	}
	if (s === '' || /^(on|yes|all|true)$/.test(s)) return { off: false, from: 1, to: null, start };
	const rm = /^(\d+)?\s*(?:-|–|—|\.\.|to)\s*(\d+)?$/.exec(s);
	if (rm && (rm[1] || rm[2])) {
		const from = rm[1] ? Math.max(1, parseInt(rm[1])) : 1;
		const to = rm[2] ? Math.max(from, parseInt(rm[2])) : null;
		return { off: false, from, to, start };
	}
	if (/^\d+$/.test(s)) return { off: false, from: Math.max(1, parseInt(s)), to: null, start };
	return null;
}

const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

/** "Q16"-style name of a point. Very large boards fall back to SGF coordinates. */
export function pointName(x: number, y: number, h: number): string {
	return x < LETTERS.length ? LETTERS[x] + (h - y) : xy2pt(x, y);
}

function parsePoint(tok: string, w: number, h: number): [number, number] | null {
	let m = /^([A-Za-z])(\d{1,2})$/.exec(tok);
	if (m) {
		const x = LETTERS.indexOf(m[1].toUpperCase());
		const y = h - parseInt(m[2]);
		return x >= 0 && x < w && y >= 0 && y < h ? [x, y] : null;
	}
	m = /^([A-Za-z])([A-Za-z])$/.exec(tok);
	if (m) {
		const x = coord(tok.charCodeAt(0));
		const y = coord(tok.charCodeAt(1));
		return x < w && y < h ? [x, y] : null;
	}
	return null;
}

export function formatRect(r: Rect, w: number, h: number): string {
	if (w > LETTERS.length) return xy2pt(r.x0, r.y0) + ':' + xy2pt(r.x1, r.y1);
	return pointName(r.x0, r.y1, h) + '-' + pointName(r.x1, r.y0, h);
}

export function fullRect(w: number, h: number): Rect {
	return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
}

export function isFull(r: Rect, w: number, h: number): boolean {
	return r.x0 <= 0 && r.y0 <= 0 && r.x1 >= w - 1 && r.y1 >= h - 1;
}

/** [horizontal, vertical]: -1 = near edge, 1 = far edge, 0 = centred, 2 = whole span. */
const ANCHORS: Record<string, [number, number]> = {
	topleft: [-1, -1], upperleft: [-1, -1], lefttop: [-1, -1], tl: [-1, -1], nw: [-1, -1],
	topright: [1, -1], upperright: [1, -1], righttop: [1, -1], tr: [1, -1], ne: [1, -1],
	bottomleft: [-1, 1], lowerleft: [-1, 1], leftbottom: [-1, 1], bl: [-1, 1], sw: [-1, 1],
	bottomright: [1, 1], lowerright: [1, 1], rightbottom: [1, 1], br: [1, 1], se: [1, 1],
	top: [2, -1], upper: [2, -1], t: [2, -1], n: [2, -1],
	bottom: [2, 1], lower: [2, 1], b: [2, 1], s: [2, 1],
	left: [-1, 2], l: [-1, 2], w: [-1, 2],
	right: [1, 2], r: [1, 2], e: [1, 2],
	center: [0, 0], centre: [0, 0], middle: [0, 0], c: [0, 0],
};

function span(anchor: number, n: number, size: number): [number, number] {
	n = Math.max(1, Math.min(size, n));
	if (anchor === 2) return [0, size - 1];
	if (anchor === -1) return [0, n - 1];
	if (anchor === 1) return [size - n, size - 1];
	const lo = Math.floor((size - n) / 2);
	return [lo, lo + n - 1];
}

/**
 * Understands "full", "auto", a named region ("top-right", "left", "center", ...)
 * with an optional size ("top-right 9x7", "top 6"), or two opposite corners
 * ("K10-T19", "ka:sj"). Returns null for anything else.
 */
export function parseView(spec: string | undefined, w: number, h: number): Rect | 'auto' | 'full' | null {
	if (!spec) return null;
	const s = spec.trim().toLowerCase();
	if (/^(full|all|whole|board)$/.test(s)) return 'full';
	if (s === 'auto' || s === 'crop') return 'auto';

	const cm = /^([a-z]{1,2}\d{0,2})\s*(?:-|–|:|\.\.|to)\s*([a-z]{1,2}\d{0,2})$/i.exec(spec.trim());
	if (cm) {
		const a = parsePoint(cm[1], w, h);
		const b = parsePoint(cm[2], w, h);
		if (a && b) {
			return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
		}
	}

	const m = /^([a-z][a-z\s_-]*?)(?:\s+(\d+)(?:\s*[x×]\s*(\d+))?)?$/.exec(s);
	if (!m) return null;
	const anchor = ANCHORS[m[1].replace(/[\s_-]/g, '')];
	if (!anchor) return null;
	const [ax, ay] = anchor;
	const n1 = m[2] ? parseInt(m[2]) : 0;
	const n2 = m[3] ? parseInt(m[3]) : 0;
	const half = (v: number) => Math.ceil(v / 2);
	let cols: number;
	let rows: number;
	let hx = ax;
	let hy = ay;
	if (ax === 0 && ay === 0) {
		cols = n1 || Math.min(w, half(w) + 1);
		rows = n2 || n1 || Math.min(h, half(h) + 1);
	} else if (ax === 2) {
		// top / bottom: one number is a row count; "CxR" also narrows it, centred
		rows = n2 || n1 || half(h);
		cols = n2 ? n1 : w;
		if (n2) hx = 0;
	} else if (ay === 2) {
		cols = n1 || half(w);
		rows = n2 || h;
		if (n2) hy = 0;
	} else {
		cols = n1 || half(w);
		rows = n2 || n1 || half(h);
	}
	const [x0, x1] = span(hx, cols, w);
	const [y0, y1] = span(hy, rows, h);
	return { x0, y0, x1, y1 };
}

/**
 * Crop to where the stones are: everything any variation touches, two lines of
 * breathing room, snapped to the board edge when the edge is close anyway.
 */
export function autoView(root: SgfNode, w: number, h: number): Rect {
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	const add = (pt: string) => {
		const x = coord(pt.charCodeAt(0));
		const y = coord(pt.charCodeAt(1));
		if (x < 0 || y < 0 || x >= w || y >= h) return;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
	};
	eachNode(root, (n) => {
		if (n.temp) return;
		const p = n.props;
		const m = getMove(n, w, h);
		if (m && !m.pass) add(xy2pt(m.x, m.y));
		for (const id of ['AB', 'AW', 'TR', 'SQ', 'CR', 'MA']) {
			if (p[id]) for (const pt of points(p[id])) add(pt);
		}
		// (a label is "point:text"; its text must not be mistaken for a second point)
		for (const v of p.LB ?? []) add(v.slice(0, 2));
	});
	if (x1 < 0) return fullRect(w, h);
	const MARGIN = 2;
	const SNAP = 2;
	const fit = (lo: number, hi: number, size: number): [number, number] => {
		lo -= MARGIN;
		hi += MARGIN;
		if (lo <= SNAP) lo = 0;
		if (hi >= size - 1 - SNAP) hi = size - 1;
		return [lo, hi];
	};
	[x0, x1] = fit(x0, x1, w);
	[y0, y1] = fit(y0, y1, h);
	return { x0, y0, x1, y1 };
}

/** Star points for any board size. */
export function starPoints(w: number, h: number): [number, number][] {
	const line = (n: number): number[] => {
		if (n < 7) return [];
		const near = n >= 13 ? 3 : 2;
		const out = [near, n - 1 - near];
		if (n % 2 === 1 && n >= 15) out.push((n - 1) / 2);
		return out;
	};
	const xs = line(w);
	const ys = line(h);
	const out: [number, number][] = [];
	for (const x of xs) for (const y of ys) out.push([x, y]);
	// tengen on smaller odd boards (9x9, 13x13), where the sides get no star points
	if (w % 2 === 1 && h % 2 === 1 && w >= 7 && h >= 7 && w < 15 && h < 15) {
		out.push([(w - 1) / 2, (h - 1) / 2]);
	}
	return out;
}
