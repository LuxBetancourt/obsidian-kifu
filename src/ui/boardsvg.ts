/**
 * Draws a position the way a book prints it: thin lines, flat stones, numbers and
 * marks, nothing else. Everything of one kind goes into a single path, so even a
 * full board is only a handful of DOM nodes plus its labels.
 */

import type { Model } from '../session';
import { Rect, pointName, starPoints } from '../options';
import { clear, svg, svgNode } from './dom';

/** Drawing units per line spacing. */
const U = 100;
const HALF = U / 2;
/** Stone radius. */
const R = 47.5;
/**
 * Which sides the coordinates go on: beside the board's real edges, as in print. The
 * numbers go on the right when the part shown reaches the right edge but not the left
 * one, otherwise on the left; the letters along the top when it reaches the top edge
 * but not the bottom one, otherwise along the bottom.
 */
export function coordSides(w: number, h: number, v: Rect): { right: boolean; top: boolean } {
	return { right: v.x1 === w - 1 && v.x0 > 0, top: v.y0 === 0 && v.y1 < h - 1 };
}

/** Width of the band that holds coordinates. */
const BAND = 80;

/**
 * How highlighted points (SL) look: a light grey cell, a diagonally striped one (with or
 * without a border along the edge of the region; the stripes still or sliding along), or a
 * small square on the point.
 */
export type Highlight = 'grey' | 'stripes' | 'stripes-border' | 'stripes-animated' | 'stripes-border-animated' | 'square';
export const HIGHLIGHTS: Highlight[] = ['grey', 'stripes', 'stripes-border', 'stripes-animated', 'stripes-border-animated', 'square'];

export interface Look {
	/** Pixels between two lines. */
	cell: number;
	coords: boolean;
	/**
	 * The cell that lines, stone outlines and coordinates are sized for, when it is not
	 * `cell`: a board drawn larger to fill a space keeps the look of one at its usual size.
	 */
	lineCell?: number;
	highlight?: Highlight;
	arrows?: ArrowStyle;
}

/** (each board's own ids for the stripes it fills highlights with and the clips of its lines and highlights) */
let serial = 0;

/** The width of a stripe of a striped highlight, and of the space between two: an eighth of a line spacing. */
const STRIPE = 12.5;

/** Width of the coordinates band, in pixels, for a board whose lines are sized for `lineCell`. */
export const bandPixels = (lineCell: number): number => (BAND * lineCell) / U;

const circle = (cx: number, cy: number, r: number): string =>
	`M${+(cx - r).toFixed(1)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

/** What follows the "M x y" of a stone of radius `r`: the same for every stone of a colour. */
const arc = (r: number): string => `a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const BLACK_ARC = arc(R);

/** A child of the overlay: what it shows (its key), and how to make it. */
interface Keyed {
	key: string;
	make: () => Element;
}

/** The outline a mark draws at a point: TR triangle, SQ square, CR circle, anything else a cross. */
function markPath(kind: string, cx: number, cy: number): string {
	if (kind === 'TR') return `M${cx} ${cy - 30}L${cx + 28.6} ${cy + 19.5}H${cx - 28.6}z`;
	if (kind === 'SQ') return `M${cx - 21} ${cy - 21}h42v42h-42z`;
	if (kind === 'CR') return circle(cx, cy, 24);
	return `M${cx - 19} ${cy - 19}l38 38M${cx + 19} ${cy - 19}l-38 38`;
}

/** What a hovering tool previews: a mark kind, a label, or nothing. */
export type MarkGhost = 'TR' | 'SQ' | 'CR' | 'MA' | 'label' | null;

/** How arrows look: a filled head, an open head (←), or a double line with an open head (⇐). */
export type ArrowStyle = 'filled' | 'open' | 'double';
export const ARROW_STYLES: ArrowStyle[] = ['filled', 'open', 'double'];

/**
 * A line or an arrow from one point to another: what is stroked (`shaft`: the line, and an
 * open head's arms), what is filled (`head`: a filled head), and the outline of it all that
 * gets an edge of paper (`casing`). Each end can be drawn back from its point's centre
 * (`trimA`, `trimB`), to the edge of a stone there, say; between two points close together
 * the near end gives way first, so that there is room for a head and a bit of shaft. The
 * head grows with the stroke but never takes more than half of a short arrow.
 */
function linePaths(
	ax: number, ay: number, bx: number, by: number, arrow: boolean, stroke: number,
	trimA = 0, trimB = 0, style: ArrowStyle = 'filled',
): { shaft: string; head: string; casing: string } {
	const f = (n: number): string => n.toFixed(1);
	const pt = (x: number, y: number): string => `${f(x)} ${f(y)}`;
	const len = Math.hypot(bx - ax, by - ay);
	const ux = (bx - ax) / len;
	const uy = (by - ay) / len;
	let short = (arrow ? 24 + stroke * 2.4 : 0) + 12 - (len - trimA - trimB);
	if (short > 0) {
		const a = Math.min(trimA, short);
		trimA -= a;
		short -= a;
		trimB -= Math.min(trimB, short);
	}
	const x0 = ax + ux * trimA;
	const y0 = ay + uy * trimA;
	const x1 = bx - ux * trimB;
	const y1 = by - uy * trimB;
	const line = `M${pt(x0, y0)}L${pt(x1, y1)}`;
	if (!arrow) return { shaft: line, head: '', casing: line };
	const hl = Math.min((len - trimA - trimB) / 2, 24 + stroke * 2.4);
	const cx = x1 - ux * hl;
	const cy = y1 - uy * hl;
	// (the two corners of the head's base, `hw` either side of the shaft)
	const arms = (hw: number): string => `M${pt(cx - uy * hw, cy + ux * hw)}L${pt(x1, y1)}L${pt(cx + uy * hw, cy - ux * hw)}`;
	if (style === 'open') {
		const shaft = line + arms(hl * 0.55);
		return { shaft, head: '', casing: shaft };
	}
	if (style === 'double') {
		// two lines either side of the middle, running into the arms of a wide open head
		const o = stroke * 1.3;
		const hw = Math.max(hl * 0.8, o * 2.2);
		const t = (o * hl) / hw; // (how far back from the tip an arm is `o` from the middle)
		const ex = x1 - ux * t;
		const ey = y1 - uy * t;
		const side = (s: number): string => `M${pt(x0 - uy * o * s, y0 + ux * o * s)}L${pt(ex - uy * o * s, ey + ux * o * s)}`;
		const shaft = side(1) + side(-1) + arms(hw);
		return { shaft, head: '', casing: shaft + `M${pt(x0, y0)}L${pt(ex, ey)}` };
	}
	const hw = hl * 0.42;
	const shaft = `M${pt(x0, y0)}L${pt(cx, cy)}`;
	const head = `M${pt(x1, y1)}L${pt(cx - uy * hw, cy + ux * hw)}L${pt(cx + uy * hw, cy - ux * hw)}z`;
	return { shaft, head, casing: shaft + head };
}

/** Font size for a label of a given length. */
const FONT = [0, 62, 54, 46, 38, 32];

export class BoardSvg {
	readonly el: SVGSVGElement;
	/**
	 * Highlighted points, under the lines: the cells, grey or striped, and (striped with a
	 * border) a band along the edge of the region, clipped to it (`hlClip`). They are one group,
	 * light as a whole, so that where the band and the stripes meet they do not darken each other.
	 */
	private hlGroup: SVGGElement;
	private hl: SVGPathElement;
	private hlEdge: SVGPathElement;
	private hlClip: SVGPathElement;
	private fixed: SVGGElement;
	private black: SVGPathElement;
	private white: SVGPathElement;
	/** Dimmed points: a veil of paper over their lines and stones. */
	private faded: SVGPathElement;
	private over: SVGGElement;
	/**
	 * Lines and arrows, over everything on the board: a paper edge, the ink, the heads. The
	 * edge is masked out over highlighted points (`caseMask`): along stripes running the same
	 * way, it made a glaring white channel; on the shading the ink reads well enough by itself.
	 */
	private lineCase: SVGPathElement;
	/** The highlight once more, seen only through the edges (`caseShape`, a mask): over highlighted points an edge shows the highlight, not paper. */
	private caseShape: SVGPathElement;
	private caseHl: SVGGElement;
	private caseHlFill: SVGPathElement;
	private caseHlEdge: SVGPathElement;
	private hatch: SVGGElement;
	private arrowStyle: ArrowStyle = 'filled';
	private lineInk: SVGPathElement;
	private lineHead: SVGPathElement;
	private clip: SVGRectElement;
	private readonly id = ++serial;
	private dim: SVGPathElement;
	private frame: SVGPathElement;
	private ghost: SVGCircleElement;
	private markGhost: SVGGElement;
	private fixedKey = '';
	private vx = 0;
	private vy = 0;
	private vw = 1;
	private vh = 1;
	private view: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
	private crop: Rect | null = null;
	private px = 1;
	/** The start of each stone's path, one per column shown, and the white arc, for the last ring width and view. */
	private stones: { key: string; black: string[]; white: string[]; whiteArc: string } | null = null;
	/** The key of each child of the overlay, in order (see reconcile). */
	private overKeys: string[] = [];

	constructor(parent: HTMLElement) {
		this.el = svg(parent, 'svg', { class: 'kifu-svg', role: 'img', 'aria-label': 'Go board' });
		const defs = svg(this.el, 'defs');
		// (stripes rising to the right, as wide as the space between them, the same in every cell
		// so that a region reads as one)
		// Two stripes a tile apart, so that the hatching can slide on by a whole tile and loop
		// without a jump (styles.css). It is the group inside the tile that moves: an animated
		// patternTransform or tile x is run but never repainted (Chromium, when the board was
		// drawn before it was on the page; WebKit, always).
		const pattern = svg(defs, 'pattern', { id: `kifu-stripes-${this.id}`, patternUnits: 'userSpaceOnUse', width: STRIPE * 2, height: STRIPE * 2, patternTransform: 'rotate(45)' });
		this.hatch = svg(pattern, 'g', { class: 'kifu-hatch-g' });
		for (const x of [STRIPE, -STRIPE]) svg(this.hatch, 'line', { x1: x, y1: 0, x2: x, y2: STRIPE * 2, 'stroke-width': STRIPE, class: 'kifu-hatch' });
		this.clip = svg(svg(defs, 'clipPath', { id: `kifu-clip-${this.id}` }), 'rect');
		this.hlClip = svg(svg(defs, 'clipPath', { id: `kifu-hl-clip-${this.id}` }), 'path');
		// (everywhere, less the highlighted cells; far larger than any board)
		const all = { x: -1e4, y: -1e4, width: 3e4, height: 3e4 };
		const mask = svg(defs, 'mask', { id: `kifu-case-${this.id}`, maskUnits: 'userSpaceOnUse', ...all });
		this.caseShape = svg(mask, 'path', { class: 'kifu-case-shape' });
		this.hlGroup = svg(this.el, 'g', { class: 'kifu-hl-g' });
		this.hl = svg(this.hlGroup, 'path', { class: 'kifu-hl' });
		// (a stroke twice the stripe's width along the edge, clipped to the region: a stripe's width inside it)
		this.hlEdge = svg(this.hlGroup, 'path', { class: 'kifu-hl-edge', 'stroke-width': STRIPE * 2, 'clip-path': `url(#kifu-hl-clip-${this.id})` });
		this.fixed = svg(this.el, 'g');
		this.black = svg(this.el, 'path', { class: 'kifu-b' });
		this.white = svg(this.el, 'path', { class: 'kifu-w' });
		this.faded = svg(this.el, 'path', { class: 'kifu-faded' });
		this.over = svg(this.el, 'g');
		const lines = svg(this.el, 'g', { 'clip-path': `url(#kifu-clip-${this.id})` });
		this.lineCase = svg(lines, 'path', { class: 'kifu-line-case' });
		this.caseHl = svg(lines, 'g', { class: 'kifu-hl-g', mask: `url(#kifu-case-${this.id})` });
		this.caseHlFill = svg(this.caseHl, 'path', { class: 'kifu-hl-copy' });
		this.caseHlEdge = svg(this.caseHl, 'path', { class: 'kifu-hl-edge-copy', 'stroke-width': STRIPE * 2, 'clip-path': `url(#kifu-hl-clip-${this.id})` });
		this.lineInk = svg(lines, 'path', { class: 'kifu-line' });
		this.lineHead = svg(lines, 'path', { class: 'kifu-line-head' });
		this.dim = svg(this.el, 'path', { class: 'kifu-dim', 'fill-rule': 'evenodd' });
		this.frame = svg(this.el, 'path', { class: 'kifu-crop' });
		this.ghost = svg(this.el, 'circle', { class: 'kifu-ghost', r: R });
		this.markGhost = svg(this.el, 'g', { class: 'kifu-mark-ghost' });
	}

	draw(m: Model, look: Look): void {
		const { w, h, view } = m;
		const cell = look.cell;
		const k = U / cell; // units per pixel
		this.px = k;
		const lc = look.lineCell ?? cell;
		const line = Math.max(1, Math.round(lc / 30)); // px
		const border = line * 2; // px
		const ring = Math.max(1, lc / 22) * k; // outline of a white stone, units
		// (the band and its text keep their size in pixels too)
		const band = look.coords ? (BAND * lc) / cell : 0;
		// Nudge everything by half a pixel when that puts the lines exactly on the pixel grid.
		const shift = (line + cell) % 2 ? 0.5 * k : 0;
		const X0 = view.x0 * U;
		const Y0 = view.y0 * U;
		const X1 = (view.x1 + 1) * U;
		const Y1 = (view.y1 + 1) * U;
		this.view = view;
		// the coordinates go beside the board's real edges (see coordSides)
		const sides = coordSides(w, h, view);
		this.vx = X0 - (sides.right ? 0 : band) - shift;
		this.vy = Y0 - (sides.top ? band : 0) - shift;
		this.vw = X1 - X0 + band;
		this.vh = Y1 - Y0 + band;

		const key = `${w} ${h} ${view.x0} ${view.y0} ${view.x1} ${view.y1} ${cell} ${band} ${lc}`;
		if (key !== this.fixedKey) {
			this.fixedKey = key;
			this.el.setAttribute('viewBox', `${this.vx} ${this.vy} ${this.vw} ${this.vh}`);
			this.el.setAttribute('width', String(Math.round(this.vw / k)));
			this.el.setAttribute('height', String(Math.round(this.vh / k)));
			for (const [a, v] of [['x', X0], ['y', Y0], ['width', X1 - X0], ['height', Y1 - Y0]] as const) this.clip.setAttribute(a, String(v));
			this.drawFixed(w, h, view, line, border, k, band, cell, lc);
		}

		// Stones: every one of a colour in one path. The start of each ("M x y") and the arc
		// after it are the same few strings over and over, so they are made once per column
		// and once per colour, not for every stone at every redraw.
		const rw = +(R - ring / 2).toFixed(1);
		const stoneKey = `${rw} ${view.x0} ${view.x1}`;
		let st = this.stones;
		if (!st || st.key !== stoneKey) {
			const black: string[] = [];
			const white: string[] = [];
			for (let x = view.x0; x <= view.x1; x++) {
				const cx = x * U + HALF;
				black.push(`M${+(cx - R).toFixed(1)}`);
				white.push(`M${+(cx - rw).toFixed(1)}`);
			}
			st = this.stones = { key: stoneKey, black, white, whiteArc: arc(rw) };
		}
		let bd = '';
		let wd = '';
		for (let y = view.y0; y <= view.y1; y++) {
			const cy = ` ${y * U + HALF}`;
			const row = y * w;
			for (let x = view.x0; x <= view.x1; x++) {
				const c = m.grid[row + x];
				if (c === 1) bd += st.black[x - view.x0] + cy + BLACK_ARC;
				else if (c === 2) wd += st.white[x - view.x0] + cy + st.whiteArc;
			}
		}
		this.black.setAttribute('d', bd);
		this.white.setAttribute('d', wd);
		this.white.setAttribute('stroke-width', ring.toFixed(1));

		// Marks, labels, the last-move dot: an element each, keyed by what it shows, so that
		// a redraw touches only those that changed (a step through a game changes one or two).
		const want: Keyed[] = [];
		const doc = this.el.ownerDocument;
		const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;
		const stroke = Math.max(6, 1.5 * k).toFixed(1);
		const on = (i: number) => (m.grid[i] === 1 ? 'kifu-on-b' : m.grid[i] === 2 ? 'kifu-on-w' : 'kifu-on-e');

		// Highlighted points: a cell shaded grey or striped under the lines, stopping at the
		// board's real edges; or, in the "square" look, a small square on the point, under any
		// mark. Dimmed points: the whole cell veiled in paper, stones and lines alike.
		const style = look.highlight ?? 'grey';
		const box = (x: number, y: number, toEdge: boolean): [number, number, number, number] => {
			let x0 = x * U;
			let x1 = x0 + U;
			let y0 = y * U;
			let y1 = y0 + U;
			if (toEdge) {
				if (x === 0) x0 = HALF;
				if (x === w - 1) x1 = x * U + HALF;
				if (y === 0) y0 = HALF;
				if (y === h - 1) y1 = y * U + HALF;
			}
			return [x0, y0, x1, y1];
		};
		const cellPath = (x: number, y: number, toEdge: boolean): string => {
			const [x0, y0, x1, y1] = box(x, y, toEdge);
			return `M${x0} ${y0}H${x1}V${y1}H${x0}z`;
		};
		const striped = style.startsWith('stripes');
		const bordered = style === 'stripes-border' || style === 'stripes-border-animated';
		// (the border: the sides of the region, where a cell has no highlighted neighbour, even one out of sight)
		const outside = (x: number, y: number): boolean => x < 0 || y < 0 || x >= w || y >= h || !m.selected.has(y * w + x);
		let hd = '';
		let ed = '';
		m.selected.forEach((i) => {
			const x = i % w;
			const y = Math.floor(i / w);
			if (!inView(x, y)) return;
			if (style !== 'square') {
				hd += cellPath(x, y, true);
				if (bordered) {
					const [x0, y0, x1, y1] = box(x, y, true);
					if (outside(x, y - 1)) ed += `M${x0} ${y0}H${x1}`;
					if (outside(x, y + 1)) ed += `M${x0} ${y1}H${x1}`;
					if (outside(x - 1, y)) ed += `M${x0} ${y0}V${y1}`;
					if (outside(x + 1, y)) ed += `M${x1} ${y0}V${y1}`;
				}
				return;
			}
			const cx = x * U + HALF;
			const cy = y * U + HALF;
			const cls = `kifu-sel ${on(i)}`;
			want.push({ key: `s${i} ${cls}`, make: () => svgNode(doc, 'path', { d: `M${cx - 18} ${cy - 18}h36v36h-36z`, class: cls }) });
		});
		this.hlClip.setAttribute('d', hd);
		// the highlight, and its copy that the edges of lines and arrows show over it
		for (const [g, fill, band, cls] of [
			[this.hlGroup, this.hl, this.hlEdge, 'kifu-hl'],
			[this.caseHl, this.caseHlFill, this.caseHlEdge, 'kifu-hl-copy'],
		] as const) {
			g.setAttribute('class', striped ? 'kifu-hl-g is-striped' : 'kifu-hl-g');
			fill.setAttribute('d', hd);
			fill.setAttribute('class', striped ? `${cls} is-striped` : cls);
			if (striped) fill.setAttribute('fill', `url(#kifu-stripes-${this.id})`);
			else fill.removeAttribute('fill');
			band.setAttribute('d', ed);
		}
		// (sliding stripes: still for a reader who asks for less motion, in styles.css)
		this.hatch.classList.toggle('is-sliding', style.endsWith('-animated'));
		let fd = '';
		m.dimmed.forEach((i) => {
			const x = i % w;
			const y = Math.floor(i / w);
			if (inView(x, y)) fd += cellPath(x, y, false);
		});
		this.faded.setAttribute('d', fd);

		// Lines and arrows, over everything else on the board, each with a thin edge of paper
		// so that it reads across the lines or over a stone it passes. An end on a stone (or a
		// mark or label) stops at the stone's edge, so that an arrow points at a stone rather
		// than covering it and its number. (One end in sight is enough: the rest is clipped to
		// the part shown.)
		const lw = Math.max(6, 1.5 * k);
		const edge = Math.max(3, k);
		const taken = (i: number): boolean => m.grid[i] !== 0 || m.marks.has(i) || m.labels.has(i);
		this.arrowStyle = look.arrows ?? 'filled';
		let shafts = '';
		let heads = '';
		let casings = '';
		for (const l of m.lines) {
			const ax = l.from % w;
			const ay = Math.floor(l.from / w);
			const bx = l.to % w;
			const by = Math.floor(l.to / w);
			if (!inView(ax, ay) && !inView(bx, by)) continue;
			const trimA = taken(l.from) ? R + edge : 0;
			const trimB = taken(l.to) ? R + edge : 0;
			const p = linePaths(ax * U + HALF, ay * U + HALF, bx * U + HALF, by * U + HALF, l.arrow, lw, trimA, trimB, this.arrowStyle);
			shafts += p.shaft;
			heads += p.head;
			casings += p.casing;
		}
		const cw = (lw + 2 * edge).toFixed(1);
		this.lineCase.setAttribute('d', casings);
		this.lineCase.setAttribute('stroke-width', cw);
		this.caseShape.setAttribute('d', casings);
		this.caseShape.setAttribute('stroke-width', cw);
		this.lineInk.setAttribute('d', shafts);
		this.lineInk.setAttribute('stroke-width', lw.toFixed(1));
		this.lineHead.setAttribute('d', heads);
		this.lineHead.setAttribute('stroke-width', (lw / 2).toFixed(1));

		m.marks.forEach((kind, i) => {
			const x = i % w;
			const y = Math.floor(i / w);
			if (!inView(x, y)) return;
			const cx = x * U + HALF;
			const cy = y * U + HALF;
			if (kind === 'MA' && !m.grid[i]) want.push({ key: `b${i}`, make: () => svgNode(doc, 'circle', { cx, cy, r: 27, class: 'kifu-blank' }) });
			const cls = `kifu-mark ${on(i)}`;
			want.push({ key: `m${i} ${kind} ${cls} ${stroke}`, make: () => svgNode(doc, 'path', { d: markPath(kind, cx, cy), class: cls, 'stroke-width': stroke }) });
		});
		m.labels.forEach((text, i) => {
			const x = i % w;
			const y = Math.floor(i / w);
			if (!inView(x, y) || m.marks.has(i) || !text) return;
			const cx = x * U + HALF;
			const cy = y * U + HALF;
			const n = Math.min(text.length, FONT.length - 1);
			const fs = FONT[n];
			if (!m.grid[i]) {
				// hide the lines behind a label on an empty point
				const half = Math.max(30, n * 17 + 8);
				want.push({ key: `r${i} ${n}`, make: () => svgNode(doc, 'rect', { x: cx - half, y: cy - 31, width: half * 2, height: 62, rx: 14, class: 'kifu-blank' }) });
			}
			const cls = `kifu-text ${on(i)}`;
			want.push({
				key: `t${i} ${cls} ${text}`,
				make: () => {
					const t = svgNode(doc, 'text', { x: cx, y: +(cy + fs * 0.355).toFixed(1), 'font-size': fs, class: cls });
					if (n >= 3 && /^\d+$/.test(text)) {
						// three figures have to fit on a stone: squeeze them like a condensed face
						t.setAttribute('textLength', n === 3 ? '70' : '80');
						t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
					}
					t.textContent = text;
					return t;
				},
			});
		});
		if (m.last >= 0 && !m.marks.has(m.last) && !m.labels.has(m.last) && m.grid[m.last]) {
			const x = m.last % w;
			const y = Math.floor(m.last / w);
			const cls = `kifu-last ${on(m.last)}`;
			if (inView(x, y)) want.push({ key: `c${m.last} ${cls}`, make: () => svgNode(doc, 'circle', { cx: x * U + HALF, cy: y * U + HALF, r: 13, class: cls }) });
		}
		this.reconcile(this.over, want);

		this.crop = m.crop;
		this.drawCrop(m.crop);
		this.setGhost(-1, -1, 0);
	}

	/**
	 * Make the overlay hold `want`, in that order, keeping every child whose key it already
	 * holds (a child never changes: what it shows is in its key). Only what came or went is
	 * added or removed, so a redraw that changes little costs little.
	 */
	private reconcile(parent: SVGGElement, want: Keyed[]): void {
		const keys = this.overKeys;
		const wanted = new Set<string>();
		for (const w of want) wanted.add(w.key);
		const next: string[] = [];
		let node: ChildNode | null = parent.firstChild;
		let k = 0;
		for (const w of want) {
			// what stands here and is not wanted any more goes
			while (node && !wanted.has(keys[k])) {
				const gone = node;
				node = node.nextSibling;
				k++;
				parent.removeChild(gone);
			}
			if (node && keys[k] === w.key) {
				node = node.nextSibling;
				k++;
			} else {
				// (what stands here is wanted further on: ours goes in front of it)
				parent.insertBefore(w.make(), node);
			}
			next.push(w.key);
		}
		while (node) {
			const gone = node;
			node = node.nextSibling;
			parent.removeChild(gone);
		}
		this.overKeys = next;
	}

	/** Lines, border, star points and coordinates: redrawn only when the geometry changes. */
	private drawFixed(w: number, h: number, v: Rect, line: number, border: number, k: number, band: number, cell: number, lc: number): void {
		clear(this.fixed);
		const X0 = v.x0 * U;
		const Y0 = v.y0 * U;
		const X1 = (v.x1 + 1) * U;
		const Y1 = (v.y1 + 1) * U;
		const atLeft = v.x0 === 0;
		const atTop = v.y0 === 0;
		const atRight = v.x1 === w - 1;
		const atBottom = v.y1 === h - 1;
		// Where the board really ends the lines stop at the edge; where the figure is
		// cut they run on for half a space.
		const left = atLeft ? HALF : X0;
		const top = atTop ? HALF : Y0;
		const right = atRight ? X1 - HALF : X1;
		const bottom = atBottom ? Y1 - HALF : Y1;
		let d = '';
		for (let x = v.x0; x <= v.x1; x++) d += `M${x * U + HALF} ${top}V${bottom}`;
		for (let y = v.y0; y <= v.y1; y++) d += `M${left} ${y * U + HALF}H${right}`;
		svg(this.fixed, 'path', { d, class: 'kifu-grid', 'stroke-width': line });

		// The border is a heavier line, thickened outwards so its inner edge stays on the grid.
		const off = ((border - line) / 2) * k;
		const L = atLeft ? HALF - off : X0;
		const T = atTop ? HALF - off : Y0;
		const Rt = atRight ? X1 - HALF + off : X1;
		const B = atBottom ? Y1 - HALF + off : Y1;
		const corners = [`${L} ${T}`, `${Rt} ${T}`, `${Rt} ${B}`, `${L} ${B}`];
		const sides = [atTop, atRight, atBottom, atLeft];
		let e = '';
		if (sides.every(Boolean)) {
			e = `M${corners.join('L')}z`;
		} else {
			for (let s = 0; s < 4; s++) {
				if (!sides[s] || sides[(s + 3) % 4]) continue; // start where a run of real edges begins
				e += `M${corners[s]}`;
				for (let t = s; sides[t % 4] && t < s + 4; t++) e += `L${corners[(t + 1) % 4]}`;
			}
		}
		if (e) svg(this.fixed, 'path', { d: e, class: 'kifu-edge', 'stroke-width': border });

		const r = +(Math.max(1.75, cell * 0.1) * k).toFixed(1);
		let s = '';
		for (const [x, y] of starPoints(w, h)) {
			if (x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1) s += circle(x * U + HALF, y * U + HALF, r);
		}
		if (s) svg(this.fixed, 'path', { d: s, class: 'kifu-star' });

		if (band) {
			const fs = (38 * lc) / cell;
			const sides = coordSides(w, h, v);
			const nx = sides.right ? X1 + band / 2 : X0 - band / 2;
			const ly = sides.top ? Y0 - band / 2 : Y1 + band / 2;
			for (let y = v.y0; y <= v.y1; y++) {
				svg(this.fixed, 'text', { x: nx, y: y * U + HALF + fs * 0.355, 'font-size': fs, class: 'kifu-coord' }).textContent = String(h - y);
			}
			for (let x = v.x0; x <= v.x1; x++) {
				svg(this.fixed, 'text', { x: x * U + HALF, y: ly + fs * 0.355, 'font-size': fs, class: 'kifu-coord' }).textContent =
					pointName(x, 0, h).replace(/\d+$/, '');
			}
		}
	}

	/** Fade everything outside `r` (used while editing to show what stays visible). */
	private drawCrop(r: Rect | null): void {
		if (!r) {
			this.dim.setAttribute('d', '');
			this.frame.setAttribute('d', '');
			return;
		}
		const v = this.view;
		const inner = `M${r.x0 * U} ${r.y0 * U}H${(r.x1 + 1) * U}V${(r.y1 + 1) * U}H${r.x0 * U}z`;
		this.dim.setAttribute('d', `M${v.x0 * U} ${v.y0 * U}H${(v.x1 + 1) * U}V${(v.y1 + 1) * U}H${v.x0 * U}z` + inner);
		this.frame.setAttribute('d', inner);
	}

	/** Show a region being dragged out, or (null) go back to the saved one. */
	setSelection(r: Rect | null): void {
		this.drawCrop(r ?? this.crop);
	}

	/** The translucent stone under the mouse. Colour 0 hides it. */
	setGhost(x: number, y: number, color: number): void {
		const g = this.ghost;
		if (!color) {
			g.setAttribute('display', 'none');
			return;
		}
		g.setAttribute('cx', String(x * U + HALF));
		g.setAttribute('cy', String(y * U + HALF));
		g.setAttribute('class', `kifu-ghost ${color === 1 ? 'kifu-ghost-b' : 'kifu-ghost-w'}`);
		g.removeAttribute('display');
	}

	/**
	 * A faint preview of the mark or label a tool would place under the mouse, drawn like
	 * the real one so it sits exactly where it would land. `kind` null hides it; `stone`
	 * is the colour shown at the point (0 empty), so the preview takes a contrasting ink.
	 */
	setMarkGhost(x: number, y: number, kind: MarkGhost, text: string, stone: number): void {
		clear(this.markGhost);
		if (!kind || x < 0) return;
		const cx = x * U + HALF;
		const cy = y * U + HALF;
		const on = stone === 1 ? 'kifu-on-b' : stone === 2 ? 'kifu-on-w' : 'kifu-on-e';
		if (kind === 'label') {
			if (!text) return;
			const n = Math.min(text.length, FONT.length - 1);
			const fs = FONT[n];
			const t = svg(this.markGhost, 'text', { x: cx, y: +(cy + fs * 0.355).toFixed(1), 'font-size': fs, class: `kifu-text kifu-ghost-mark ${on}` });
			if (n >= 3 && /^\d+$/.test(text)) {
				t.setAttribute('textLength', n === 3 ? '70' : '80');
				t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
			}
			t.textContent = text;
			return;
		}
		const stroke = Math.max(6, 1.5 * this.px).toFixed(1);
		svg(this.markGhost, 'path', { d: markPath(kind, cx, cy), class: `kifu-mark kifu-ghost-mark ${on}`, 'stroke-width': stroke });
	}

	/** The line or arrow being dragged out, from `a` to `b` (null hides it). */
	setLineGhost(a: [number, number] | null, b: [number, number], arrow: boolean): void {
		clear(this.markGhost);
		if (!a || (a[0] === b[0] && a[1] === b[1])) return;
		const lw = Math.max(6, 1.5 * this.px);
		const p = linePaths(a[0] * U + HALF, a[1] * U + HALF, b[0] * U + HALF, b[1] * U + HALF, arrow, lw, 0, 0, this.arrowStyle);
		svg(this.markGhost, 'path', { d: p.shaft, class: 'kifu-line kifu-ghost-mark', 'stroke-width': lw.toFixed(1) });
		if (p.head) svg(this.markGhost, 'path', { d: p.head, class: 'kifu-line-head kifu-ghost-mark', 'stroke-width': (lw / 2).toFixed(1) });
	}

	/** The rectangle being dragged out to highlight or dim (null hides it). */
	setAreaGhost(r: Rect | null): void {
		clear(this.markGhost);
		if (!r) return;
		svg(this.markGhost, 'path', { d: `M${r.x0 * U} ${r.y0 * U}H${(r.x1 + 1) * U}V${(r.y1 + 1) * U}H${r.x0 * U}z`, class: 'kifu-area-ghost' });
	}

	/** Board point under a mouse position, or null when it is outside the drawn part. */
	pointAt(clientX: number, clientY: number, clamp = false): [number, number] | null {
		const box = this.el.getBoundingClientRect();
		if (!box.width || !box.height) return null;
		let x = Math.floor((this.vx + ((clientX - box.left) / box.width) * this.vw) / U);
		let y = Math.floor((this.vy + ((clientY - box.top) / box.height) * this.vh) / U);
		const v = this.view;
		if (clamp) {
			x = Math.max(v.x0, Math.min(v.x1, x));
			y = Math.max(v.y0, Math.min(v.y1, y));
		} else if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) {
			return null;
		}
		return [x, y];
	}
}
