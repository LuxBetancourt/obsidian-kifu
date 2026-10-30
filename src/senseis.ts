/**
 * Sensei's Library (senseis.xmp.net), the Go wiki. Its pages carry diagrams, each kept
 * as an SGF file of its own at a stable address (`diagrams/<n>/<hash>.sgf`), with the
 * setup, the moves, the marks and letters, and the caption. A link to a diagram's file
 * is drawn as a board already (it is an SGF file on the web); this adds the page: a
 * link to it, with the diagram wanted after a `#` (`?Ladder#2`, the second; none or
 * `#1`, the first), is resolved by reading the page for its diagram links, in order.
 *
 * The library's content is under the Open Content License, which allows copying and
 * modifying it; robots.txt keeps only editing and searching to the site. Reading a page
 * for the links it exists to show is what a browser does.
 */

import { ImportError } from './importing';
import { SgfNode, getText, parseSgf, serializeSgf, setText } from './sgf';

export interface SenseisTarget {
	/** The page's name as the site has it after `?` ("Ladder", "ChineseFuseki"). */
	page: string;
	/** Which diagram of the page, counting from 1. */
	diagram: number;
	/** The page's address. */
	url: string;
}

const SITE = 'https://senseis.xmp.net/';

/**
 * The page and diagram a link is to (`https://senseis.xmp.net/?Ladder`, `…?Ladder#2`), or
 * for the import prompt the page's name alone ("Ladder", "Ladder#2"). Null when it is
 * neither. A link straight to a diagram's `.sgf` file is not this: it is an SGF file on
 * the web, and is fetched as one.
 */
export function senseisTarget(text: string): SenseisTarget | null {
	const s = text.trim();
	let rest: string;
	const link = /^https?:\/\/(?:www\.)?senseis\.xmp\.net\/?\?([^#\s]*)(?:#(\d{1,3}))?\s*$/i.exec(s);
	if (link) rest = link[1] + (link[2] ? `#${link[2]}` : '');
	else if (/^https?:/i.test(s) || /[/?\s]/.test(s)) return null;
	else rest = s;
	const m = /^([A-Za-z0-9_%.-]+)(?:#(\d{1,3}))?$/.exec(rest);
	if (!m || !m[1]) return null;
	// (a page named with an edit, diff or search query is not a page to read)
	if (/^(edit|copy|diff|header|info|search|full|searchstring|quicksearch|fullboardsearch|positionsearch|blockme|random|related|relatedchanges|rssdiff|discuss)=/i.test(m[1])) return null;
	const diagram = m[2] ? parseInt(m[2]) : 1;
	if (diagram < 1) return null;
	return { page: m[1], diagram, url: `${SITE}?${m[1]}` };
}

/** The page's own address, as the site writes it. */
export const senseisPage = (t: SenseisTarget): string => t.url + (t.diagram > 1 ? `#${t.diagram}` : '');

/**
 * The diagrams a page holds, in order: the address of each one's SGF file. Read from the
 * page's HTML: each diagram is a link to its file (and a picture of it, left out).
 */
export function senseisDiagrams(html: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(/href="(diagrams\/\d+\/[0-9a-f]+\.sgf)"/gi)) {
		const path = m[1].toLowerCase();
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(SITE + m[1]);
	}
	return out;
}

/** The page's title, as the site writes it ("Ladder at Sensei's Library" → "Ladder"). */
export function senseisTitle(html: string): string {
	// (the apostrophe comes as itself or as an entity)
	const m = /<title>([^<]*?)\s+at Sensei(?:'|&#0?39;|&apos;)s Library<\/title>/i.exec(html);
	return m ? decodeEntities(m[1].trim()) : '';
}

function decodeEntities(s: string): string {
	const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
	return s
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

/**
 * Where on a page a diagram's SGF file is: the file's address, from the page's HTML, or an
 * error saying what the page has not got.
 */
export function senseisDiagramUrl(t: SenseisTarget, status: number, html: string): string {
	if (status === 404) throw new ImportError(`Sensei's Library has no page ${t.page}.`);
	if (status !== 200) throw new ImportError(`Sensei's Library answered ${status} for ${t.url}.`);
	const files = senseisDiagrams(html);
	if (!files.length) throw new ImportError(`the page ${t.page} on Sensei's Library has no diagram.`);
	const file = files[t.diagram - 1];
	if (!file) throw new ImportError(`the page ${t.page} on Sensei's Library has ${files.length} diagram${files.length === 1 ? '' : 's'}, not ${t.diagram}.`);
	return file;
}

/**
 * A diagram's SGF, tidied for a board: the site writes the caption into the root comment
 * after a line saying which page it is from, and every move's comment is its number
 * ("B1"), which a board shows anyway. The caption stays as the comment; the page goes
 * into SO (and the title into GN, where the site left it at the page's name).
 */
export function tidySenseisSgf(sgf: string, page: string): string {
	const root = parseSgf(sgf)[0];
	if (!root) throw new ImportError(`${page} is not an SGF file.`);
	const c = getText(root, 'C');
	const caption = c.replace(/^Diagram from \S+\s*/i, '').trim();
	setText(root, 'C', caption);
	setText(root, 'SO', page);
	// (the move comments "B1", "W2"…: the number the board shows; nothing to say twice)
	const strip = (n: SgfNode): void => {
		if (n.props.C && /^[BW]\d+$/.test(getText(n, 'C'))) delete n.props.C;
		for (const k of n.children) strip(k);
	};
	for (const k of root.children) strip(k);
	return serializeSgf(root);
}
