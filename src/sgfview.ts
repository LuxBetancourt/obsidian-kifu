/**
 * An SGF file opened by itself, in a tab of its own (from the file explorer, or a link
 * to it): a board, as large as the tab allows, played and edited like a board in a note.
 * Edits go into the file. What only an option line can say (the crop, a numbered figure,
 * where the board opens, the problem and shuffle switches) has no place in an SGF file,
 * so those tools are not offered here. A file that holds several games has a picker.
 */

import { Component, FileView, MarkdownPostProcessorContext, MarkdownRenderChild, TFile, WorkspaceLeaf } from 'obsidian';
import type KifuPlugin from './main';
import { Session } from './session';
import { findGames } from './sgf';
import { decodeSgf } from './sgflink';
import { loadGame, refreshGame, saveSession } from './store';
import { BoardView } from './ui/boardview';

export const SGF_VIEW = 'kifu-sgf';

export class SgfView extends FileView {
	#plugin: KifuPlugin;
	/** What is shown for the file now; unloaded when another file (or game) takes its place. */
	#shown: Component | null = null;
	#game = 1;

	constructor(leaf: WorkspaceLeaf, plugin: KifuPlugin) {
		super(leaf);
		this.#plugin = plugin;
		this.allowNoFile = false;
	}

	getViewType(): string {
		return SGF_VIEW;
	}

	getIcon(): string {
		return 'kifu-tree';
	}

	getDisplayText(): string {
		return this.file?.basename ?? 'SGF file';
	}

	canAcceptExtension(ext: string): boolean {
		return ext.toLowerCase() === 'sgf';
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.#game = 1;
		await this.#show(file);
	}

	async onUnloadFile(): Promise<void> {
		this.#clear();
		await Promise.resolve();
	}

	#clear(): void {
		if (this.#shown) this.removeChild(this.#shown);
		this.#shown = null;
		this.contentEl.empty();
	}

	async #show(file: TFile): Promise<void> {
		const plugin = this.#plugin;
		await plugin.settingsLoaded();
		this.#clear();
		const shown = (this.#shown = this.addChild(new Component()));
		const el = this.contentEl.createDiv({ cls: 'kifu-sgf-view' });

		// several games in the file (a problem collection): which one
		let games = 1;
		try {
			games = Math.max(1, findGames(decodeSgf(await this.app.vault.readBinary(file))).length);
		} catch {
			// (the board says what is wrong with the file)
		}
		if (this.#shown !== shown) return;
		if (games > 1) {
			const bar = el.createDiv({ cls: 'kifu-sgf-games' });
			const pick = bar.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Game' } });
			for (let n = 1; n <= games; n++) pick.createEl('option', { text: `Game ${n} of ${games}`, attr: { value: String(n) } });
			pick.value = String(this.#game);
			pick.addEventListener('change', () => {
				this.#game = parseInt(pick.value) || 1;
				void this.#show(file);
			});
		}

		const host = el.createDiv({ cls: 'kifu-sgf-board' });
		const body = `sgf: ${file.path}\nscale: fit` + (this.#game > 1 ? `\ngame: ${this.#game}` : '');
		const s = new Session(plugin, file.path, body);
		// (no block: the board belongs to no note, and the move tree panel takes it as it is)
		s.link = file.path;
		s.fileView = true;
		const ctx: MarkdownPostProcessorContext = {
			docId: '',
			sourcePath: file.path,
			frontmatter: null,
			getSectionInfo: () => null,
			addChild: (c: MarkdownRenderChild) => shown.addChild(c),
		};
		const view = new BoardView(host, plugin, ctx, body);
		shown.addChild(view);
		view.attach(s);
		await loadGame(this.app, s);
		s.emit();
		// The move tree panel follows the board of the tab that has the focus, without its
		// board being clicked first: now, if this tab is the one, and whenever it becomes it.
		const follow = (): void => {
			if (this.app.workspace.getActiveViewOfType(SgfView) === this && view.session === s) plugin.useSession(view);
		};
		follow();
		shown.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			if (leaf === this.leaf) follow();
		}));
		// the file changes (another program, or a block that edits it): so does the board
		shown.registerEvent(
			this.app.vault.on('modify', (f) => {
				if (f.path === s.filePath && !s.saving) void refreshGame(this.app, s).then(() => s.emit());
			}),
		);
		// Obsidian closing: an edit that is still waiting is written first
		shown.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				if (s.dirtyTree && !s.gone) tasks.add(() => saveSession(this.app, s, plugin.saveHooks).then(() => undefined));
			}),
		);
	}
}
