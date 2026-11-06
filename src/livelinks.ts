/**
 * Live Preview: `![](link)` to an OGS game or puzzle, or a goproblems.com problem, is
 * drawn as a board, the way Obsidian draws an embedded image. With the cursor on it the
 * link shows as text again, to be edited.
 */

import { EditorState, Extension, Prec, RangeSetBuilder, StateField, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import type KifuPlugin from './main';
import { LinkTarget, LinkedBoard, linkTarget } from './linked';

/** `![alt](link)` and `![alt](<link>)`, with an optional title. */
const EMBED = /!\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

class LinkWidget extends WidgetType {
	static boards = new WeakMap<HTMLElement, LinkedBoard>();

	constructor(
		readonly target: LinkTarget,
		readonly plugin: KifuPlugin,
		readonly notePath: string,
		/** Inside a selection: shown tinted as a whole, as a selected block is. */
		readonly selected: boolean,
	) {
		super();
	}

	// (the same link keeps its board as the note is edited around it; a change of
	// selection only toggles the tint, see updateDOM)
	eq(other: LinkWidget): boolean {
		return other.target.url === this.target.url && other.notePath === this.notePath && other.selected === this.selected;
	}

	toDOM(): HTMLElement {
		const el = createDiv({ cls: 'kifu-linked-embed' });
		el.classList.toggle('is-selected', this.selected);
		const board = new LinkedBoard(el, this.plugin, this.target, this.notePath, null);
		board.load();
		LinkWidget.boards.set(el, board);
		return el;
	}

	// the same link, selected or not: the board stays, only the tint changes
	updateDOM(el: HTMLElement): boolean {
		const was = LinkWidget.boards.get(el);
		if (!was || was.target.url !== this.target.url) return false;
		el.classList.toggle('is-selected', this.selected);
		return true;
	}

	destroy(el: HTMLElement): void {
		LinkWidget.boards.get(el)?.unload();
		LinkWidget.boards.delete(el);
	}

	// the board handles its own clicks and keys; the editor leaves them be
	ignoreEvent(): boolean {
		return true;
	}
}

/** Lines inside fenced code (``` or ~~~): a link there is code, not an embed. */
function fencedLines(state: EditorState): Set<number> {
	const inside = new Set<number>();
	const doc = state.doc;
	let fence: string | null = null;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
		if (fence) {
			inside.add(n);
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.text.slice(m.index + m[0].length).trim()) fence = null;
		} else if (m) {
			fence = m[1];
			inside.add(n);
		}
	}
	return inside;
}

/** Text that might hold a link to a game or problem. (Most notes have none.) */
const CANDIDATE = /online-go\.com|goproblems\.com|josekipedia\.com|\.sgf|dragongoserver\.net|foxwq\.com|questgames\.net|stone\.gs/i;
/** That, or what decides whether such text counts: a backtick (inline code) or a tilde fence. */
const BEARS_ON_LINKS = new RegExp(`${CANDIDATE.source}|\`|^[ \\t]{0,3}~~~`, 'im');

/** A link found in the note: where it stands, and what it is to. */
interface Found {
	from: number;
	to: number;
	target: LinkTarget;
}

/** The field's value: the boards, the links they stand for, and whether the note holds any text that could be a link at all. */
interface Links {
	deco: DecorationSet;
	any: boolean;
	found: Found[];
}

const NONE: Links = { deco: Decoration.none, any: false, found: [] };

/**
 * Does `what` occur on the lines a change touched? Looked at instead of the whole note.
 * (The line before and after count too: a link may break its line after the "(".)
 */
function changeHas(tr: Transaction, what: RegExp): boolean {
	let has = false;
	const doc = tr.state.doc;
	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (has) return;
		const from = doc.lineAt(fromB);
		const to = doc.lineAt(toB);
		const start = from.number > 1 ? doc.line(from.number - 1).from : from.from;
		const end = to.number < doc.lines ? doc.line(to.number + 1).to : to.to;
		has = what.test(doc.sliceString(start, end));
	});
	return has;
}

/** The links of a note, read from its whole text; null when it holds nothing that could be one. */
function scan(state: EditorState): Found[] | null {
	const text = state.doc.toString();
	if (!CANDIDATE.test(text)) return null;
	const found: Found[] = [];
	let fenced: Set<number> | null = null;
	EMBED.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = EMBED.exec(text)); ) {
		const start = m.index;
		const t = linkTarget(m[1]);
		if (!t) continue;
		const line = state.doc.lineAt(start);
		if ((fenced ??= fencedLines(state)).has(line.number)) continue;
		// inside inline code: an odd number of backticks before it on its line
		if (((line.text.slice(0, start - line.from).match(/`/g) ?? []).length & 1) === 1) continue;
		found.push({ from: start, to: start + m[0].length, target: t });
	}
	return found;
}

/** The links after a change, moved along with the text; null when the change ran into one of them. */
function carry(found: Found[], tr: Transaction): Found[] | null {
	let hit = false;
	tr.changes.iterChangedRanges((fromA, toA) => {
		for (const f of found) if (fromA < f.to && toA > f.from) hit = true;
	});
	if (hit) return null;
	return found.map((f) => ({ from: tr.changes.mapPos(f.from, 1), to: tr.changes.mapPos(f.to, -1), target: f.target }));
}

/** The boards for `found`, as the selection stands. */
function decorate(state: EditorState, plugin: KifuPlugin, found: Found[]): DecorationSet {
	if (!found.length) return Decoration.none;
	const b = new RangeSetBuilder<Decoration>();
	const notePath = state.field(editorInfoField, false)?.file?.path ?? '';
	const sel = state.selection.ranges;
	for (const { from: start, to: end, target } of found) {
		// The cursor inside it: shown as text, to be edited. Only inside: at either end
		// Obsidian keeps drawing it as an image (a broken one), so the board stays. And
		// only the cursor, not a selection: for a selection swept over the link Obsidian
		// draws its (broken) image and no text, so the board would vanish without a trace.
		if (sel.some((r) => r.empty && r.from > start && r.from < end)) continue;
		// (a selection swept over it: the board is tinted as a whole, as a selected block is)
		const selected = sel.some((r) => !r.empty && r.from < end && r.to > start);
		b.add(start, end, Decoration.replace({ widget: new LinkWidget(target, plugin, notePath, selected) }));
	}
	return b.finish();
}

function build(state: EditorState, plugin: KifuPlugin): Links {
	if (!state.field(editorLivePreviewField, false)) return NONE;
	const found = scan(state);
	if (!found) return NONE;
	return { deco: decorate(state, plugin, found), any: true, found };
}

/**
 * The editor extension. The boards come from a state field, not a view plugin: the
 * editor ranks decorations from fields above those from plugins, whatever their
 * precedence, and Obsidian draws its embedded images from a field. Ours goes ahead of it.
 *
 * The field runs in every editor, at every keystroke and cursor move, so it must cost
 * nothing in the notes that have no links: the whole note is read once, when it opens,
 * and again only after a change to a line that could hold a link. Where there are links,
 * a change elsewhere in the note moves them along, and a cursor move only looks again at
 * which of them it is in: neither reads the note.
 */
export function linkedBoards(plugin: KifuPlugin): Extension {
	const field = StateField.define<Links>({
		create: (state) => build(state, plugin),
		update: (links, tr) => {
			const lpWas = tr.startState.field(editorLivePreviewField, false);
			const lpNow = tr.state.field(editorLivePreviewField, false);
			if (lpWas !== lpNow) return build(tr.state, plugin);
			if (!lpNow) return links;
			if (tr.docChanged) {
				if (!links.any) return changeHas(tr, CANDIDATE) ? build(tr.state, plugin) : links;
				const moved = carry(links.found, tr);
				if (!moved || changeHas(tr, BEARS_ON_LINKS)) return build(tr.state, plugin);
				return { deco: decorate(tr.state, plugin, moved), any: true, found: moved };
			}
			if (tr.selection && links.found.length) return { deco: decorate(tr.state, plugin, links.found), any: true, found: links.found };
			return links;
		},
		provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
	});
	return Prec.highest(field);
}
