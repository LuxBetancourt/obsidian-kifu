/**
 * Keeping links in Kifu's own text whole when files are renamed. Obsidian rewrites the
 * links in notes when what they point at moves, but not inside code blocks; so the comments
 * of a game kept in a kifu block or an .sgf file, and the "sgf:" line naming a game's file,
 * would go on naming a file that is no longer there.
 */

import { escapeText, findGames, unescapeText } from './sgf';

/**
 * What a link should point at now, given its target as written (before any #heading,
 * |alias or "title"): the new target, or null to leave the link as it is. `markdown`: the
 * target of a [text](…) link (URL-decoded), which keeps a note's ".md".
 */
export type Retarget = (target: string, markdown: boolean) => string | null;

// [[target#heading|alias]] and ![[…]]: the target ends at # | or ], a heading at | or ]
const WIKI = /(!?)\[\[([^\]\n|#]*)(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;
// [text](target), [text](<target>), [text](target "title"), and ![…](…)
const MARKDOWN = /(!?)\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]*)((?:\s+"[^"\n]*")?)\)/g;

/** `text` (Markdown) with each link that `retarget` names pointing where it says. */
export function rewriteLinks(text: string, retarget: Retarget): string {
	if (!text.includes('[')) return text;
	return text
		.replace(WIKI, (all: string, bang: string, target: string, heading: string | undefined, alias: string | undefined) => {
			const t = target.trim();
			const next = t ? retarget(t, false) : null;
			return next === null ? all : `${bang}[[${next}${heading ?? ''}${alias ?? ''}]]`;
		})
		.replace(MARKDOWN, (all: string, bang: string, label: string, written: string, title: string) => {
			const angle = written.startsWith('<');
			const inner = angle ? written.slice(1, -1) : written;
			// (a web address, a mail link, or a heading in this same note: no file of ours)
			if (!inner || inner.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(inner)) return all;
			const hash = inner.indexOf('#');
			const target = hash < 0 ? inner : inner.slice(0, hash);
			const heading = hash < 0 ? '' : inner.slice(hash);
			let plain = target;
			try {
				plain = decodeURIComponent(target);
			} catch {
				// (a stray % sign: read it as written)
			}
			const next = retarget(plain, true);
			if (next === null) return all;
			const put = angle ? `<${next}${heading}>` : next.replace(/ /g, '%20') + heading;
			return `${bang}[${label}](${put}${title})`;
		});
}

const isWs = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9;

/** Where the property value opening at `open` (its "[") ends: at the "]" that no backslash escapes. */
function valueEnd(text: string, open: number): number {
	for (let from = open + 1; ; ) {
		const k = text.indexOf(']', from);
		if (k < 0) return text.length;
		let slashes = 0;
		for (let q = k - 1; q > open && text.charCodeAt(q) === 92; q--) slashes++;
		if (slashes % 2 === 0) return k;
		from = k + 1;
	}
}

/**
 * `sgf` with every comment (C) passed through `fix`, which is given plain text and gives it
 * back. Only the comments that come out different are touched; every other byte stays as it
 * was. Property names are read the way the parser reads them (capitals only, so an old
 * file's "Comment[…]" is a C as well), and nothing outside the games is looked at.
 */
export function rewriteComments(sgf: string, fix: (plain: string) => string): string {
	const n = sgf.length;
	let out = '';
	let last = 0;
	let depth = 0;
	for (let i = 0; i < n; ) {
		const c = sgf.charCodeAt(i);
		if (c === 40 /* ( */) {
			depth++;
			i++;
			continue;
		}
		if (c === 41 /* ) */) {
			if (depth) depth--;
			i++;
			continue;
		}
		if (c < 65 || c > 90 || !depth) {
			i++;
			continue;
		}
		let id = '';
		for (; i < n; i++) {
			const d = sgf.charCodeAt(i);
			if (d >= 65 && d <= 90) id += sgf[i];
			else if (d < 97 || d > 122) break;
		}
		while (i < n && isWs(sgf.charCodeAt(i))) i++;
		while (i < n && sgf.charCodeAt(i) === 91 /* [ */) {
			const end = valueEnd(sgf, i);
			if (id === 'C') {
				const plain = unescapeText(sgf.slice(i + 1, end));
				const next = fix(plain);
				if (next !== plain) {
					out += sgf.slice(last, i + 1) + escapeText(next);
					last = end;
				}
			}
			i = end + 1;
			while (i < n && isWs(sgf.charCodeAt(i))) i++;
		}
	}
	return last ? out + sgf.slice(last) : sgf;
}

/** What the vault can tell about links, once the renames are done. */
export interface LinkWorld {
	/** The path of the file a link from `source` reaches now, or null when it reaches none. */
	reaches(target: string, source: string): string | null;
	/** How a link from `source` names the file at `path`, the way Obsidian would write it. */
	name(path: string, source: string, keepMd: boolean): string;
}

/** `target` taken from the folder of `source` when it is written as relative ("./", "../"). */
function fromFolder(target: string, source: string): string {
	if (!/^\.\.?\//.test(target)) return target;
	const parts = source.split('/').slice(0, -1);
	for (const seg of target.split('/')) {
		if (seg === '..') parts.pop();
		else if (seg && seg !== '.') parts.push(seg);
	}
	return parts.join('/');
}

/**
 * Who a link meant before some files were renamed (`renamed`: old path → new path), told
 * afterwards. A link that still reaches a file is left alone: the renames did not break it
 * (a short link to a file that only changed folders still finds it), or it reaches another
 * file of the same name, which it may well have meant. One that reaches nothing now and
 * names an old path — whole, without ".md", or by its last parts as a short link does — is
 * pointed at that file. One that could have meant either of two renamed files is left as
 * it is: a wrong guess would be worse than a broken link.
 */
export function makeRetarget(world: LinkWorld, renamed: ReadonlyMap<string, string>, source: string): Retarget {
	return (target, markdown) => {
		const want = fromFolder(target.trim().replace(/\\/g, '/'), source).replace(/^\/+/, '');
		if (!want || world.reaches(want, source) !== null) return null;
		const low = want.toLowerCase();
		const exact: string[] = [];
		const tail: string[] = [];
		for (const [from, to] of renamed) {
			const f = from.toLowerCase();
			const bare = f.endsWith('.md') ? f.slice(0, -3) : null;
			if (f === low || bare === low) exact.push(to);
			else if (f.endsWith('/' + low) || (bare !== null && bare.endsWith('/' + low))) tail.push(to);
		}
		const hits = exact.length ? exact : tail;
		return hits.length === 1 ? world.name(hits[0], source, markdown) : null;
	};
}

/**
 * The value of a "sgf:" line pointed at its file's new name, written the way it was — as
 * [[name]], a quoted name or a bare one, with ".sgf" or without — or null when it does not
 * name a renamed file.
 */
export function sgfRef(value: string, retarget: Retarget): string | null {
	const v = value.trim();
	const wiki = /^(!?\[\[)([^\]|#]+)([#|][^\]]*)?(\]\])$/.exec(v);
	const quote = !wiki && /^(["']).+\1$/.test(v) ? v[0] : '';
	const name = (wiki ? wiki[2] : quote ? v.slice(1, -1) : v).trim();
	if (!name) return null;
	const ext = /\.sgf$/i.test(name);
	const next = retarget(ext ? name : name + '.sgf', false);
	if (next === null) return null;
	const put = ext ? next : next.replace(/\.sgf$/i, '');
	return wiki ? wiki[1] + put + (wiki[3] ?? '') + wiki[4] : quote + put + quote;
}

/** An option line with its "sgf:" value passed through `ref` (null: unchanged). Other lines come back as they are. */
export function relinkOptionLine(line: string, ref: (value: string) => string | null): string {
	const m = /^(\s*sgf\s*:\s*)(.*?)(\s*)$/i.exec(line);
	if (!m || !m[2]) return line;
	const next = ref(m[2]);
	return next === null ? line : m[1] + next + m[3];
}

/**
 * A kifu block's body with its links mended: the comments of the games in it (`comment`),
 * and the file its "sgf:" line names (`ref`). Nothing else is touched; in particular a
 * bracket in some other option line is never taken for a comment. Null: nothing to change.
 */
export function relinkBody(body: string, comment: (plain: string) => string, ref: (value: string) => string | null): string | null {
	const lines = body.split('\n');
	let changed = false;
	let k = 0;
	// the option lines: up to the first line that starts with "(", as the block is read
	for (; k < lines.length && !lines[k].trim().startsWith('('); k++) {
		const next = relinkOptionLine(lines[k], ref);
		if (next !== lines[k]) {
			lines[k] = next;
			changed = true;
		}
	}
	const rest = lines.slice(k).join('\n');
	let tail = '';
	let last = 0;
	for (const [a, b] of findGames(rest)) {
		const game = rest.slice(a, b);
		const next = rewriteComments(game, comment);
		if (next === game) continue;
		tail += rest.slice(last, a) + next;
		last = b;
		changed = true;
	}
	if (!changed) return null;
	const head = lines.slice(0, k);
	return k < lines.length ? [...head, last ? tail + rest.slice(last) : rest].join('\n') : head.join('\n');
}
