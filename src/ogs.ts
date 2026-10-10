/**
 * Importing from OGS (online-go.com): games and reviews come from its public API as SGF,
 * puzzles as JSON that is turned into SGF here. (The requests themselves are made by the
 * plugin, only when the import command is used; this is plain work on what came back.)
 */

import { Fetched, ImportError } from './importing';
import { SgfNode, escapeText, eachNode, getText, newNode, parseSgf, serializeSgf, setText, xy2pt } from './sgf';

export type OgsKind = 'game' | 'review' | 'puzzle';

export interface OgsTarget {
	kind: OgsKind;
	id: number;
}

const SITE = 'https://online-go.com/';
const API = 'https://online-go.com/api/v1/';

/**
 * What was typed: a link to a game, review (or demo board) or puzzle, which says which
 * it is; or a bare number, which is taken to be of kind `kind`.
 */
export function ogsTarget(input: string, kind: OgsKind): OgsTarget | null {
	const s = input.trim();
	const bare = /^#?(\d+)$/.exec(s);
	if (bare) return parseInt(bare[1]) > 0 ? { kind, id: parseInt(bare[1]) } : null;
	const m = /online-go\.com\/(game(?:\/view)?|review|demo(?:\/view)?|puzzle)\/(\d+)/i.exec(s);
	if (!m || !(parseInt(m[2]) > 0)) return null;
	const what = m[1].toLowerCase();
	return { kind: what.startsWith('game') ? 'game' : what === 'puzzle' ? 'puzzle' : 'review', id: parseInt(m[2]) };
}

export const ogsPage = (t: OgsTarget): string => `${SITE}${t.kind}/${t.id}`;

export const ogsApi = (t: OgsTarget): string =>
	t.kind === 'puzzle' ? `${API}puzzles/${t.id}` : `${API}${t.kind === 'game' ? 'games' : 'reviews'}/${t.id}/sgf`;

const named = (t: OgsTarget): string => `${t.kind === 'game' ? 'game' : t.kind === 'review' ? 'review' : 'puzzle'} ${t.id}`;

/** The refusals every kind shares. */
function checkStatus(t: OgsTarget, status: number): void {
	if (status === 404 || status === 401 || status === 403) throw new ImportError(`OGS has no ${named(t)}, or it is not public.`);
	if (status !== 200) throw new ImportError(`OGS answered ${status} for ${named(t)}.`);
}

/** **bold** and __bold__ as plain words (puzzle descriptions are written in Markdown). */
const plain = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim();

/* ------------------------------------------------------------- games, reviews */

/**
 * A game or review as OGS writes it, ready for a note: every move nested one variation
 * deeper is written as the plain sequence it is, chat lines that OGS could not write
 * ("someone: [object Object]") are left out, and the page it came from is the source.
 */
export function tidyGame(sgf: string, t: OgsTarget): string {
	const root = parseSgf(sgf)[0];
	if (!root) throw new Error('no SGF');
	eachNode(root, (n) => {
		const c = getText(n, 'C');
		if (!c.includes('[object Object]')) return;
		setText(n, 'C', c.split('\n').filter((line) => !line.includes('[object Object]')).join('\n').trim());
	});
	setText(root, 'SO', ogsPage(t));
	return serializeSgf(root);
}

/** What OGS answered for a game or review: SGF text. */
export function readOgsGame(t: OgsTarget, status: number, text: string): Fetched {
	checkStatus(t, status);
	if (!text.includes('(;')) throw new ImportError(`OGS sent no game for ${named(t)}.`);
	let sgf: string;
	try {
		sgf = tidyGame(text, t);
	} catch {
		throw new ImportError(`the SGF of ${named(t)} could not be read.`);
	}
	const root = parseSgf(sgf)[0];
	const who = (name: string, rank: string): string => {
		const n = getText(root, name);
		const r = getText(root, rank);
		return n ? (r && r !== '?' ? `${n} (${r})` : n) : '';
	};
	const players = [who('PB', 'BR'), who('PW', 'WR')].filter(Boolean).join(' vs ');
	const result = getText(root, 'RE');
	return { sgf, about: [players, result && result !== '?' ? result : ''].filter(Boolean).join(', ') };
}

/* ----------------------------------------------------------------------- puzzles */

interface PuzzleNode {
	x?: number;
	y?: number;
	branches?: PuzzleNode[];
	trunk_next?: PuzzleNode;
	correct_answer?: boolean;
	wrong_answer?: boolean;
	text?: string;
	marks?: { x?: number; y?: number; marks?: Record<string, unknown> }[];
}

const MARK: Record<string, string> = { triangle: 'TR', square: 'SQ', circle: 'CR', cross: 'MA' };

/** Turn an OGS puzzle (the `puzzle` part of what the API sends) into an SGF problem. */
export function puzzleToSgf(p: Record<string, unknown>, t: OgsTarget, name: string): string {
	const w = Number(p.width) || 19;
	const h = Number(p.height) || w;
	const root = newNode(null, { GM: ['1'], FF: ['4'], SZ: [w === h ? String(w) : `${w}:${h}`] });
	const inBoard = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
	// setup stones: runs of two-letter points
	const init = (p.initial_state ?? {}) as { black?: string; white?: string };
	for (const [key, run] of [['AB', init.black], ['AW', init.white]] as const) {
		const pts = (run ?? '').match(/[a-z]{2}/g) ?? [];
		if (pts.length) root.props[key] = pts;
	}
	const first = String(p.initial_player).toLowerCase() === 'white' ? 'W' : 'B';
	root.props.PL = [first];
	if (name) setText(root, 'GN', name);
	setText(root, 'SO', ogsPage(t));
	const desc = typeof p.puzzle_description === 'string' ? plain(p.puzzle_description) : '';
	if (desc) setText(root, 'C', desc);

	const marksOn = (node: SgfNode, n: PuzzleNode): void => {
		for (const m of n.marks ?? []) {
			const x = Number(m.x);
			const y = Number(m.y);
			if (!inBoard(x, y) || !m.marks) continue;
			const pt = xy2pt(x, y);
			for (const [kind, on] of Object.entries(m.marks)) {
				if (kind === 'letter' && typeof on === 'string' && on) (node.props.LB ??= []).push(`${pt}:${escapeText(on)}`);
				else if (MARK[kind] && on) (node.props[MARK[kind]] ??= []).push(pt);
			}
		}
	};
	const tree: PuzzleNode = (p.move_tree as PuzzleNode | undefined) ?? {};
	marksOn(root, tree);
	// the tree: colours take turns from the player to move; the main line (trunk) first
	const grow = (parent: SgfNode, n: PuzzleNode, color: 'B' | 'W'): void => {
		const kids = [...(n.trunk_next ? [n.trunk_next] : []), ...(n.branches ?? [])];
		for (const k of kids) {
			const x = Number(k.x);
			const y = Number(k.y);
			const node = newNode(parent, { [color]: [inBoard(x, y) ? xy2pt(x, y) : ''] });
			parent.children.push(node);
			if (k.text) setText(node, 'C', plain(k.text));
			if (k.correct_answer) node.props.TE = ['1'];
			else if (k.wrong_answer) node.props.BM = ['1'];
			marksOn(node, k);
			grow(node, k, color === 'B' ? 'W' : 'B');
		}
	};
	grow(root, tree, first);
	return serializeSgf(root);
}

/** What OGS answered for a puzzle: JSON (`json`: a getter, as it throws on what is not JSON). */
export function readOgsPuzzle(t: OgsTarget, status: number, json: () => unknown): Fetched {
	checkStatus(t, status);
	let data: Record<string, unknown> | null = null;
	try {
		data = json() as Record<string, unknown>;
	} catch {
		// (handled below)
	}
	const puzzle = data?.puzzle as Record<string, unknown> | undefined;
	if (!data || !puzzle || typeof puzzle.move_tree !== 'object') throw new ImportError(`OGS sent no puzzle for ${named(t)}.`);
	const name = typeof data.name === 'string' ? data.name : typeof puzzle.name === 'string' ? puzzle.name : '';
	const sgf = puzzleToSgf(puzzle, t, name);
	const kind = typeof puzzle.puzzle_type === 'string' ? puzzle.puzzle_type.replace(/_/g, ' ') : '';
	const owner = (data.owner as { username?: string } | undefined)?.username;
	return {
		sgf,
		about: [name, kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : '', owner ? `by ${owner}` : ''].filter(Boolean).join(', '),
	};
}
