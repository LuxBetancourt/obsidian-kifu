/**
 * Boards drawn from a link to an SGF file anywhere on the web (a file server of one's
 * own, say). Plain work on what came back; the plugin makes the request.
 */

import { ImportError } from './importing';
import { findGames } from './sgf';

/** Is this a link to an .sgf file (a query or fragment after the name is fine)? */
export function isSgfLink(href: string): boolean {
	let url: URL;
	try {
		url = new URL(href.trim());
	} catch {
		return false;
	}
	return (url.protocol === 'https:' || url.protocol === 'http:') && /\.sgf$/i.test(url.pathname);
}

/**
 * The text of an SGF file: UTF-8, unless that garbles it and the file names another
 * charset (CA), as older files from Japan, Korea or China often do; or, for a file that
 * names none, `fallback` (the charset a server is known to write in).
 */
export function decodeSgf(bytes: ArrayBuffer, fallback = ''): string {
	const text = new TextDecoder('utf-8').decode(bytes);
	if (!text.includes('\ufffd')) return text;
	const charset = /CA\[([^\]]+)\]/.exec(text)?.[1]?.trim() || fallback;
	if (!charset || /^utf-?8$/i.test(charset)) return text;
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return text; // (a charset the browser does not know: what we have)
	}
}

/** What the server answered for `url`: the SGF text, ready to be a board's block. */
export function readSgfLink(url: string, status: number, bytes: () => ArrayBuffer): string {
	if (status === 404 || status === 410) throw new ImportError(`there is no file at ${url}.`);
	if (status === 401 || status === 403) throw new ImportError(`${url} refused to send the file.`);
	if (status !== 200) throw new ImportError(`${url} answered ${status}.`);
	const text = decodeSgf(bytes());
	if (!findGames(text).length) throw new ImportError(`${url} is not an SGF file.`);
	return text;
}
