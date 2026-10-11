/**
 * Live Preview: `![](link)` to an OGS game or puzzle, or a goproblems.com problem, is
 * drawn as a board, the way Obsidian draws an embedded image. With the cursor on it the
 * link shows as text again, to be edited.
 */

import { EditorState, Extension, Prec, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view';
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
		/** The cursor is on it (as on an embedded image: Enter then shows the link to edit). */
		readonly selected: boolean,
	) {
		super();
	}

	// (the same link keeps its board as the note is edited around it)
	eq(other: LinkWidget): boolean {
		return other.target.url === this.target.url && other.notePath === this.notePath && other.selected === this.selected;
	}

	// The cursor coming or going changes only the highlight: the board itself (and a
	// problem half solved on it) stays.
	updateDOM(el: HTMLElement): boolean {
		const board = LinkWidget.boards.get(el);
		if (!board || el.dataset.url !== this.target.url || el.dataset.note !== this.notePath) return false;
		el.toggleClass('is-selected', this.selected);
		return true;
	}

	toDOM(): HTMLElement {
		const el = createDiv({ cls: 'kifu-linked-embed' });
		el.dataset.url = this.target.url;
		el.dataset.note = this.notePath;
		el.toggleClass('is-selected', this.selected);
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

interface Found {
	from: number;
	to: number;
	target: LinkTarget;
}

/** The links in the note that are drawn as boards (not in code), in order. */
function links(state: EditorState): Found[] {
	const text = state.doc.toString();
	// (most notes have none: then nothing more is looked at)
	if (!/online-go\.com|goproblems\.com/i.test(text)) return [];
	const out: Found[] = [];
	const fenced = fencedLines(state);
	EMBED.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = EMBED.exec(text)); ) {
		const from = m.index;
		const to = from + m[0].length;
		const target = linkTarget(m[1]);
		if (!target) continue;
		const line = state.doc.lineAt(from);
		if (fenced.has(line.number)) continue;
		// inside inline code: an odd number of backticks before it on its line
		if (((line.text.slice(0, from - line.from).match(/`/g) ?? []).length & 1) === 1) continue;
		out.push({ from, to, target });
	}
	return out;
}

interface LinkState {
	deco: DecorationSet;
	/** Where the link being edited starts (after Enter on its board), or -1. */
	editing: number;
}

/** Enter on a board: its link is to be edited (shown as text) until the cursor leaves it. */
const editLink = StateEffect.define<number>();

function build(state: EditorState, plugin: KifuPlugin, editing: number): LinkState {
	const b = new RangeSetBuilder<Decoration>();
	if (!state.field(editorLivePreviewField, false)) return { deco: b.finish(), editing: -1 };
	const notePath = state.field(editorInfoField, false)?.file?.path ?? '';
	const sel = state.selection.ranges;
	let stillEditing = -1;
	for (const { from, to, target } of links(state)) {
		// The cursor on it, at either end or inside: like an embedded image, the board stays,
		// marked as selected. After Enter, the link shows as text to be edited, for as long as
		// the cursor stays in it.
		const on = sel.some((r) => r.from <= to && r.to >= from);
		if (on && from === editing) {
			stillEditing = from;
			continue;
		}
		b.add(from, to, Decoration.replace({ widget: new LinkWidget(target, plugin, notePath, on) }));
	}
	return { deco: b.finish(), editing: stillEditing };
}

/**
 * The editor extension. The boards come from a state field, not a view plugin: the
 * editor ranks decorations from fields above those from plugins, whatever their
 * precedence, and Obsidian draws its embedded images from a field. Ours goes ahead of it.
 */
export function linkedBoards(plugin: KifuPlugin): Extension {
	const field = StateField.define<LinkState>({
		create: (state) => build(state, plugin, -1),
		update: (value, tr) => {
			let editing = value.editing;
			for (const e of tr.effects) if (e.is(editLink)) editing = e.value;
			if (editing !== -1 && tr.docChanged) editing = tr.changes.mapPos(editing);
			const changed = tr.docChanged || tr.selection || editing !== value.editing || tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false);
			return changed ? build(tr.state, plugin, editing) : value;
		},
		provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
	});
	// Enter with the cursor in a link drawn as a board: show it as text to edit. The key
	// still goes on to Obsidian, which reveals an embedded image's link on Enter too.
	const enter = keymap.of([
		{
			key: 'Enter',
			run: (view) => {
				const head = view.state.selection.main;
				if (!head.empty) return false;
				const hit = links(view.state).find((l) => head.from > l.from && head.from < l.to);
				if (hit) view.dispatch({ effects: editLink.of(hit.from) });
				return false;
			},
		},
	]);
	return Prec.highest([field, enter]);
}
