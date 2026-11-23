/**
 * Territory worked out from a position: which stones are dead, and whose territory each point is.
 *
 * Dead stones are a guess from random games played out from the position, a hundred of them, with
 * the rules of Sabaki's deadstones (MIT, github.com/SabakiHQ/deadstones): no filling one's own
 * eye, no suicide, no retaking a ko at once; a stone ends up dead when its chain mostly belongs to
 * the other side at the end of the games. Then, as deadstones does for a finished game, stones of
 * one colour that reach each other through empty points go together, by a majority. Unlike
 * deadstones there is no first pass for "floating" stones (where a border is still open it takes
 * living groups for dead); groups that plainly live (two or more areas, or five points, that only
 * they border) stay out of the games, as OGS's estimator does; and the games are seeded from the
 * position, so the same board gets the same answer every time.
 *
 * Territory, once the dead stones are known, is goscorer's (see goscorer.ts): a seki's eyes and
 * false eyes count for nobody.
 */

import { territoryScoring } from './goscorer';
import type { Rect } from './options';

/** Random games played out to guess the dead stones. */
const PLAYOUTS = 100;

/** A board's points and their neighbours, with scratch space for walking groups. */
interface Geo {
	n: number;
	/** Up to four neighbours of each point, at 4 * point. */
	nb: Int32Array;
	cnt: Uint8Array;
	stamp: Int32Array;
	gen: number;
	stack: Int32Array;
}

function geometry(w: number, h: number): Geo {
	const n = w * h;
	const nb = new Int32Array(n * 4);
	const cnt = new Uint8Array(n);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = y * w + x;
			let k = 0;
			if (y > 0) nb[v * 4 + k++] = v - w;
			if (y < h - 1) nb[v * 4 + k++] = v + w;
			if (x > 0) nb[v * 4 + k++] = v - 1;
			if (x < w - 1) nb[v * 4 + k++] = v + 1;
			cnt[v] = k;
		}
	}
	return { n, nb, cnt, stamp: new Int32Array(n), gen: 0, stack: new Int32Array(n) };
}

/* The games are played on signs: 1 black, -1 white, 0 empty. */

/** Does the chain at `v` have a liberty? */
function hasLiberty(b: Int8Array, v: number, G: Geo): boolean {
	const s = b[v];
	const gen = ++G.gen;
	const st = G.stack;
	let top = 0;
	st[top++] = v;
	G.stamp[v] = gen;
	while (top) {
		const p = st[--top];
		for (let k = 0; k < G.cnt[p]; k++) {
			const q = G.nb[p * 4 + k];
			const c = b[q];
			if (c === 0) return true;
			if (c === s && G.stamp[q] !== gen) {
				G.stamp[q] = gen;
				st[top++] = q;
			}
		}
	}
	return false;
}

/** The points joined to `v` through points whose value passes `ok`. */
function component(b: Int8Array, v: number, ok: (c: number) => boolean, G: Geo): number[] {
	const gen = ++G.gen;
	const out = [v];
	G.stamp[v] = gen;
	for (let i = 0; i < out.length; i++) {
		const p = out[i];
		for (let k = 0; k < G.cnt[p]; k++) {
			const q = G.nb[p * 4 + k];
			if (G.stamp[q] !== gen && ok(b[q])) {
				G.stamp[q] = gen;
				out.push(q);
			}
		}
	}
	return out;
}

const chainOf = (b: Int8Array, v: number, G: Geo): number[] => {
	const s = b[v];
	return component(b, v, (c) => c === s, G);
};

/** xorshift128, as deadstones has it. */
class Rand {
	private x: number;
	private y: number;
	private z = 521288629;
	private w = 88675123;

	constructor(seed: number) {
		this.x = (123456789 ^ seed) >>> 0;
		this.y = (362436069 ^ seed) >>> 0;
	}

	next(): number {
		const t = (this.x ^ (this.x << 11)) >>> 0;
		this.x = this.y;
		this.y = this.z;
		this.z = this.w;
		this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
		return this.w;
	}

	below(m: number): number {
		return m ? this.next() % m : 0;
	}
}

/** A seed from the position (FNV-1a), so that the same board always gets the same games. */
function seedOf(grid: Uint8Array, w: number, h: number): number {
	let s = 2166136261;
	const mix = (v: number): void => {
		s ^= v;
		s = Math.imul(s, 16777619) >>> 0;
	};
	mix(w);
	mix(h);
	for (let i = 0; i < grid.length; i++) mix(grid[i]);
	return s;
}

/**
 * A move of the random games: none on a point whose neighbours are all one's own (an eye),
 * no suicide, and no lone stone taking a lone stone (a ko). Returns the points freed, or null
 * when the move may not be made.
 */
function pseudoMove(b: Int8Array, sign: number, v: number, G: Geo): number[] | null {
	let allOwn = true;
	for (let k = 0; k < G.cnt[v]; k++) {
		if (b[G.nb[v * 4 + k]] !== sign) {
			allOwn = false;
			break;
		}
	}
	if (allOwn) return null;
	b[v] = sign;
	let lone = false;
	let check = false;
	if (!hasLiberty(b, v, G)) {
		let own = false;
		for (let k = 0; k < G.cnt[v]; k++) if (b[G.nb[v * 4 + k]] === sign) own = true;
		if (own) check = true;
		else lone = true;
	}
	const freed: number[] = [];
	for (let k = 0; k < G.cnt[v]; k++) {
		const q = G.nb[v * 4 + k];
		if (b[q] !== -sign || hasLiberty(b, q, G)) continue;
		for (const c of chainOf(b, q, G)) {
			b[c] = 0;
			freed.push(c);
		}
	}
	if ((lone && freed.length <= 1) || (check && freed.length === 0)) {
		for (const d of freed) b[d] = -sign;
		b[v] = 0;
		return null;
	}
	return freed;
}

/** One random game to its end (both pass), its empty points then given to a neighbouring stone's side. */
function playOut(src: Int8Array, sign: number, rnd: Rand, G: Geo, excluded: Uint8Array): Int8Array {
	const b = Int8Array.from(src);
	const n = b.length;
	const free: number[] = [];
	const illegal: number[] = [];
	for (let v = 0; v < n; v++) if (b[v] === 0 && !excluded[v]) free.push(v);
	let passes = 0;
	let moves = 0;
	while (free.length && passes < 2 && moves < n * 10) {
		let made = false;
		while (free.length) {
			const i = rnd.below(free.length);
			const v = free[i];
			free[i] = free[free.length - 1];
			free.pop();
			const freed = pseudoMove(b, sign, v, G);
			if (freed) {
				for (const f of freed) free.push(f);
				made = true;
				moves++;
				break;
			}
			illegal.push(v);
		}
		passes = made ? 0 : passes + 1;
		for (const v of illegal) free.push(v);
		illegal.length = 0;
		sign = -sign;
	}
	for (let v = 0; v < n; v++) {
		if (b[v] !== 0) continue;
		for (let k = 0; k < G.cnt[v]; k++) {
			const c = b[G.nb[v * 4 + k]];
			if (c !== 0) {
				b[v] = c;
				break;
			}
		}
	}
	return b;
}

/**
 * Groups that plainly live, left out of the random games: a colour's stones joined through the
 * empty areas only that colour borders, when there are two or more such areas, or five points of
 * them. Returns those stones, and those areas (no move is made there).
 */
function strongLife(b: Int8Array, G: Geo): { strong: Uint8Array; excluded: Uint8Array } {
	const n = b.length;
	const regionOwner = new Int8Array(n);
	const regionId = new Int32Array(n).fill(-1);
	const regionSize: number[] = [];
	for (let v = 0; v < n; v++) {
		if (b[v] !== 0 || regionId[v] >= 0) continue;
		const region = component(b, v, (c) => c === 0, G);
		let seen = 0;
		for (const p of region) {
			regionId[p] = regionSize.length;
			for (let k = 0; k < G.cnt[p]; k++) {
				const c = b[G.nb[p * 4 + k]];
				if (c) seen |= c === 1 ? 1 : 2;
			}
		}
		const owner = seen === 1 ? 1 : seen === 2 ? -1 : 0;
		for (const p of region) regionOwner[p] = owner;
		regionSize.push(region.length);
	}
	const strong = new Uint8Array(n);
	const excluded = new Uint8Array(n);
	const done = new Uint8Array(n);
	for (let v = 0; v < n; v++) {
		if (b[v] === 0 || done[v]) continue;
		const s = b[v];
		const unit = component(b, v, (c) => c === s, G);
		// grown through the areas only this colour borders
		const gen = ++G.gen;
		const out = [...unit];
		for (const p of out) G.stamp[p] = gen;
		for (let i = 0; i < out.length; i++) {
			const p = out[i];
			for (let k = 0; k < G.cnt[p]; k++) {
				const q = G.nb[p * 4 + k];
				if (G.stamp[q] === gen) continue;
				if (b[q] === s || (b[q] === 0 && regionOwner[q] === s)) {
					G.stamp[q] = gen;
					out.push(q);
				}
			}
		}
		const regions = new Set<number>();
		let points = 0;
		for (const p of out) {
			if (b[p] === s) done[p] = 1;
			else if (!regions.has(regionId[p])) {
				regions.add(regionId[p]);
				points += regionSize[regionId[p]];
			}
		}
		if (regions.size >= 2 || points >= 5) {
			for (const p of out) {
				if (b[p] === s) strong[p] = 1;
				else excluded[p] = 1;
			}
		}
	}
	return { strong, excluded };
}

const signs = (grid: Uint8Array): Int8Array => Int8Array.from(grid, (c) => (c === 1 ? 1 : c === 2 ? -1 : 0));

/**
 * Random games played out from the position: how far each point leaned to black (towards 1)
 * or white (towards -1) at their end, by how often it was whose.
 */
function playedOut(b: Int8Array, G: Geo, playouts: number, seed: number, excluded: Uint8Array): Float64Array {
	const n = b.length;
	const rnd = new Rand(seed);
	const blacks = new Int32Array(n);
	const whites = new Int32Array(n);
	for (let i = 0; i < playouts; i++) {
		const a = playOut(b, i < Math.floor(playouts / 2) ? -1 : 1, rnd, G, excluded);
		for (let v = 0; v < n; v++) {
			if (a[v] === 1) blacks[v]++;
			else if (a[v] === -1) whites[v]++;
		}
	}
	const lean = new Float64Array(n);
	for (let v = 0; v < n; v++) {
		const all = blacks[v] + whites[v];
		if (all) lean[v] = (blacks[v] * 2) / all - 1;
	}
	return lean;
}

/**
 * Who each point is likely to be whose (1 black, -1 white, 0 no one), for the parts of a game
 * not settled yet: Bouzy's dilations and erosions (Bruno Bouzy's "5/21" operators, as GNU Go's
 * manual describes them), five and ten, the setting GNU Go calls moyo, on the position with the
 * dead stones taken off. Each stone starts at 128, plus for black and minus for white. A
 * dilation adds to a point, when none of its neighbours is the other side's, the number of its
 * neighbours that are its side's (an empty point next to one side's only joins it); an erosion
 * takes from a point the number of its neighbours that are not its side's, down to nothing.
 * What one side's stones surround, and nothing of the other's comes near, is left with it.
 */
export function influence(grid: Uint8Array, dead: Uint8Array, w: number, h: number, dilations = 5, erosions = 10): Int8Array {
	const n = w * h;
	const G = geometry(w, h);
	let v = Int32Array.from(grid, (c, i) => (dead[i] ? 0 : c === 1 ? 128 : c === 2 ? -128 : 0));
	for (let k = 0; k < dilations; k++) {
		const next = v.slice();
		for (let p = 0; p < n; p++) {
			let plus = 0;
			let minus = 0;
			for (let j = 0; j < G.cnt[p]; j++) {
				const q = v[G.nb[p * 4 + j]];
				if (q > 0) plus++;
				else if (q < 0) minus++;
			}
			if (v[p] >= 0 && minus === 0) next[p] += plus;
			if (v[p] <= 0 && plus === 0) next[p] -= minus;
		}
		v = next;
	}
	for (let k = 0; k < erosions; k++) {
		const next = v.slice();
		for (let p = 0; p < n; p++) {
			if (v[p] === 0) continue;
			let against = 0;
			for (let j = 0; j < G.cnt[p]; j++) {
				const q = v[G.nb[p * 4 + j]];
				if (v[p] > 0 ? q <= 0 : q >= 0) against++;
			}
			next[p] = v[p] > 0 ? Math.max(0, v[p] - against) : Math.min(0, v[p] + against);
		}
		v = next;
	}
	return Int8Array.from(v, (x) => Math.sign(x));
}

/**
 * A guess at which stones are dead (1 where one is). `grid`: 0 empty, 1 black, 2 white. The
 * games are seeded from the position unless a `seed` is given.
 */
export function guessDead(grid: Uint8Array, w: number, h: number, playouts = PLAYOUTS, seed = seedOf(grid, w, h)): Uint8Array {
	const n = w * h;
	const G = geometry(w, h);
	const b = signs(grid);
	const out = new Uint8Array(n);
	if (!b.some((c) => c !== 0)) return out;
	const { strong, excluded } = strongLife(b, G);
	const lean = playedOut(b, G, playouts, seed, excluded);
	// a chain mostly the other side's at the end is dead (by the mean of its stones' leaning)
	const dead = new Uint8Array(n);
	const done = new Uint8Array(n);
	for (let v = 0; v < n; v++) {
		if (b[v] === 0 || done[v]) continue;
		const chain = chainOf(b, v, G);
		let sum = 0;
		for (const c of chain) {
			done[c] = 1;
			sum += lean[c];
		}
		if (!strong[v] && (sum / chain.length) * b[v] < 0) for (const c of chain) dead[c] = 1;
	}
	// stones that reach each other through empty points live or die together, by a majority
	const voted = new Uint8Array(n);
	for (let v = 0; v < n; v++) {
		if (!dead[v] || voted[v]) continue;
		const s = b[v];
		const related = component(b, v, (c) => c === s || c === 0, G).filter((x) => b[x] === s);
		const deadCount = related.filter((x) => dead[x]).length;
		for (const r of related) {
			voted[r] = 1;
			if (deadCount * 2 > related.length) out[r] = 1;
		}
	}
	return out;
}

/** The stones of the chain at `i`. */
export function chainAt(grid: Uint8Array, i: number, w: number, h: number): number[] {
	return grid[i] ? chainOf(signs(grid), i, geometry(w, h)) : [];
}

/** The stones of `i`'s colour that it reaches through its own stones and empty points (where a click toggles dead or alive). */
export function relatedStones(grid: Uint8Array, i: number, w: number, h: number): number[] {
	const s = grid[i];
	if (!s) return [];
	return component(Int8Array.from(grid), i, (c) => c === s || c === 0, geometry(w, h)).filter((x) => grid[x] === s);
}

/**
 * Whose territory each point is: 0 nobody's, 1 black's, 2 white's, the points of dead stones
 * with the side that took them. Where one side's living stones alone reach, goscorer decides;
 * where both can still reach (a game not over: everything but what is walled in), `estimate`
 * does, if given (see influence). Territory that runs out of `window` (the part of the board
 * shown, when it is not all of it) counts for nobody; and while one colour has no living stones
 * at all, nothing does but the dead stones (an empty board around a few stones is no one's).
 */
export function territoryMap(grid: Uint8Array, dead: Uint8Array, w: number, h: number, window: Rect | null = null, estimate: Int8Array | null = null): Uint8Array {
	const n = w * h;
	const out = new Uint8Array(n);
	let blackLives = false;
	let whiteLives = false;
	for (let i = 0; i < n; i++) {
		if (!grid[i] || dead[i]) continue;
		if (grid[i] === 1) blackLives = true;
		else whiteLives = true;
	}
	if (blackLives && whiteLives) {
		const s = territoryScoring(grid, dead, w, h);
		// Regions still open: next to a point that both sides can reach but the estimate gives to
		// one. Their groups are not finished, so what goscorer makes of their eyes (seki, false
		// eyes) is not final either: the estimate decides there too. (A real seki is walled in:
		// its shared liberties touch both sides, which the estimate gives to no one.)
		const open = new Set<number>();
		if (estimate) {
			const G = geometry(w, h);
			for (let i = 0; i < n; i++) {
				const r = s.region[i];
				if (r < 0 || open.has(r)) continue;
				for (let k = 0; k < G.cnt[i]; k++) {
					const j = G.nb[i * 4 + k];
					if (s.region[j] < 0 && !grid[j] && estimate[j]) {
						open.add(r);
						break;
					}
				}
			}
		}
		for (let i = 0; i < n; i++) {
			if (grid[i]) continue;
			if (s.territory[i]) out[i] = s.territory[i];
			// not settled (both sides can still reach it, or its region is open): the estimate's
			else if (estimate && estimate[i] && (s.dame[i] || open.has(s.region[i]))) out[i] = estimate[i] > 0 ? 1 : 2;
		}
	}
	for (let i = 0; i < n; i++) if (grid[i] && dead[i]) out[i] = 3 - grid[i];
	if (window && !(window.x0 <= 0 && window.y0 <= 0 && window.x1 >= w - 1 && window.y1 >= h - 1)) {
		// (an area of one side's points, its dead stones in it, that leaves the window: its
		// empty points count for nobody; the dead stones stay dead)
		const G = geometry(w, h);
		const inside = (i: number): boolean => {
			const x = i % w;
			const y = (i - x) / w;
			return x >= window.x0 && x <= window.x1 && y >= window.y0 && y <= window.y1;
		};
		const owners = Int8Array.from(out);
		const seen = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			if (!owners[i] || seen[i]) continue;
			const c = owners[i];
			const area = component(owners, i, (v) => v === c, G);
			for (const p of area) seen[p] = 1;
			if (area.some((p) => !inside(p))) for (const p of area) if (!grid[p]) out[p] = 0;
		}
	}
	return out;
}

/** The dead stones that territory marks say: a stone on a point of the other side's territory. */
export function deadFromMarks(grid: Uint8Array, owner: Uint8Array): Uint8Array {
	return Uint8Array.from(grid, (c, i) => (c && owner[i] === 3 - c ? 1 : 0));
}
