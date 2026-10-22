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
	) {
		super();
	}

	// (the same link keeps its board as the note is edited around it)
	eq(other: LinkWidget): boolean {
		return other.target.url === this.target.url && other.notePath === this.notePath;
	}

	toDOM(): HTMLElement {
		const el = createDiv({ cls: 'kifu-linked-embed' });
		const board = new LinkedBoard(el, this.plugin, this.target, this.notePath, null);
		board.load();
		LinkWidget.boards.set(el, board);
		return el;
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

/** The field's value: the boards, and whether the note holds any text that could be a link at all. */
interface Links {
	deco: DecorationSet;
	any: boolean;
}

const NONE: Links = { deco: Decoration.none, any: false };

/** Could the lines a change touched hold a link? Looked at instead of the whole note. */
function changeMayLink(tr: Transaction): boolean {
	let may = false;
	const doc = tr.state.doc;
	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (may) return;
		const from = doc.lineAt(fromB);
		const to = doc.lineAt(toB);
		may = CANDIDATE.test(doc.sliceString(from.from, to.to));
	});
	return may;
}

function build(state: EditorState, plugin: KifuPlugin): Links {
	if (!state.field(editorLivePreviewField, false)) return NONE;
	const text = state.doc.toString();
	if (!CANDIDATE.test(text)) return NONE;
	const b = new RangeSetBuilder<Decoration>();
	const notePath = state.field(editorInfoField, false)?.file?.path ?? '';
	const sel = state.selection.ranges;
	const fenced = fencedLines(state);
	EMBED.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = EMBED.exec(text)); ) {
		const start = m.index;
		const end = start + m[0].length;
		const t = linkTarget(m[1]);
		if (!t) continue;
		const line = state.doc.lineAt(start);
		if (fenced.has(line.number)) continue;
		// inside inline code: an odd number of backticks before it on its line
		if (((line.text.slice(0, start - line.from).match(/`/g) ?? []).length & 1) === 1) continue;
		// The cursor inside it: shown as text, to be edited. Only inside: at either end
		// Obsidian keeps drawing it as an image (a broken one), so the board stays.
		if (sel.some((r) => r.from < end && r.to > start)) continue;
		b.add(start, end, Decoration.replace({ widget: new LinkWidget(t, plugin, notePath) }));
	}
	return { deco: b.finish(), any: true };
}

/**
 * The editor extension. The boards come from a state field, not a view plugin: the
 * editor ranks decorations from fields above those from plugins, whatever their
 * precedence, and Obsidian draws its embedded images from a field. Ours goes ahead of it.
 *
 * The field runs in every editor, at every keystroke and cursor move, so it must cost
 * nothing in the notes that have no links: the whole note is read once, when it opens
 * (and again only after a change to a line that could hold a link, or when a link is
 * known to be there). A cursor move matters only where there is a link to step into.
 */
export function linkedBoards(plugin: KifuPlugin): Extension {
	const field = StateField.define<Links>({
		create: (state) => build(state, plugin),
		update: (links, tr) => {
			const lpWas = tr.startState.field(editorLivePreviewField, false);
			const lpNow = tr.state.field(editorLivePreviewField, false);
			if (lpWas !== lpNow) return build(tr.state, plugin);
			if (!lpNow) return links;
			if (tr.docChanged) return links.any || changeMayLink(tr) ? build(tr.state, plugin) : links;
			if (tr.selection && links.any) return build(tr.state, plugin);
			return links;
		},
		provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
	});
	return Prec.highest(field);
}
