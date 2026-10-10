/**
 * Live Preview: `![](link)` to an OGS game or puzzle, or a goproblems.com problem, is
 * drawn as a board, the way Obsidian draws an embedded image. With the cursor on it the
 * link shows as text again, to be edited.
 */

import { Extension, Prec, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
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
function fencedLines(view: EditorView, upTo: number): Set<number> {
	const inside = new Set<number>();
	const doc = view.state.doc;
	let fence: string | null = null;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (line.from > upTo) break;
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

function build(view: EditorView, plugin: KifuPlugin): DecorationSet {
	const b = new RangeSetBuilder<Decoration>();
	if (!view.state.field(editorLivePreviewField, false)) return b.finish();
	const notePath = view.state.field(editorInfoField, false)?.file?.path ?? '';
	const sel = view.state.selection.ranges;
	const last = view.visibleRanges.length ? view.visibleRanges[view.visibleRanges.length - 1].to : 0;
	const fenced = fencedLines(view, last);
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		EMBED.lastIndex = 0;
		for (let m: RegExpExecArray | null; (m = EMBED.exec(text)); ) {
			const start = from + m.index;
			const end = start + m[0].length;
			const t = linkTarget(m[1]);
			if (!t) continue;
			const line = view.state.doc.lineAt(start);
			if (fenced.has(line.number)) continue;
			// inside inline code: an odd number of backticks before it on its line
			if (((line.text.slice(0, start - line.from).match(/`/g) ?? []).length & 1) === 1) continue;
			// the cursor on it: shown as text, to be edited
			if (sel.some((r) => r.from <= end && r.to >= start)) continue;
			b.add(start, end, Decoration.replace({ widget: new LinkWidget(t, plugin, notePath) }));
		}
	}
	return b.finish();
}

/** The editor extension, ahead of Obsidian's own drawing of an embedded image. */
export function linkedBoards(plugin: KifuPlugin): Extension {
	return Prec.highest(
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = build(view, plugin);
				}
				update(u: ViewUpdate): void {
					if (u.docChanged || u.viewportChanged || u.selectionSet || u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false)) {
						this.decorations = build(u.view, plugin);
					}
				}
			},
			{ decorations: (v) => v.decorations },
		),
	);
}
