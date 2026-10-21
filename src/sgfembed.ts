/**
 * `![[game.sgf]]`: an SGF file of the vault embedded in a note is drawn as a board. After
 * a `#`, where it opens: a move number (`#50`), or a point (`#Q16`), for the first move of
 * the main line played there. The board is played like any other and follows the file
 * as it changes, but is not edited: the file opened by itself, or a `kifu` block with
 * `sgf: [[game.sgf]]`, is for that.
 */

import { App, Component, TFile } from 'obsidian';
import type KifuPlugin from './main';
import { mountDetached } from './linked';
import { moveFragment } from './options';
import { loadGame, refreshGame } from './store';

/** What Obsidian hands an embed of a file type it has been told about. (Not in its typings.) */
interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	sourcePath?: string;
}
interface EmbedRegistry {
	registerExtension(ext: string, make: (ctx: EmbedContext, file: TFile, subpath: string) => Component): void;
	unregisterExtension(ext: string): void;
}

/**
 * Tell Obsidian to embed `.sgf` files as boards. Obsidian has no public way of doing
 * this; its embed registry is what it uses for its own file types. Where that is not
 * there, or another plugin has taken `.sgf`, nothing changes: the embed stays a link.
 */
export function registerSgfEmbeds(plugin: KifuPlugin): void {
	const reg = (plugin.app as unknown as { embedRegistry?: Partial<EmbedRegistry> }).embedRegistry;
	if (typeof reg?.registerExtension !== 'function') return;
	try {
		reg.registerExtension('sgf', (ctx, file, subpath) => new SgfEmbed(ctx.containerEl, plugin, file, subpath, ctx.sourcePath ?? ''));
	} catch {
		return;
	}
	plugin.register(() => reg.unregisterExtension?.('sgf'));
}

class SgfEmbed extends Component {
	#el: HTMLElement;
	#plugin: KifuPlugin;
	#file: TFile;
	#move: string | null;
	#notePath: string;
	#shown = false;

	constructor(el: HTMLElement, plugin: KifuPlugin, file: TFile, subpath: string, notePath: string) {
		super();
		this.#el = el;
		this.#plugin = plugin;
		this.#file = file;
		this.#move = moveFragment(subpath.replace(/^#/, ''));
		this.#notePath = notePath || file.path;
	}

	/** Obsidian asks for the file to be shown (once the embed is on the page). */
	loadFile(): void {
		if (this.#shown) return;
		this.#shown = true;
		void this.#show();
	}

	async #show(): Promise<void> {
		const plugin = this.#plugin;
		await plugin.settingsLoaded();
		if (!this.#shown) return;
		const el = this.#el;
		el.empty();
		el.addClass('kifu-linked');
		const body = `sgf: ${this.#file.path}` + (this.#move ? `\nmove: ${this.#move}` : '');
		const s = mountDetached(this, el, plugin, this.#notePath, body, this.#file.path, `this board is an embedded SGF file. To edit it, open the file itself, or show it with a kifu block: sgf: [[${this.#file.basename}]].`);
		await loadGame(plugin.app, s);
		s.emit();
		// the file changes (another program, or a block that edits it): so does the board
		this.registerEvent(
			plugin.app.vault.on('modify', (f) => {
				if (f.path === s.filePath) void refreshGame(plugin.app, s).then(() => s.emit());
			}),
		);
	}

	onunload(): void {
		this.#shown = false;
	}
}
