/*!
 * Territory scoring with seki and false eyes: goscorer by David J Wu ("lightvector"),
 * https://github.com/lightvector/goscorer (its JavaScript version at commit 0ac5f59), ported to
 * TypeScript for Kifu, with the board's points held as indexes. One departure: copying a set of
 * points makes a real copy, as goscorer's Python original does (the JavaScript one shared rows).
 *
 * Copyright 2024 David J Wu ("lightvector").
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/*
 * Japanese-style territory, given which stones are dead: an area that only one side's living
 * stones reach is that side's, unless the groups around it live in seki (then it is nobody's),
 * or the point is a false eye that would have to be filled. The passes, as in goscorer:
 * connection blocks (shapes of unfilled dame the opponent cannot push through), reachability,
 * regions, chains and macrochains (chains joined through dame), potential eyes, false eye
 * points, eye values (0 to 2, by heuristics), and the scoring itself.
 */

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

/** How each point scores, one array per field of goscorer's LocScore. */
export interface Scoring {
	/** EMPTY, BLACK or WHITE: whose territory the point is (dead stones' points included). */
	territory: Uint8Array;
	/** The colour of the seki the point's region lives in, or EMPTY. */
	seki: Uint8Array;
	falseEye: Uint8Array;
	unscorableFalseEye: Uint8Array;
	dame: Uint8Array;
	eyeValue: Uint8Array;
	/** The region (an area one side's living stones alone reach, with those stones) each point is in, or -1. */
	region: Int32Array;
}

interface Geo {
	w: number;
	h: number;
	n: number;
	/** The points next to each point, in goscorer's order: above, below, left, right. */
	nb: number[][];
}

interface RegionInfo {
	color: number;
	eyes: Set<number>;
}

interface ChainInfo {
	regionId: number;
	color: number;
	points: number[];
	liberties: Set<number>;
	isMarkedDead: boolean;
}

interface MacrochainInfo {
	regionId: number;
	color: number;
	points: number[];
	chains: Set<number>;
	/** By eye: this macrochain's points next to the eye. */
	eyeNeighborsFrom: Map<number, Set<number>>;
}

interface EyeInfo {
	pla: number;
	regionId: number;
	potentialPoints: Set<number>;
	realPoints: Set<number>;
	/** By macrochain: the eye's points next to it. */
	macrochainNeighborsFrom: Map<number, Set<number>>;
	isLoose: boolean;
	eyeValue: number;
}

interface EyePointInfo {
	adjPoints: number[];
	adjEyePoints: number[];
	numEmptyAdjPoints: number;
	numEmptyAdjFalsePoints: number;
	numEmptyAdjEyePoints: number;
	numOppAdjFalsePoints: number;
	isFalseEyePoke: boolean;
	numMovesToBlock: number;
}

function assert(condition: boolean, message = 'Assertion failed'): void {
	if (!condition) throw new Error(`goscorer: ${message}`);
}

/** The keys of a map with numbers for keys, smallest first (as goscorer's objects give them). */
function ascending<V>(map: Map<number, V>): number[] {
	return [...map.keys()].sort((a, b) => a - b);
}

/**
 * Whose territory each point of the board is. `stones`: 0 empty, 1 black, 2 white, by point
 * (index y * w + x); `markedDead`: non-zero where a stone is dead.
 */
export function territoryScoring(stones: Uint8Array, markedDead: Uint8Array, w: number, h: number): Scoring {
	const n = w * h;
	assert(stones.length === n && markedDead.length === n, 'board and marks of the wrong size');
	for (let i = 0; i < n; i++) assert(stones[i] <= WHITE, `unexpected value in stones ${stones[i]}`);
	const nb: number[][] = [];
	for (let i = 0; i < n; i++) {
		const x = i % w;
		const y = (i - x) / w;
		const a: number[] = [];
		if (y > 0) a.push(i - w);
		if (y < h - 1) a.push(i + w);
		if (x > 0) a.push(i - 1);
		if (x < w - 1) a.push(i + 1);
		nb.push(a);
	}
	const g: Geo = { w, h, n, nb };
	const dead = markedDead;

	const connectionBlocks = new Uint8Array(n);
	markConnectionBlocks(g, stones, dead, connectionBlocks);

	const strictReachesBlack = new Uint8Array(n);
	const strictReachesWhite = new Uint8Array(n);
	markReachability(g, stones, dead, null, strictReachesBlack, strictReachesWhite);

	const reachesBlack = new Uint8Array(n);
	const reachesWhite = new Uint8Array(n);
	markReachability(g, stones, dead, connectionBlocks, reachesBlack, reachesWhite);

	const regionIds = new Int32Array(n).fill(-1);
	const regions: RegionInfo[] = [];
	markRegions(g, stones, dead, connectionBlocks, reachesBlack, reachesWhite, regionIds, regions);

	const chainIds = new Int32Array(n).fill(-1);
	const chains: ChainInfo[] = [];
	markChains(g, stones, dead, regionIds, chainIds, chains);

	const macrochainIds = new Int32Array(n).fill(-1);
	const macrochains: MacrochainInfo[] = [];
	markMacrochains(g, stones, dead, connectionBlocks, regionIds, chainIds, chains, macrochainIds, macrochains);

	const eyeIds = new Int32Array(n).fill(-1);
	const eyes: EyeInfo[] = [];
	markPotentialEyes(g, stones, dead, strictReachesBlack, strictReachesWhite, regionIds, regions, macrochainIds, macrochains, eyeIds, eyes);

	const isFalseEyePoint = new Uint8Array(n);
	markFalseEyePoints(g, regionIds, macrochains, eyes, isFalseEyePoint);

	markEyeValues(g, stones, dead, chainIds, chains, isFalseEyePoint, eyes);

	const isUnscorableFalseEyePoint = new Uint8Array(n);
	markFalseEyePoints(g, regionIds, macrochains, eyes, isUnscorableFalseEyePoint);

	return markScoring(g, stones, dead, strictReachesBlack, strictReachesWhite, regionIds, regions, chainIds, chains, isFalseEyePoint, eyeIds, eyes, isUnscorableFalseEyePoint);
}

/* Shapes of dame the side `p` keeps connected: "@" the empty point that blocks, "p" a living
   stone of that side, "e" empty or that side's or a dead stone of the other, "?" anything, and a
   last row of "x" the board's edge. Each is tried in all eight orientations. */
const PATTERNS = [
	['pp', '@e', 'pe'],
	['ep?', 'e@e', 'ep?'],
	['pee', 'e@p', 'pee'],
	['?e?', 'p@p', 'xxx'],
	['pp', '@e', 'xx'],
	['ep?', 'e@e', 'xxx'],
];
const ORIENTATIONS = [
	[1, 0, 0, 1],
	[-1, 0, 0, 1],
	[1, 0, 0, -1],
	[-1, 0, 0, -1],
	[0, 1, 1, 0],
	[0, -1, 1, 0],
	[0, 1, -1, 0],
	[0, -1, -1, 0],
];

function markConnectionBlocks(g: Geo, stones: Uint8Array, dead: Uint8Array, connectionBlocks: Uint8Array): void {
	const { w, h } = g;
	const onBoard = (y: number, x: number): boolean => y >= 0 && x >= 0 && y < h && x < w;
	const all = (size: number): number[] => Array.from({ length: size }, (_, i) => i);
	for (const pla of [BLACK, WHITE]) {
		const opp = 3 - pla;
		for (const [pdydy, pdydx, pdxdy, pdxdx] of ORIENTATIONS) {
			for (const pattern of PATTERNS) {
				let pylen = pattern.length;
				const pxlen = pattern[0].length;
				const isEdgePattern = pattern[pylen - 1].includes('x');
				if (isEdgePattern) pylen--;
				let yRange = all(h);
				let xRange = all(w);
				if (isEdgePattern) {
					if (pdydy === -1) yRange = [pattern.length - 2];
					else if (pdydy === 1) yRange = [h - (pattern.length - 1)];
					else if (pdxdy === -1) xRange = [pattern.length - 2];
					else if (pdxdy === 1) xRange = [w - (pattern.length - 1)];
				}
				for (const y of yRange) {
					for (const x of xRange) {
						const ty0 = y + pdydy * (pylen - 1) + pdxdy * (pxlen - 1);
						const tx0 = x + pdydx * (pylen - 1) + pdxdx * (pxlen - 1);
						if (!onBoard(ty0, tx0) || !onBoard(y, x)) continue;
						let at = -1;
						let mismatch = false;
						for (let pdy = 0; pdy < pylen && !mismatch; pdy++) {
							for (let pdx = 0; pdx < pxlen; pdx++) {
								const c = pattern[pdy][pdx];
								if (c === '?') continue;
								const i = (y + pdydy * pdy + pdxdy * pdx) * w + (x + pdydx * pdy + pdxdx * pdx);
								if (c === 'p') {
									if (!(stones[i] === pla && !dead[i])) mismatch = true;
								} else if (c === 'e') {
									if (!(stones[i] === EMPTY || (stones[i] === pla && !dead[i]) || (stones[i] === opp && dead[i]))) mismatch = true;
								} else if (c === '@') {
									if (stones[i] !== EMPTY) mismatch = true;
									else at = i;
								} else {
									throw new Error(`goscorer: invalid pattern character ${c}`);
								}
								if (mismatch) break;
							}
						}
						if (!mismatch) connectionBlocks[at] = pla;
					}
				}
			}
		}
	}
}

function markReachability(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	connectionBlocks: Uint8Array | null,
	reachesBlack: Uint8Array,
	reachesWhite: Uint8Array,
): void {
	const stack: number[] = [];
	const fillReach = (start: number, reaches: Uint8Array, pla: number): void => {
		const opp = 3 - pla;
		stack.push(start);
		let i: number | undefined;
		while ((i = stack.pop()) !== undefined) {
			if (reaches[i]) continue;
			if (stones[i] === opp && !dead[i]) continue;
			reaches[i] = 1;
			if (connectionBlocks && connectionBlocks[i] === opp) continue;
			for (const j of g.nb[i]) stack.push(j);
		}
	};
	for (let i = 0; i < g.n; i++) {
		if (stones[i] === BLACK && !dead[i]) fillReach(i, reachesBlack, BLACK);
		if (stones[i] === WHITE && !dead[i]) fillReach(i, reachesWhite, WHITE);
	}
}

function markRegions(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	connectionBlocks: Uint8Array,
	reachesBlack: Uint8Array,
	reachesWhite: Uint8Array,
	regionIds: Int32Array,
	regions: RegionInfo[],
): void {
	// (which region's fill came by last: each fill has a visited set of its own in goscorer)
	const visited = new Int32Array(g.n).fill(-1);
	const fillRegion = (start: number, withId: number, opp: number, reachesPla: Uint8Array, reachesOpp: Uint8Array): void => {
		const stack = [start];
		let i: number | undefined;
		while ((i = stack.pop()) !== undefined) {
			if (visited[i] === withId) continue;
			if (regionIds[i] !== -1) continue;
			if (stones[i] === opp && !dead[i]) continue;
			visited[i] = withId;
			if (reachesPla[i] && !reachesOpp[i]) regionIds[i] = withId;
			if (connectionBlocks[i] === opp) continue;
			for (const j of g.nb[i]) stack.push(j);
		}
	};
	for (let i = 0; i < g.n; i++) {
		if (reachesBlack[i] && !reachesWhite[i] && regionIds[i] === -1) {
			const id = regions.length;
			regions.push({ color: BLACK, eyes: new Set() });
			fillRegion(i, id, WHITE, reachesBlack, reachesWhite);
		}
		if (reachesWhite[i] && !reachesBlack[i] && regionIds[i] === -1) {
			const id = regions.length;
			regions.push({ color: WHITE, eyes: new Set() });
			fillRegion(i, id, BLACK, reachesWhite, reachesBlack);
		}
	}
}

function markChains(g: Geo, stones: Uint8Array, dead: Uint8Array, regionIds: Int32Array, chainIds: Int32Array, chains: ChainInfo[]): void {
	for (let s = 0; s < g.n; s++) {
		if (chainIds[s] !== -1) continue;
		const id = chains.length;
		const color = stones[s];
		const isMarkedDead = !!dead[s];
		const chain: ChainInfo = { regionId: regionIds[s], color, points: [], liberties: new Set(), isMarkedDead };
		chains.push(chain);
		assert(isMarkedDead || color === EMPTY || regionIds[s] !== -1);
		const stack = [s];
		let i: number | undefined;
		while ((i = stack.pop()) !== undefined) {
			if (chainIds[i] === id) continue;
			if (chainIds[i] !== -1 || stones[i] !== color || !!dead[i] !== isMarkedDead) {
				if (stones[i] === EMPTY) chain.liberties.add(i);
				continue;
			}
			chainIds[i] = id;
			chain.points.push(i);
			if (chain.regionId !== regionIds[i]) chain.regionId = -1;
			assert(color === EMPTY || regionIds[i] === chain.regionId);
			for (const j of g.nb[i]) stack.push(j);
		}
	}
}

function markMacrochains(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	connectionBlocks: Uint8Array,
	regionIds: Int32Array,
	chainIds: Int32Array,
	chains: ChainInfo[],
	macrochainIds: Int32Array,
	macrochains: MacrochainInfo[],
): void {
	for (const pla of [BLACK, WHITE]) {
		const opp = 3 - pla;
		const chainsHandled = new Set<number>();
		const visited = new Uint8Array(g.n);
		for (let chainId = 0; chainId < chains.length; chainId++) {
			if (chainsHandled.has(chainId)) continue;
			const chain = chains[chainId];
			if (!(chain.color === pla && !chain.isMarkedDead)) continue;
			const regionId = chain.regionId;
			assert(regionId !== -1);
			const macrochainId = macrochains.length;
			const points: number[] = [];
			const members = new Set<number>();
			const stack = [chain.points[0]];
			let i: number | undefined;
			while ((i = stack.pop()) !== undefined) {
				if (visited[i]) continue;
				visited[i] = 1;
				let recurse = false;
				if (stones[i] === pla && !dead[i]) {
					macrochainIds[i] = macrochainId;
					points.push(i);
					members.add(chainIds[i]);
					chainsHandled.add(chainIds[i]);
					recurse = true;
				} else if (regionIds[i] === -1 && connectionBlocks[i] !== opp) {
					recurse = true;
				}
				if (recurse) for (const j of g.nb[i]) stack.push(j);
			}
			macrochains.push({ regionId, color: pla, points, chains: members, eyeNeighborsFrom: new Map() });
		}
	}
}

function markPotentialEyes(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	strictReachesBlack: Uint8Array,
	strictReachesWhite: Uint8Array,
	regionIds: Int32Array,
	regions: RegionInfo[],
	macrochainIds: Int32Array,
	macrochains: MacrochainInfo[],
	eyeIds: Int32Array,
	eyes: EyeInfo[],
): void {
	const visited = new Uint8Array(g.n);
	for (let s = 0; s < g.n; s++) {
		if (visited[s]) continue;
		if (eyeIds[s] !== -1) continue;
		if (stones[s] !== EMPTY && !dead[s]) continue;
		const regionId = regionIds[s];
		if (regionId === -1) continue;
		const pla = regions[regionId].color;
		const isLoose = !!(strictReachesWhite[s] && strictReachesBlack[s]);
		const eyeId = eyes.length;
		const potentialPoints = new Set<number>();
		const macrochainNeighborsFrom = new Map<number, Set<number>>();
		assert(macrochainIds[s] === -1);
		// (each point with the eye point it was reached from)
		const stack: [number, number][] = [[s, -1]];
		let top: [number, number] | undefined;
		while ((top = stack.pop()) !== undefined) {
			const [i, prev] = top;
			if (visited[i]) continue;
			if (regionIds[i] !== regionId) continue;
			const m = macrochainIds[i];
			if (m !== -1) {
				let from = macrochainNeighborsFrom.get(m);
				if (!from) macrochainNeighborsFrom.set(m, (from = new Set()));
				from.add(prev);
				const byEye = macrochains[m].eyeNeighborsFrom;
				let to = byEye.get(eyeId);
				if (!to) byEye.set(eyeId, (to = new Set()));
				to.add(i);
			}
			if (stones[i] !== EMPTY && !dead[i]) continue;
			visited[i] = 1;
			eyeIds[i] = eyeId;
			potentialPoints.add(i);
			for (const j of g.nb[i]) stack.push([j, i]);
		}
		eyes.push({ pla, regionId, potentialPoints, realPoints: new Set(), macrochainNeighborsFrom, isLoose, eyeValue: 0 });
		regions[regionId].eyes.add(eyeId);
	}
}

function isAdjacent(a: number, b: number, w: number): boolean {
	const ax = a % w;
	const bx = b % w;
	const ay = (a - ax) / w;
	const by = (b - bx) / w;
	return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

function markFalseEyePoints(g: Geo, regionIds: Int32Array, macrochains: MacrochainInfo[], eyes: EyeInfo[], isFalseEyePoint: Uint8Array): void {
	const none = new Set<number>();
	for (let origEyeId = 0; origEyeId < eyes.length; origEyeId++) {
		const origEyeInfo = eyes[origEyeId];
		for (const origMacrochainId of ascending(origEyeInfo.macrochainNeighborsFrom)) {
			const neighborsFromEyePoints = origEyeInfo.macrochainNeighborsFrom.get(origMacrochainId) ?? none;
			for (const e of neighborsFromEyePoints) {
				let sameEyeAdjCount = 0;
				for (const j of g.nb[e]) if (origEyeInfo.potentialPoints.has(j)) sameEyeAdjCount++;
				if (sameEyeAdjCount > 1) continue;

				const reachingSides = new Set<number>();
				const visitedMacro = new Set<number>();
				const visitedOtherEyes = new Set<number>();
				const visitedOrigEyePoints = new Set<number>([e]);
				let targetSideCount = 0;
				for (const j of g.nb[e]) if (regionIds[j] === origEyeInfo.regionId) targetSideCount++;

				const reachesSide = (p: number): boolean => {
					if (!isAdjacent(p, e, g.w)) return false;
					reachingSides.add(p);
					return reachingSides.size >= targetSideCount;
				};
				const search = (macrochainId: number): boolean => {
					if (visitedMacro.has(macrochainId)) return false;
					visitedMacro.add(macrochainId);
					const macrochainInfo = macrochains[macrochainId];
					for (const eyeId of ascending(macrochainInfo.eyeNeighborsFrom)) {
						if (visitedOtherEyes.has(eyeId)) continue;
						const eyeInfo = eyes[eyeId];
						if (eyeId === origEyeId) {
							for (const p of macrochainInfo.eyeNeighborsFrom.get(eyeId) ?? none) if (reachesSide(p)) return true;
							const pointsReached = findRecursivelyAdjacentPoints(g, eyeInfo.potentialPoints, eyeInfo.macrochainNeighborsFrom.get(macrochainId) ?? none, visitedOrigEyePoints);
							if (pointsReached.size === 0) continue;
							for (const p of pointsReached) visitedOrigEyePoints.add(p);
							if (eyeInfo.eyeValue > 0) for (const p of pointsReached) if (eyeInfo.realPoints.has(p)) return true;
							for (const p of pointsReached) if (reachesSide(p)) return true;
							for (const next of ascending(eyeInfo.macrochainNeighborsFrom)) {
								const from = eyeInfo.macrochainNeighborsFrom.get(next) ?? none;
								if ([...from].some((p) => pointsReached.has(p)) && search(next)) return true;
							}
						} else {
							visitedOtherEyes.add(eyeId);
							if (eyeInfo.eyeValue > 0) return true;
							for (const next of ascending(eyeInfo.macrochainNeighborsFrom)) if (search(next)) return true;
						}
					}
					return false;
				};
				if (!search(origMacrochainId)) isFalseEyePoint[e] = 1;
			}
		}
	}
}

function findRecursivelyAdjacentPoints(g: Geo, withinSet: Set<number>, fromPoints: Set<number>, excludingPoints: Set<number>): Set<number> {
	const expanded = new Set<number>();
	const queue = [...fromPoints];
	for (let k = 0; k < queue.length; k++) {
		const p = queue[k];
		if (excludingPoints.has(p) || expanded.has(p) || !withinSet.has(p)) continue;
		expanded.add(p);
		for (const j of g.nb[p]) queue.push(j);
	}
	return expanded;
}

/** The pieces `points` falls into, once `pointsToDelete` are taken out. */
function getPieces(g: Geo, points: Set<number>, pointsToDelete: Set<number>): Set<number>[] {
	const usedPoints = new Set<number>();
	const pieces: Set<number>[] = [];
	for (const start of points) {
		if (usedPoints.has(start)) continue;
		const piece = new Set<number>();
		const stack = [start];
		let p: number | undefined;
		while ((p = stack.pop()) !== undefined) {
			if (usedPoints.has(p) || pointsToDelete.has(p)) continue;
			usedPoints.add(p);
			piece.add(p);
			for (const j of g.nb[p]) if (points.has(j)) stack.push(j);
		}
		if (piece.size > 0) pieces.push(piece);
	}
	return pieces;
}

function isPseudoLegal(g: Geo, stones: Uint8Array, chainIds: Int32Array, chains: ChainInfo[], i: number, pla: number): boolean {
	if (stones[i] !== EMPTY) return false;
	const opp = 3 - pla;
	for (const j of g.nb[i]) {
		if (stones[j] !== opp) return true;
		if (chains[chainIds[j]].liberties.size <= 1) return true;
	}
	return false;
}

function countAdjacentsIn(g: Geo, i: number, points: Set<number>): number {
	let c = 0;
	for (const j of g.nb[i]) if (points.has(j)) c++;
	return c;
}

function markEyeValues(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	chainIds: Int32Array,
	chains: ChainInfo[],
	isFalseEyePoint: Uint8Array,
	eyes: EyeInfo[],
): void {
	const { w, h } = g;
	const onBorder = (i: number): boolean => {
		const x = i % w;
		const y = (i - x) / w;
		return y === 0 || x === 0 || y === h - 1 || x === w - 1;
	};
	for (const eyeInfo of eyes) {
		const pla = eyeInfo.pla;
		const opp = 3 - pla;

		const infoByPoint = new Map<number, EyePointInfo>();
		eyeInfo.realPoints = new Set();
		for (const p of eyeInfo.potentialPoints) {
			if (isFalseEyePoint[p]) continue;
			eyeInfo.realPoints.add(p);
			infoByPoint.set(p, {
				adjPoints: [],
				adjEyePoints: [],
				numEmptyAdjPoints: 0,
				numEmptyAdjFalsePoints: 0,
				numEmptyAdjEyePoints: 0,
				numOppAdjFalsePoints: 0,
				isFalseEyePoke: false,
				numMovesToBlock: 0,
			});
		}
		const real = eyeInfo.realPoints;
		const info = (p: number): EyePointInfo => {
			const i = infoByPoint.get(p);
			if (!i) throw new Error('goscorer: no information on a point of an eye');
			return i;
		};

		for (const p of real) {
			const pi = info(p);
			for (const a of g.nb[p]) {
				pi.adjPoints.push(a);
				if (real.has(a)) pi.adjEyePoints.push(a);
			}
		}

		for (const p of real) {
			const pi = info(p);
			for (const a of pi.adjPoints) {
				if (stones[a] === EMPTY) pi.numEmptyAdjPoints++;
				if (stones[a] === EMPTY && real.has(a)) pi.numEmptyAdjEyePoints++;
				if (stones[a] === EMPTY && isFalseEyePoint[a]) pi.numEmptyAdjFalsePoints++;
				if (stones[a] === opp && isFalseEyePoint[a]) pi.numOppAdjFalsePoints++;
			}
			if (pi.numOppAdjFalsePoints > 0 && stones[p] === opp) pi.isFalseEyePoke = true;
			if (pi.numEmptyAdjFalsePoints >= 2 && stones[p] === opp) pi.isFalseEyePoke = true;
		}

		for (const p of real) {
			const pi = info(p);
			pi.numMovesToBlock = 0;
			for (const a of pi.adjPoints) {
				const ai = infoByPoint.get(a);
				let block = 0;
				if (stones[a] === EMPTY && !real.has(a)) block = 1;
				if (stones[a] === EMPTY && ai && ai.numOppAdjFalsePoints >= 1) block = 1;
				if (stones[a] === opp && ai && ai.numEmptyAdjFalsePoints >= 1) block = 1;
				if (stones[a] === opp && isFalseEyePoint[a]) block = 1000;
				if (stones[a] === opp && ai && ai.isFalseEyePoke) block = 1000;
				pi.numMovesToBlock += block;
			}
		}

		const count = (pred: (p: number) => boolean): number => {
			let c = 0;
			for (const p of real) if (pred(p)) c++;
			return c;
		};

		let eyeValue = 0;
		if (count((p) => info(p).numMovesToBlock <= 1) >= 1) eyeValue = 1;

		for (const d of real) {
			if (!isPseudoLegal(g, stones, chainIds, chains, d, pla)) continue;
			const pieces = getPieces(g, real, new Set([d]));
			if (pieces.length < 2) continue;
			const shouldBonus = info(d).numOppAdjFalsePoints === 1;
			let numDefiniteEyePieces = 0;
			for (const piece of pieces) {
				let zeroMovesToBlock = false;
				for (const p of piece) {
					const pi = info(p);
					if (pi.numMovesToBlock <= 0 || (shouldBonus && pi.numMovesToBlock <= 1)) {
						zeroMovesToBlock = true;
						break;
					}
				}
				if (zeroMovesToBlock) numDefiniteEyePieces++;
			}
			eyeValue = Math.max(eyeValue, numDefiniteEyePieces);
		}

		const markedDeadCount = count((p) => stones[p] === opp && !!dead[p]);
		if (markedDeadCount >= 5) eyeValue = Math.max(eyeValue, 1);
		if (markedDeadCount >= 8) eyeValue = Math.max(eyeValue, 2);

		if (
			eyeValue < 2 &&
			real.size -
				count((p) => info(p).numMovesToBlock >= 1) -
				count((p) => info(p).numMovesToBlock >= 2) -
				count((p) => stones[p] === opp && info(p).adjEyePoints.length >= 2) >=
				6
		) {
			eyeValue = Math.max(eyeValue, 2);
		}

		if (
			eyeValue < 2 &&
			count((p) => stones[p] === EMPTY && info(p).adjEyePoints.length >= 4) + count((p) => stones[p] === EMPTY && info(p).adjEyePoints.length >= 3) >= 6
		) {
			eyeValue = Math.max(eyeValue, 2);
		}

		if (eyeValue < 2) {
			for (const d of real) {
				if (stones[d] !== EMPTY) continue;
				if (onBorder(d)) continue;
				if (!isPseudoLegal(g, stones, chainIds, chains, d, pla)) continue;
				const info1 = info(d);
				if (info1.numMovesToBlock > 1 || info1.adjEyePoints.length < 3) continue;
				for (const adjacent of info1.adjEyePoints) {
					const info2 = info(adjacent);
					if (info2.adjEyePoints.length < 3) continue;
					if (info2.numMovesToBlock > 1) continue;
					if (stones[adjacent] !== EMPTY && info2.numEmptyAdjEyePoints <= 1) continue;
					const pieces = getPieces(g, real, new Set([d, adjacent]));
					if (pieces.length < 2) continue;
					let numDefiniteEyePieces = 0;
					let numDoubleDefiniteEyePieces = 0;
					for (const piece of pieces) {
						let numZeroMovesToBlock = 0;
						for (const p of piece) {
							if (info(p).numMovesToBlock <= 0) {
								numZeroMovesToBlock++;
								if (numZeroMovesToBlock >= 2) break;
							}
						}
						if (numZeroMovesToBlock >= 1) numDefiniteEyePieces++;
						if (numZeroMovesToBlock >= 2) numDoubleDefiniteEyePieces++;
					}
					if (numDefiniteEyePieces >= 2 && numDoubleDefiniteEyePieces >= 1 && (stones[adjacent] === EMPTY || numDoubleDefiniteEyePieces >= 2)) {
						eyeValue = Math.max(eyeValue, 2);
						break;
					}
				}
				if (eyeValue >= 2) break;
			}
		}

		if (eyeValue < 2) {
			const deadOppsInEye = new Set<number>();
			const unplayableInEye: number[] = [];
			for (const p of real) {
				if (stones[p] === opp && dead[p]) deadOppsInEye.add(p);
				else if (!isPseudoLegal(g, stones, chainIds, chains, p, pla)) unplayableInEye.push(p);
			}
			if (deadOppsInEye.size > 0) {
				let numThrowins = 0;
				for (const p of eyeInfo.potentialPoints) if (stones[p] === opp && isFalseEyePoint[p]) numThrowins++;
				// (each unplayable point left out in turn, and then none)
				const possibleOmissions = [...unplayableInEye, -1];
				let allGoodForDefender = true;
				for (const omitted of possibleOmissions) {
					const remainingShape = new Set(deadOppsInEye);
					for (const p of unplayableInEye) if (p !== omitted) remainingShape.add(p);
					const initialPieceCount = getPieces(g, remainingShape, new Set()).length;
					let numBottlenecks = 0;
					let numNonBottlenecksHighDegree = 0;
					for (const pointToDelete of remainingShape) {
						if (getPieces(g, remainingShape, new Set([pointToDelete])).length > initialPieceCount) numBottlenecks++;
						else if (countAdjacentsIn(g, pointToDelete, remainingShape) >= 3) numNonBottlenecksHighDegree++;
					}
					let bonus = 0;
					if (remainingShape.size >= 7) bonus += 1;
					if (initialPieceCount - numThrowins + Math.floor((numBottlenecks + numNonBottlenecksHighDegree + bonus) / 2) < 2) {
						allGoodForDefender = false;
						break;
					}
				}
				if (allGoodForDefender) eyeValue = 2;
			}
		}

		eyeInfo.eyeValue = Math.min(eyeValue, 2);
	}
}

function markScoring(
	g: Geo,
	stones: Uint8Array,
	dead: Uint8Array,
	strictReachesBlack: Uint8Array,
	strictReachesWhite: Uint8Array,
	regionIds: Int32Array,
	regions: RegionInfo[],
	chainIds: Int32Array,
	chains: ChainInfo[],
	isFalseEyePoint: Uint8Array,
	eyeIds: Int32Array,
	eyes: EyeInfo[],
	isUnscorableFalseEyePoint: Uint8Array,
): Scoring {
	const n = g.n;
	const out: Scoring = {
		territory: new Uint8Array(n),
		seki: new Uint8Array(n),
		falseEye: new Uint8Array(n),
		unscorableFalseEye: new Uint8Array(n),
		dame: new Uint8Array(n),
		eyeValue: new Uint8Array(n),
		region: regionIds,
	};
	const extraBlackUnscoreablePoints = new Set<number>();
	const extraWhiteUnscoreablePoints = new Set<number>();
	for (let i = 0; i < n; i++) {
		if (isUnscorableFalseEyePoint[i] && stones[i] !== EMPTY && dead[i]) {
			const extra = stones[i] === WHITE ? extraBlackUnscoreablePoints : extraWhiteUnscoreablePoints;
			for (const j of g.nb[i]) extra.add(j);
		}
	}
	for (let i = 0; i < n; i++) {
		const regionId = regionIds[i];
		if (regionId === -1) {
			out.dame[i] = 1;
			continue;
		}
		const regionInfo = regions[regionId];
		const color = regionInfo.color;
		let totalEyes = 0;
		for (const eyeId of regionInfo.eyes) totalEyes += eyes[eyeId].eyeValue;
		if (totalEyes <= 1) out.seki[i] = color;
		if (isFalseEyePoint[i]) out.falseEye[i] = 1;
		let unscorable = !!isUnscorableFalseEyePoint[i];
		if (
			(stones[i] === EMPTY || dead[i]) &&
			((color === BLACK && extraBlackUnscoreablePoints.has(i)) || (color === WHITE && extraWhiteUnscoreablePoints.has(i)))
		) {
			unscorable = true;
		}
		if (unscorable) out.unscorableFalseEye[i] = 1;
		out.eyeValue[i] = eyeIds[i] !== -1 ? eyes[eyeIds[i]].eyeValue : 0;
		if (
			(stones[i] !== color || dead[i]) &&
			out.seki[i] === EMPTY &&
			!unscorable &&
			chains[chainIds[i]].regionId === regionId &&
			!(color === WHITE && strictReachesBlack[i]) &&
			!(color === BLACK && strictReachesWhite[i])
		) {
			out.territory[i] = color;
		}
	}
	return out;
}
