/**
 * Draws a position the way a book prints it: thin lines, flat stones, numbers and
 * marks, nothing else. Everything of one kind goes into a single path, so even a
 * full board is only a handful of DOM nodes plus its labels.
 */

import type { Model } from '../session';
import { Rect, pointName, starPoints } from '../options';
import { clear, svg } from './dom';

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

export interface Look {
	/** Pixels between two lines. */
	cell: number;
	coords: boolean;
}

const circle = (cx: number, cy: number, r: number): string =>
	`M${+(cx - r).toFixed(1)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

/** Font size for a label of a given length. */
const FONT = [0, 62, 54, 46, 38, 32];

export class BoardSvg {
	readonly el: SVGSVGElement;
	private fixed: SVGGElement;
	private black: SVGPathElement;
	private white: SVGPathElement;
	private over: SVGGElement;
	private dim: SVGPathElement;
	private frame: SVGPathElement;
	private ghost: SVGCircleElement;
	private fixedKey = '';
	private vx = 0;
	private vy = 0;
	private vw = 1;
	private vh = 1;
	private view: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
	private crop: Rect | null = null;
	private px = 1;

	constructor(parent: HTMLElement) {
		this.el = svg(parent, 'svg', { class: 'kifu-svg', role: 'img', 'aria-label': 'Go board' });
		this.fixed = svg(this.el, 'g');
		this.black = svg(this.el, 'path', { class: 'kifu-b' });
		this.white = svg(this.el, 'path', { class: 'kifu-w' });
		this.over = svg(this.el, 'g');
		this.dim = svg(this.el, 'path', { class: 'kifu-dim', 'fill-rule': 'evenodd' });
		this.frame = svg(this.el, 'path', { class: 'kifu-crop' });
		this.ghost = svg(this.el, 'circle', { class: 'kifu-ghost', r: R });
	}

	draw(m: Model, look: Look): void {
		const { w, h, view } = m;
		const cell = look.cell;
		const k = U / cell; // units per pixel
		this.px = k;
		const line = Math.max(1, Math.round(cell / 30)); // px
		const border = line * 2; // px
		const ring = Math.max(1, cell / 22) * k; // outline of a white stone, units
		const band = look.coords ? BAND : 0;
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

		const key = `${w} ${h} ${view.x0} ${view.y0} ${view.x1} ${view.y1} ${cell} ${band}`;
		if (key !== this.fixedKey) {
			this.fixedKey = key;
			this.el.setAttribute('viewBox', `${this.vx} ${this.vy} ${this.vw} ${this.vh}`);
			this.el.setAttribute('width', String(Math.round(this.vw / k)));
			this.el.setAttribute('height', String(Math.round(this.vh / k)));
			this.drawFixed(w, h, view, line, border, k, band, cell);
		}

		// stones
		let bd = '';
		let wd = '';
		const rw = +(R - ring / 2).toFixed(1);
		for (let y = view.y0; y <= view.y1; y++) {
			for (let x = view.x0; x <= view.x1; x++) {
				const c = m.grid[y * w + x];
				if (c === 1) bd += circle(x * U + HALF, y * U + HALF, R);
				else if (c === 2) wd += circle(x * U + HALF, y * U + HALF, rw);
			}
		}
		this.black.setAttribute('d', bd);
		this.white.setAttribute('d', wd);
		this.white.setAttribute('stroke-width', ring.toFixed(1));

		// marks, labels, the last-move dot
		clear(this.over);
		const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;
		const stroke = Math.max(6, 1.5 * k).toFixed(1);
		const on = (i: number) => (m.grid[i] === 1 ? 'kifu-on-b' : m.grid[i] === 2 ? 'kifu-on-w' : 'kifu-on-e');
		m.marks.forEach((kind, i) => {
			const x = i % w;
			const y = Math.floor(i / w);
			if (!inView(x, y)) return;
			const cx = x * U + HALF;
			const cy = y * U + HALF;
			let d: string;
			if (kind === 'TR') d = `M${cx} ${cy - 30}L${cx + 28.6} ${cy + 19.5}H${cx - 28.6}z`;
			else if (kind === 'SQ') d = `M${cx - 21} ${cy - 21}h42v42h-42z`;
			else if (kind === 'CR') d = circle(cx, cy, 24);
			else {
				d = `M${cx - 19} ${cy - 19}l38 38M${cx + 19} ${cy - 19}l-38 38`;
				if (!m.grid[i]) svg(this.over, 'circle', { cx, cy, r: 27, class: 'kifu-blank' });
			}
			svg(this.over, 'path', { d, class: `kifu-mark ${on(i)}`, 'stroke-width': stroke });
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
				svg(this.over, 'rect', { x: cx - half, y: cy - 31, width: half * 2, height: 62, rx: 14, class: 'kifu-blank' });
			}
			const t = svg(this.over, 'text', { x: cx, y: +(cy + fs * 0.355).toFixed(1), 'font-size': fs, class: `kifu-text ${on(i)}` });
			if (n >= 3 && /^\d+$/.test(text)) {
				// three figures have to fit on a stone: squeeze them like a condensed face
				t.setAttribute('textLength', n === 3 ? '70' : '80');
				t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
			}
			t.textContent = text;
		});
		if (m.last >= 0 && !m.marks.has(m.last) && !m.labels.has(m.last) && m.grid[m.last]) {
			const x = m.last % w;
			const y = Math.floor(m.last / w);
			if (inView(x, y)) svg(this.over, 'circle', { cx: x * U + HALF, cy: y * U + HALF, r: 13, class: `kifu-last ${on(m.last)}` });
		}

		this.crop = m.crop;
		this.drawCrop(m.crop);
		this.setGhost(-1, -1, 0);
	}

	/** Lines, border, star points and coordinates: redrawn only when the geometry changes. */
	private drawFixed(w: number, h: number, v: Rect, line: number, border: number, k: number, band: number, cell: number): void {
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
			const fs = 38;
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
