/**
 * Importing a problem from goproblems.com: its public API hands out each problem's SGF,
 * variations and comments included. (The request itself is made by the plugin, only when
 * the import command is used; everything here is plain work on what came back.)
 */

import { eachNode, getText, parseSgf, serializeSgf, setText } from './sgf';

const API = 'https://goproblems.com/api/v2/problems/';
const SITE = 'https://www.goproblems.com/problems/';

/** The problem number in what was typed: "5", "#5", or a link to the problem on the site. */
export function problemId(input: string): number | null {
	const s = input.trim();
	const m = /^#?(\d+)$/.exec(s) ?? /goproblems\.com\/(?:[a-z-]+\/)*problems?\/(\d+)/i.exec(s) ?? /[?&](?:id|prob)=(\d+)/i.exec(s);
	const n = m ? parseInt(m[1]) : NaN;
	return n > 0 ? n : null;
}

export function problemUrl(id: number): string {
	return SITE + id;
}

/**
 * The problem's SGF, ready for a note. goproblems.com marks a correct line by ending its
 * comment with RIGHT (often run on, as in "snapbackRIGHT"): that becomes a ✓ (TE) and
 * leaves the comment. The game gets the problem's number for a name and its page as the
 * source, and loses the placeholder players ("Black" and "White") its files carry.
 */
export function tidyProblem(sgf: string, id: number): string {
	const root = parseSgf(sgf)[0];
	if (!root) throw new Error('the problem has no SGF');
	eachNode(root, (n) => {
		const c = getText(n, 'C');
		if (!c || !(n.props.B || n.props.W)) return;
		const m = /^\s*RIGHT\b[\s.!:]*|\s*RIGHT[\s.!]*$/.exec(c);
		if (!m) return;
		setText(n, 'C', (c.slice(0, m.index) + c.slice(m.index + m[0].length)).trim());
		if (!n.props.BM) n.props.TE = ['1'];
	});
	for (const [key, placeholder] of [['PB', /^black$/i], ['PW', /^white$/i]] as const) {
		if (placeholder.test(getText(root, key))) delete root.props[key];
	}
	setText(root, 'GN', `goproblems.com #${id}`);
	setText(root, 'SO', problemUrl(id));
	return serializeSgf(root);
}

export interface Fetched {
	sgf: string;
	/** "Life and death, 14 kyu, by adum": what is said about it, for the link above the board. */
	about: string;
}

/** Why an import did not work, in words for a notice. */
export class ImportError extends Error {}

const label = (s: unknown): string => (typeof s === 'string' && s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export const problemApi = (id: number): string => API + id;

/**
 * Read what the API answered for problem `id` (`status`, and `json`: a getter, as it
 * throws on what is not JSON). `withKey`: an API token was sent.
 */
export function readProblem(id: number, status: number, json: () => unknown, withKey: boolean): Fetched {
	if (status === 404) throw new ImportError(`goproblems.com has no problem ${id}.`);
	if (status === 401 || status === 403) {
		throw new ImportError(withKey ? `goproblems.com refused the API token for problem ${id}.` : `problem ${id} is not public. An API token (in the settings) may let it in.`);
	}
	if (status !== 200) throw new ImportError(`goproblems.com answered ${status} for problem ${id}.`);
	let data: Record<string, unknown> | null = null;
	try {
		data = json() as Record<string, unknown>;
	} catch {
		// (handled below)
	}
	if (!data || typeof data.sgf !== 'string' || !data.sgf.includes('(')) throw new ImportError(`problem ${id} came without its SGF.`);
	let sgf: string;
	try {
		sgf = tidyProblem(data.sgf, id);
	} catch {
		throw new ImportError(`the SGF of problem ${id} could not be read.`);
	}
	const rank = data.rank as { value?: number; unit?: string } | undefined;
	const author = (data.author as { name?: string } | undefined)?.name;
	const about = [label(data.genre), rank?.value && rank.unit ? `${rank.value} ${rank.unit}` : '', author ? `by ${author}` : '']
		.filter(Boolean)
		.join(', ');
	return { sgf, about };
}
