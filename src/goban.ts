/** Board state and the rules needed to play a position out: captures, suicide, simple ko. */

import { SgfNode, getMove, points, coord } from './sgf';

export class Board {
	readonly w: number;
	readonly h: number;
	/** 0 empty, 1 black, 2 white; index = y * w + x. */
	g: Uint8Array;
	/** Point that may not be retaken because of ko, or -1; and the colour it is closed to. */
	ko = -1;
	koFor = 0;
	private seen: Uint32Array;
	private gen = 0;
	private stack: Int32Array;

	constructor(w: number, h: number, g?: Uint8Array) {
		this.w = w;
		this.h = h;
		this.g = g ? g.slice() : new Uint8Array(w * h);
		this.seen = new Uint32Array(w * h);
		this.stack = new Int32Array(w * h);
	}

	clone(): Board {
		const b = new Board(this.w, this.h, this.g);
		b.ko = this.ko;
		b.koFor = this.koFor;
		return b;
	}

	private neighbor(i: number, d: number): number {
		const w = this.w;
		if (d === 0) return i % w > 0 ? i - 1 : -1;
		if (d === 1) return i % w < w - 1 ? i + 1 : -1;
		if (d === 2) return i >= w ? i - w : -1;
		return i + w < this.g.length ? i + w : -1;
	}

	/** Walk the group at `start`. Returns its size if it has no liberties, otherwise 0. */
	private deadSize(start: number): number {
		const { g, seen, stack } = this;
		const c = g[start];
		const gen = ++this.gen;
		let sp = 0;
		let size = 0;
		stack[sp++] = start;
		seen[start] = gen;
		while (sp) {
			const i = stack[--sp];
			size++;
			for (let d = 0; d < 4; d++) {
				const n = this.neighbor(i, d);
				if (n < 0) continue;
				if (!g[n]) return 0;
				if (g[n] === c && seen[n] !== gen) {
					seen[n] = gen;
					stack[sp++] = n;
				}
			}
		}
		return size;
	}

	/** Remove the group that was just walked by deadSize(). */
	private removeWalked(): void {
		const { g, seen, gen } = this;
		for (let i = 0; i < g.length; i++) if (seen[i] === gen) g[i] = 0;
	}

	/**
	 * Put a stone on the board and resolve captures. No legality check: SGF files are
	 * replayed as written. Returns how many stones left the board.
	 */
	play(i: number, c: number): number {
		const g = this.g;
		g[i] = c;
		const other = 3 - c;
		let removed = 0;
		let single = -1;
		for (let d = 0; d < 4; d++) {
			const n = this.neighbor(i, d);
			if (n < 0 || g[n] !== other) continue;
			const size = this.deadSize(n);
			if (size) {
				this.removeWalked();
				removed += size;
				single = n;
			}
		}
		this.ko = -1;
		if (!removed) {
			const size = this.deadSize(i);
			if (size) {
				this.removeWalked(); // suicide
				return size;
			}
		} else if (removed === 1) {
			// Ko: one stone taken by a lone stone that is itself left with exactly one liberty.
			let libs = 0;
			let alone = true;
			for (let d = 0; d < 4; d++) {
				const n = this.neighbor(i, d);
				if (n < 0) continue;
				if (!g[n]) libs++;
				else if (g[n] === c) alone = false;
			}
			if (alone && libs === 1) {
				this.ko = single;
				this.koFor = other; // (the one who took may fill the ko himself)
			}
		}
		return removed;
	}

	/** May colour `c` play at `i`? (Empty point, not suicide, not an immediate ko recapture.) */
	legal(i: number, c: number): boolean {
		if (i < 0 || i >= this.g.length || this.g[i] || (i === this.ko && c === this.koFor)) return false;
		for (let d = 0; d < 4; d++) {
			const n = this.neighbor(i, d);
			if (n >= 0 && !this.g[n]) return true; // has a liberty of its own: always fine
		}
		const b = this.clone();
		b.play(i, c);
		return b.g[i] === c;
	}
}

export interface Replay {
	board: Board;
	/** Move number of the stone standing on each point (0 for empty points and setup stones). */
	num: Int32Array;
	/** Move number reached at the end of the path. */
	moveNo: number;
	/** Point of the last node's move, or -1. */
	last: number;
}

function applySetup(node: SgfNode, board: Board, num: Int32Array | null): void {
	const p = node.props;
	if (!p.AB && !p.AW && !p.AE) return;
	const { w, h, g } = board;
	const put = (vals: string[] | undefined, c: number) => {
		for (const pt of points(vals)) {
			const x = coord(pt.charCodeAt(0));
			const y = coord(pt.charCodeAt(1));
			if (x < 0 || y < 0 || x >= w || y >= h) continue;
			g[y * w + x] = c;
			if (num) num[y * w + x] = 0;
		}
	};
	put(p.AB, 1);
	put(p.AW, 2);
	put(p.AE, 0);
	board.ko = -1;
}

/** The move number a node carries: counts moves, honouring MN[] renumbering. */
function nextMoveNo(node: SgfNode, prev: number): number {
	const mn = node.props.MN;
	if (mn) {
		const v = parseInt(mn[0]);
		if (v > 0) return v;
	}
	return prev + 1;
}

/**
 * Replay a path from the root. Within a node the move is played first and setup
 * stones are applied afterwards.
 */
export function replay(path: SgfNode[], w: number, h: number, skipLastSetup = false): Replay {
	const board = new Board(w, h);
	const num = new Int32Array(w * h);
	let moveNo = 0;
	let last = -1;
	for (let k = 0; k < path.length; k++) {
		const node = path[k];
		last = -1;
		const m = getMove(node, w, h);
		if (m) {
			moveNo = nextMoveNo(node, moveNo);
			if (m.pass) {
				board.ko = -1;
			} else {
				const i = m.y * w + m.x;
				if (board.play(i, m.color)) {
					for (let j = 0; j < num.length; j++) if (!board.g[j]) num[j] = 0;
				}
				if (board.g[i]) num[i] = moveNo;
				last = i;
			}
		}
		if (!(skipLastSetup && k === path.length - 1)) applySetup(node, board, num);
	}
	return { board, num, moveNo, last };
}

export interface FigureNote {
	label: string;
	color: 1 | 2;
	/** What the stone was played on: another move's number, or a coordinate. */
	at: string;
	/** Colour of the numbered stone it was played on (0 when `at` is a coordinate). */
	atColor: number;
}

export interface Figure {
	grid: Uint8Array;
	labels: Map<number, string>;
	notes: FigureNote[];
}

/**
 * A book-style figure: the position before move `from`, with every later move on the
 * path drawn as a numbered stone. Captured stones stay where they were, and a move
 * that lands on an occupied point is reported as a note ("7 at 3") instead.
 */
export function buildFigure(
	path: SgfNode[],
	w: number,
	h: number,
	from: number,
	start: number,
	name: (i: number) => string,
): Figure {
	const board = new Board(w, h);
	const grid = board.g;
	const labels = new Map<number, string>();
	const notes: FigureNote[] = [];
	let moveNo = 0;
	let composite = false;
	for (const node of path) {
		const m = getMove(node, w, h);
		if (m) {
			moveNo = nextMoveNo(node, moveNo);
			if (moveNo >= from) composite = true;
			if (!m.pass) {
				const i = m.y * w + m.x;
				if (!composite) {
					board.play(i, m.color);
				} else {
					const label = String(moveNo - from + start);
					if (grid[i]) {
						const on = labels.get(i);
						notes.push({ label, color: m.color, at: on ?? name(i), atColor: on ? grid[i] : 0 });
					} else {
						grid[i] = m.color;
						labels.set(i, label);
					}
				}
			}
		}
		if (node.props.AB || node.props.AW || node.props.AE) {
			const before = grid.slice();
			applySetup(node, board, null);
			for (let i = 0; i < grid.length; i++) if (grid[i] !== before[i]) labels.delete(i);
		}
	}
	return { grid, labels, notes };
}
