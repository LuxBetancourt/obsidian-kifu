/*
 * A stand-in for Obsidian's Live Preview, built on the real CodeMirror 6 (the
 * versions Obsidian's typings pin). Widget creation and destruction, the "no update
 * during an update" guard, event routing and focus are therefore CodeMirror's own.
 *
 * What Obsidian itself does around CodeMirror is not documented. Each such point
 * is a switch in `LP`, and the checks are run with the switch both ways.
 */
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import { Annotation, ChangeSet, EditorState, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;
const O = window.__obsidian;

// The plugin's own CodeMirror imports are answered with this same CodeMirror, as
// Obsidian answers them with its own (see loadPlugin in index.html).
window.__cm = { '@codemirror/state': cmState, '@codemirror/view': cmView };

// Obsidian's editor fields: is this pane Live Preview, and which file is it.
O.editorLivePreviewField = StateField.define<boolean>({ create: () => true, update: (v) => v });
O.editorInfoField = StateField.define<{ file: unknown } | null>({ create: () => null, update: (v) => v });

export const LP = {
	/** Unload a block's render children inside WidgetType.destroy() (true) or a moment later. */
	syncUnload: true,
	/** WidgetType.ignoreEvent(): CodeMirror's default is true. */
	ignoreEvents: true,
	/** getSectionInfo(): the widget's lines now, the lines it had when it was built, or nothing. */
	sectionInfo: 'live' as 'live' | 'stale' | 'null',
	/** A handler on the widget that puts the cursor into the block unless the event was prevented. */
	clickSelects: 'none' as 'none' | 'click' | 'mousedown',
	/** Run the processor inside toDOM (true) or a microtask later. */
	syncRender: true,
	/** Put the block's "edit" button before the block's own element inside the widget, or after it. */
	buttonFirst: false,
	/** A second CodeMirror pane on the same note follows the first at once, or a microtask later. */
	mirror: 'sync' as 'sync' | 'micro',
	/** The workspace's 'editor-change' event: for every change, only for those made in the pane itself, or never. */
	editorChange: 'all' as 'all' | 'own' | 'none',
	log: [] as string[],
};
window.LP = LP;

const FENCE = /^([ \t>]*)(`{3,}|~{3,})\s*(\S*)/;

interface Found {
	from: number;
	to: number;
	lang: string;
	source: string;
	lineStart: number;
	lineEnd: number;
}

function findBlocks(state: EditorState, app: any): Found[] {
	const doc = state.doc;
	const out: Found[] = [];
	for (let n = 1; n <= doc.lines; n++) {
		const first = doc.line(n);
		const m = FENCE.exec(first.text);
		if (!m) continue;
		const strip = (l: string): string => (l.startsWith(m[1]) ? l.slice(m[1].length) : l.replace(/^[ \t>]+/, ''));
		const body: string[] = [];
		let j = n + 1;
		let closed = false;
		for (; j <= doc.lines; j++) {
			const t = strip(doc.line(j).text).trim();
			if (t.startsWith(m[2]) && t.replace(m[2][0] === '`' ? /`/g : /~/g, '') === '') {
				closed = true;
				break;
			}
			body.push(strip(doc.line(j).text));
		}
		if (!closed) break;
		if (app._processors.has(m[3])) {
			out.push({ from: first.from, to: doc.line(j).to, lang: m[3], source: body.join('\n') + '\n', lineStart: n - 1, lineEnd: j - 1 });
		}
		n = j;
	}
	return out;
}

let docCounter = 0;

class BlockWidget extends WidgetType {
	constructor(
		readonly owner: CMMarkdownView,
		readonly b: Found,
	) {
		super();
	}

	/** Same language and same text: CodeMirror keeps the DOM that is already there. */
	eq(other: BlockWidget): boolean {
		return other.b.lang === this.b.lang && other.b.source === this.b.source;
	}

	ignoreEvent(): boolean {
		return LP.ignoreEvents;
	}

	toDOM(view: EditorView): HTMLElement {
		const dom = document.createElement('div');
		// (as Obsidian 1.14 builds it: the container names the language, the edit button sits in .embed-actions)
		dom.className = 'cm-preview-code-block cm-embed-block markdown-rendered cm-lang-' + this.b.lang;
		dom.contentEditable = 'false';
		const block = document.createElement('div');
		block.className = 'block-language-' + this.b.lang;
		dom.appendChild(block);
		const edit = document.createElement('div');
		edit.className = 'edit-block-button';
		edit.textContent = '</>';
		const select = (): void => {
			const pos = view.posAtDOM(dom);
			view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 3) } });
			view.focus();
		};
		edit.addEventListener('click', select);
		const actions = document.createElement('div');
		actions.className = 'embed-actions';
		actions.appendChild(edit);
		if (LP.buttonFirst) dom.insertBefore(actions, block);
		else dom.appendChild(actions);
		if (LP.clickSelects !== 'none') {
			dom.addEventListener(LP.clickSelects, (ev: Event) => {
				if (ev.defaultPrevented || ev.target === edit) return;
				LP.log.push(`widget ${LP.clickSelects}: cursor moved into the block`);
				select();
			});
		}
		const comp = new O.Component();
		comp.load();
		(dom as any)._owner = comp;
		const built = { lineStart: this.b.lineStart, lineEnd: this.b.lineEnd };
		const ctx = {
			docId: this.owner.docId,
			sourcePath: this.owner.file.path,
			frontmatter: null,
			addChild: (c: any) => comp.addChild(c),
			getSectionInfo: (_el: HTMLElement) => {
				if (LP.sectionInfo === 'null') return null;
				const text = view.state.doc.toString();
				if (LP.sectionInfo === 'stale') return { text, ...built };
				if (!dom.isConnected) return null;
				const start = view.state.doc.lineAt(view.posAtDOM(dom)).number - 1;
				return { text, lineStart: start, lineEnd: start + (built.lineEnd - built.lineStart) };
			},
		};
		const handler = this.owner.app._processors.get(this.b.lang);
		const run = (): void => {
			try {
				const p = handler(this.b.source, block, ctx);
				if (p && p.catch) p.catch((e: unknown) => console.error('processor failed', e));
			} catch (e) {
				console.error('processor failed', e);
			}
		};
		if (LP.syncRender) run();
		else void Promise.resolve().then(run);
		return dom;
	}

	destroy(dom: HTMLElement): void {
		const comp = (dom as any)._owner;
		if (LP.syncUnload) comp.unload();
		else setTimeout(() => comp.unload(), 0);
	}
}

const fromOutside = Annotation.define<boolean>();
const isUndo = Annotation.define<boolean>();

type Pos = { line: number; ch: number };

/** The part of Obsidian's Editor interface the plugin uses. */
class CMEditor {
	constructor(readonly view: CMMarkdownView) {}

	get cm(): EditorView {
		return this.view.cm;
	}

	getValue(): string {
		return this.cm.state.doc.toString();
	}

	lineCount(): number {
		return this.cm.state.doc.lines;
	}

	getLine(n: number): string {
		return this.cm.state.doc.line(n + 1).text;
	}

	off(pos: Pos): number {
		const doc = this.cm.state.doc;
		if (pos.line >= doc.lines) return doc.length;
		const l = doc.line(Math.max(1, pos.line + 1));
		return Math.min(l.to, l.from + Math.max(0, pos.ch));
	}

	getCursor(): Pos {
		const h = this.cm.state.selection.main.head;
		const l = this.cm.state.doc.lineAt(h);
		return { line: l.number - 1, ch: h - l.from };
	}

	setCursor(pos: Pos): void {
		this.cm.dispatch({ selection: { anchor: this.off(pos) } });
	}

	replaceRange(text: string, from: Pos, to?: Pos): void {
		this.cm.dispatch({ changes: { from: this.off(from), to: this.off(to ?? from), insert: text } });
	}
}

export class CMMarkdownView extends O.ItemView {
	file: any;
	cm: EditorView;
	editor: CMEditor;
	docId = 'cmdoc' + ++docCounter;
	dirty = false;
	_saving = false;
	_saveTimer: any = 0;
	history: ChangeSet[] = [];

	constructor(leaf: any, file: any) {
		super(leaf);
		this.file = file;
		this.contentEl.classList.add('markdown-source-view', 'mod-cm6', 'is-live-preview');
		this._header.textContent = file.basename + '  ·  live preview (CodeMirror)';
		const app = this.app;

		const build = (state: EditorState): DecorationSet => {
			const sel = state.selection.main;
			const ranges = [];
			for (const b of findBlocks(state, app)) {
				// the cursor or the selection touches the block: its source is shown instead
				if (sel.from <= b.to && sel.to >= b.from) continue;
				ranges.push(Decoration.replace({ widget: new BlockWidget(this, b), block: true }).range(b.from, b.to));
			}
			return Decoration.set(ranges);
		};
		const blocks = StateField.define<DecorationSet>({
			create: (state) => build(state),
			update: (deco, tr) => (tr.docChanged || tr.selection ? build(tr.state) : deco),
			provide: (f) => EditorView.decorations.from(f),
		});

		// Enough of an editor keymap to see whether keys pressed on a board reach it.
		const say = (what: string): true => {
			LP.log.push('editor handled ' + what);
			return true;
		};
		const keys = keymap.of([
			{
				key: 'Backspace',
				run: (v) => {
					const s = v.state.selection.main;
					if (s.empty && s.from === 0) return true;
					v.dispatch({ changes: { from: s.empty ? s.from - 1 : s.from, to: s.to }, userEvent: 'delete.backward' });
					return say('Backspace');
				},
			},
			{
				key: 'Delete',
				run: (v) => {
					const s = v.state.selection.main;
					if (s.empty && s.from >= v.state.doc.length) return true;
					v.dispatch({ changes: { from: s.from, to: s.empty ? s.to + 1 : s.to }, userEvent: 'delete.forward' });
					return say('Delete');
				},
			},
			{
				key: 'Enter',
				run: (v) => {
					v.dispatch(v.state.replaceSelection('\n'));
					return say('Enter');
				},
			},
			{
				key: 'Mod-a',
				run: (v) => {
					v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
					return say('select-all');
				},
			},
			{
				key: 'Mod-z',
				run: () => {
					if (this.undo()) say('undo');
					return true;
				},
			},
			{
				key: 'ArrowLeft',
				run: (v) => {
					v.dispatch({ selection: { anchor: Math.max(0, v.state.selection.main.head - 1) } });
					return say('ArrowLeft');
				},
			},
		]);

		const listener = EditorView.updateListener.of((u) => {
			if (!u.docChanged) return;
			for (const tr of u.transactions) {
				if (tr.docChanged && !tr.annotation(isUndo) && !tr.annotation(fromOutside)) this.history.push(tr.changes.invert(tr.startState.doc));
			}
			const text = u.state.doc.toString();
			const outside = u.transactions.some((tr) => tr.annotation(fromOutside));
			if (LP.editorChange === 'all' || (LP.editorChange === 'own' && !outside)) app.workspace.trigger('editor-change', this.editor, this);
			// the mock's reading views of the same note follow (at once, or with _lagReading when the file is written)
			if (!app._lagReading) {
				for (const v of app.workspace._markdownViews(this.file.path)) {
					if (v !== this && v.renderer) {
						v.data = text;
						v.renderer.set(text);
					}
				}
			}
			if (outside) return;
			// other CodeMirror panes on the same note
			const changes = u.changes;
			const push = (): void => {
				for (const v of app.workspace._markdownViews(this.file.path)) {
					if (v !== this && v instanceof CMMarkdownView) v.cm.dispatch({ changes, annotations: fromOutside.of(true) });
				}
			};
			if (LP.mirror === 'sync') push();
			else void Promise.resolve().then(push);
			this.dirty = true;
			clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => void this.save(), app._autosave ?? 2000);
		});

		this.cm = new EditorView({
			parent: this.contentEl,
			state: EditorState.create({
				doc: app.vault.files.get(file.path).data,
				extensions: [blocks, keys, listener, EditorView.lineWrapping, O.editorLivePreviewField.init(() => true), O.editorInfoField.init(() => ({ file })), ...(app._editorExtensions ?? [])],
			}),
		});
		this.editor = new CMEditor(this);
	}

	getViewType(): string {
		return 'markdown';
	}

	getMode(): string {
		return 'source';
	}

	/** Take back the last change made in this pane (what Ctrl+Z does here). */
	undo(): boolean {
		const inverse = this.history.pop();
		if (inverse) this.cm.dispatch({ changes: inverse, annotations: isUndo.of(true) });
		return !!inverse;
	}

	get data(): string {
		return this.cm.state.doc.toString();
	}

	set data(_v: string) {
		// (the mock's views push their text at every view of the note; this one keeps its own)
	}

	getViewData(): string {
		return this.data;
	}

	async save(): Promise<void> {
		clearTimeout(this._saveTimer);
		if (!this.dirty) return;
		this.dirty = false;
		this._saving = true;
		await this.app.vault.modify(this.file, this.data);
		this._saving = false;
	}

	/** The file changed on disk. */
	_external(data: string): void {
		if (this.data === data) return;
		this.dirty = false;
		this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: data }, annotations: fromOutside.of(true) });
	}

	unload(): void {
		this.cm.destroy();
		super.unload();
	}
}

// the plugin asks `leaf.view instanceof MarkdownView`
Object.defineProperty(O.MarkdownView, Symbol.hasInstance, {
	value: (v: unknown) => v instanceof CMMarkdownView || (v != null && Object.prototype.isPrototypeOf.call(O.MarkdownView.prototype, v)),
});

/** Open a note in a new pane, as a CodeMirror live preview. */
window.openLivePreview = (path: string): CMMarkdownView => {
	const app = window.harness.app;
	const leaf = new O.WorkspaceLeaf(app, app._dom.main);
	app.workspace._leaves.push(leaf);
	leaf._setView(new CMMarkdownView(leaf, app.vault.getAbstractFileByPath(path)));
	window.harness.views.push(leaf.view);
	return leaf.view;
};
