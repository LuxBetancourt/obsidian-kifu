/**
 * Showing a board turned, mirrored or with the colours swapped, so a problem that is
 * met again does not look the same every time ("randomize: on"). Only the picture
 * changes: the game itself, and everything the board writes, stays as recorded.
 */

import type { Model } from './session';
import type { Rect } from './options';

export interface Orient {
	/** Bit 4: turn the board over its diagonal first; bit 1: mirror left to right; bit 2: top to bottom. */
	t: number;
	/** Black stones shown white and white ones black. */
	swap: boolean;
}

/** A fresh orientation. A board that is not square is only mirrored, never turned on its side. */
export function rollOrient(w: number, h: number, random: () => number = Math.random): Orient {
	const kinds = w === h ? 8 : 4;
	return { t: Math.floor(random() * kinds), swap: random() < 0.5 };
}

/** Size of the board as it is shown. */
export function shownSize(o: Orient, w: number, h: number): [number, number] {
	return o.t & 4 ? [h, w] : [w, h];
}

/** Where a point of the game is shown. */
export function toShown(o: Orient, x: number, y: number, w: number, h: number): [number, number] {
	if (o.t & 4) [x, y] = [y, x];
	const [sw, sh] = shownSize(o, w, h);
	if (o.t & 1) x = sw - 1 - x;
	if (o.t & 2) y = sh - 1 - y;
	return [x, y];
}

/** Which point of the game is shown at (x, y). */
export function fromShown(o: Orient, x: number, y: number, w: number, h: number): [number, number] {
	const [sw, sh] = shownSize(o, w, h);
	if (o.t & 1) x = sw - 1 - x;
	if (o.t & 2) y = sh - 1 - y;
	if (o.t & 4) [x, y] = [y, x];
	return [x, y];
}

/** A colour as it is shown (1 black, 2 white, 0 nothing). */
export function shownColor(o: Orient | null, c: number): number {
	return o?.swap && c ? 3 - c : c;
}

/** Text as it reads with the colours swapped: Black and White change places, capitals kept. */
export function swapWords(o: Orient | null, text: string): string {
	if (!o?.swap || !text) return text;
	const other: Record<string, string> = { black: 'white', white: 'black', BLACK: 'WHITE', WHITE: 'BLACK', Black: 'White', White: 'Black' };
	return text.replace(/\b(black|white)\b/gi, (word) => other[word] ?? (word.toLowerCase() === 'black' ? 'white' : 'black'));
}

function mapRect(o: Orient, r: Rect, w: number, h: number): Rect {
	const [ax, ay] = toShown(o, r.x0, r.y0, w, h);
	const [bx, by] = toShown(o, r.x1, r.y1, w, h);
	return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** The picture of a board, turned, mirrored and recoloured as `o` says. */
export function orientModel(m: Model, o: Orient): Model {
	const { w, h } = m;
	const [sw, sh] = shownSize(o, w, h);
	const at = (i: number): number => {
		const [x, y] = toShown(o, i % w, Math.floor(i / w), w, h);
		return y * sw + x;
	};
	const grid = new Uint8Array(sw * sh);
	for (let i = 0; i < m.grid.length; i++) grid[at(i)] = shownColor(o, m.grid[i]);
	const remap = <V>(src: Map<number, V>): Map<number, V> => new Map([...src].map(([i, v]) => [at(i), v]));
	return {
		...m,
		w: sw,
		h: sh,
		view: mapRect(o, m.view, w, h),
		crop: m.crop && mapRect(o, m.crop, w, h),
		grid,
		labels: remap(m.labels),
		marks: remap(m.marks),
		last: m.last >= 0 ? at(m.last) : -1,
		notes: m.notes.map((n) => ({ ...n, color: shownColor(o, n.color) as 1 | 2, atColor: shownColor(o, n.atColor) })),
		toPlay: shownColor(o, m.toPlay) as Model['toPlay'],
		hint: swapWords(o, m.hint),
		text: swapWords(o, m.text),
	};
}
