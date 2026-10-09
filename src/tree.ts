/** Lays a game tree out on a grid: moves run downwards, variations branch off to the right. */

import { SgfNode } from './sgf';

export interface TreeLayout {
	cols: number;
	rows: number;
	count: number;
	/** Grid position of every node, as row * STRIDE + col. */
	at: Map<SgfNode, number>;
	cells: Map<number, SgfNode>;
}

export const STRIDE = 4096;

export function layoutTree(root: SgfNode): TreeLayout {
	const at = new Map<SgfNode, number>();
	const cells = new Map<number, SgfNode>();
	/** First free column in each row. */
	const free: number[] = [];
	let cols = 0;

	// Each job places one straight run of first-children, then queues the
	// variations hanging off it. Variations of deeper moves are placed first,
	// which keeps the connecting lines from crossing anything.
	const jobs: [SgfNode, number, number][] = [[root, 0, 0]];
	while (jobs.length) {
		const [first, row, minCol] = jobs.pop() as [SgfNode, number, number];
		const run: SgfNode[] = [];
		for (let n: SgfNode | undefined = first; n; n = n.children[0]) run.push(n);
		let col = minCol;
		for (let r = Math.max(0, row - 1); r < row + run.length; r++) {
			const f = free[r] ?? 0;
			if (f > col) col = f;
		}
		for (let k = 0; k < run.length; k++) {
			const r = row + k;
			at.set(run[k], r * STRIDE + col);
			cells.set(r * STRIDE + col, run[k]);
			free[r] = col + 1;
		}
		// keep the branch line's path along the parent's row clear
		if (row > 0 && (free[row - 1] ?? 0) < col) free[row - 1] = col;
		if (col + 1 > cols) cols = col + 1;
		// (pushed shallowest first, so the deepest is popped — and placed — first)
		for (let k = 0; k < run.length; k++) {
			const kids = run[k].children;
			for (let j = kids.length - 1; j >= 1; j--) jobs.push([kids[j], row + k + 1, col + 1]);
		}
	}
	return { cols, rows: free.length, count: at.size, at, cells };
}

/** The same for one line of play only: its nodes in a single column. */
export function layoutLine(path: SgfNode[]): TreeLayout {
	const at = new Map<SgfNode, number>();
	const cells = new Map<number, SgfNode>();
	path.forEach((n, row) => {
		at.set(n, row * STRIDE);
		cells.set(row * STRIDE, n);
	});
	return { cols: 1, rows: path.length, count: path.length, at, cells };
}
