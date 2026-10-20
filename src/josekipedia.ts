/**
 * Josekipedia (josekipedia.com), the joseki dictionary edited by its readers. A position
 * there is a link whose `#path:` lists the moves that lead to it, in SGF points
 * ("#path:pdqfnc"). Its database answers one node at a time, as JSON: the node, and the
 * moves that may follow it, each with its comment. The site calls this interface public;
 * it is not documented, so what comes back is checked as it is read.
 *
 * A position comes in as the line that leads to it, every move with its comment, and the
 * moves that may follow it as variations (with theirs). Asked only when a note shows a
 * link to it or the import command is used, one request a move.
 */

import { Fetched, ImportError } from './importing';
import { SgfNode, newNode, serializeSgf, setText } from './sgf';

export interface JosekiTarget {
	/** The moves that lead to the position, as SGF points. */
	path: string[];
	/** The position's page. */
	url: string;
}

const SITE = 'https://www.josekipedia.com/';
export const josekiPage = (path: string[]): string => `${SITE}#path:${path.join('')}`;
export const josekiApi = (id: number): string => `${SITE}db/node.php?id=${id}`;
/** The node of the empty board, where every path starts. */
const EMPTY_BOARD = 1;

/**
 * The position a link is to (`https://www.josekipedia.com/#path:pdqf`). For the import
 * prompt, the moves alone do too ("pdqf", or "path:pdqf"). Null when it is neither.
 */
export function josekiTarget(text: string): JosekiTarget | null {
	const s = text.trim();
	let moves: string;
	const link = /^https?:\/\/(?:www\.)?josekipedia\.com\/?[^#]*#path:([a-z]*)\s*$/i.exec(s);
	if (link) moves = link[1];
	else if (/^https?:/i.test(s)) return null;
	else {
		const bare = /^(?:path:)?([a-s]{2}(?:[a-s]{2})*)$/i.exec(s);
		if (!bare) return null;
		moves = bare[1];
	}
	if (moves.length % 2) return null;
	const path = (moves.toLowerCase().match(/../g) ?? []).filter((p) => /^([a-s][a-s]|tt)$/.test(p));
	if (path.length * 2 !== moves.length) return null;
	return { path, url: josekiPage(path) };
}

interface JosekiNode {
	id: number;
	color: 'B' | 'W' | null;
	point: string;
	comment: string;
	children: JosekiNode[];
}

/** One node as the database sends it, or null when it is not one. */
export function readJosekiNode(raw: unknown): JosekiNode | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const id = Number(o._id);
	if (!Number.isInteger(id)) return null;
	const color = typeof o.B === 'string' ? 'B' : typeof o.W === 'string' ? 'W' : null;
	const point = color ? String(o[color]).toLowerCase() : '';
	const comment = typeof o.C === 'string' ? cleanComment(o.C) : '';
	const kids = Array.isArray(o._children) ? o._children.map(readJosekiNode).filter((k): k is JosekiNode => k !== null) : [];
	return { id, color, point, comment, children: kids };
}

/**
 * A comment as plain text. They come HTML-escaped, and some were saved with their UTF-8
 * read as Windows-1252 at some point ("3â€“3" for "3–3"): put back where that is so.
 */
export function cleanComment(c: string): string {
	const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
	const text = c
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
	return unmangle(text).trim();
}

/** Windows-1252's characters for the bytes 0x80–0x9f (the rest of 0x80–0xff are Latin-1's). */
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

function unmangle(s: string): string {
	// a run that reads as UTF-8 bytes shown as Windows-1252: a lead byte, then continuation bytes
	return s.replace(/[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]{1,3}/g, (run) => {
		const bytes: number[] = [];
		for (const ch of run) {
			const code = ch.charCodeAt(0);
			const k = CP1252.indexOf(ch);
			if (k >= 0) bytes.push(0x80 + k);
			else if (code <= 0xff) bytes.push(code);
			else return run;
		}
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
		} catch {
			return run;
		}
	});
}

/** What the database answered for one node. */
export interface NodeAnswer {
	status: number;
	text: string;
}

/**
 * Ask for the nodes along the path, one by one (`get` asks the database for a node), and
 * make an SGF game of them: the line, every move with its comment, and after its last
 * move the moves that may follow, as variations.
 */
export async function fetchJoseki(t: JosekiTarget, get: (id: number) => Promise<NodeAnswer>): Promise<Fetched & { moves: number }> {
	const node = async (id: number): Promise<JosekiNode> => {
		const a = await get(id);
		if (a.status !== 200) throw new ImportError(`Josekipedia answered ${a.status} for ${t.url}.`);
		let raw: unknown = null;
		try {
			raw = JSON.parse(a.text);
		} catch {
			// (handled below)
		}
		const n = readJosekiNode(raw);
		if (!n) throw new ImportError(`Josekipedia sent no position for ${t.url}.`);
		return n;
	};
	const root = newNode(null, { GM: ['1'], FF: ['4'], SZ: ['19'] });
	setText(root, 'GN', 'Josekipedia');
	setText(root, 'SO', t.url);
	let here = await node(EMPTY_BOARD);
	let at: SgfNode = root;
	for (const pt of t.path) {
		const next = here.children.find((k) => k.point === pt);
		if (!next) throw new ImportError(`Josekipedia has no such position: ${t.url}.`);
		at = add(at, next);
		here = await node(next.id);
	}
	// what may follow, each as a variation of its own
	for (const k of here.children) add(at, k);
	return { sgf: serializeSgf(root), about: t.path.length ? `${t.path.length} move${t.path.length === 1 ? '' : 's'}` : 'the empty board', moves: t.path.length };
}

function add(parent: SgfNode, n: JosekiNode): SgfNode {
	const node = newNode(parent, n.color ? { [n.color]: [n.point === 'tt' ? '' : n.point] } : {});
	if (n.comment) setText(node, 'C', n.comment);
	parent.children.push(node);
	return node;
}
