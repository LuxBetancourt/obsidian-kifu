/**
 * A Bases view: the notes of a base as cards, each with the first board in the note (or
 * the game in an SGF file), playable, with the note's name and the properties chosen for
 * the view, as the Cards view shows them.
 */

import { BasesEntry, BasesPropertyId, BasesView, Component, Keymap, QueryController, TFile } from 'obsidian';
import type KifuPlugin from './main';
import { firstEmbed, mountDetached } from './linked';
import { ImportError } from './importing';
import { composeBlock, parseBlock, setOption } from './options';
import { findGames } from './sgf';
import { read, resolveSgf } from './store';

export const BASES_VIEW = 'kifu-boards';

/**
 * The board a card shows: the first one in the note, whichever comes first, a block (one
 * on an SGF file brings the file's game along) or an embedded link to a game or problem
 * (fetched, as in the note); or an SGF file itself. Null: there is none. A link that can
 * not be fetched throws an ImportError saying why.
 */
export async function firstBoard(plugin: KifuPlugin, file: TFile): Promise<string | null> {
	const app = plugin.app;
	const ext = file.extension.toLowerCase();
	if (ext === 'sgf') {
		const text = await app.vault.cachedRead(file);
		return findGames(text).length ? text : null;
	}
	if (ext !== 'md') return null;
	const text = await app.vault.cachedRead(file);
	const block = read(text).blocks[0];
	const embed = firstEmbed(text);
	if (embed && (!block || embed.line < block.open)) return plugin.fetchLinked(embed.target);
	if (!block) return null;
	const parsed = parseBlock(block.body);
	if (!parsed.opts.sgf) return block.body;
	const sgf = resolveSgf(app, parsed.opts.sgf, file.path);
	if (!sgf) return null;
	return composeBlock(setOption(parsed.header, 'sgf', null), await app.vault.cachedRead(sgf), null, null);
}

export class KifuBasesView extends BasesView {
	type = BASES_VIEW;
	#plugin: KifuPlugin;
	#root: HTMLElement;
	/** The cards on screen, by file: kept while their note is unchanged (a problem half solved stays). */
	#cards = new Map<string, { el: HTMLElement; mtime: number; key: string; unload: () => void }>();
	#observer: IntersectionObserver | null = null;

	constructor(controller: QueryController, containerEl: HTMLElement, plugin: KifuPlugin) {
		super(controller);
		this.#plugin = plugin;
		this.#root = containerEl.createDiv({ cls: 'kifu-bases' });
	}

	onload(): void {
		// boards are drawn when their card comes into sight
		this.#observer = new IntersectionObserver(
			(seen) => {
				for (const e of seen) {
					if (!e.isIntersecting) continue;
					this.#observer?.unobserve(e.target);
					(e.target as HTMLElement & { kifuDraw?: () => void }).kifuDraw?.();
				}
			},
			{ rootMargin: '400px' },
		);
	}

	onunload(): void {
		this.#observer?.disconnect();
		for (const c of this.#cards.values()) c.unload();
		this.#cards.clear();
	}

	onDataUpdated(): void {
		const scale = Number(this.config.get('boardScale')) || 60;
		const playable = this.config.get('playable') !== false;
		this.#root.toggleClass('is-static', !playable);
		this.#root.style.setProperty('--kifu-card-width', `${Math.round(scale * 3.8)}px`);
		const props = this.config.getOrder().filter((p) => p !== 'file.name');
		// (what a card shows besides its board: when this changes, every card is made again)
		const key = `${scale}|${playable}|${props.join(',')}`;
		const kept = new Set<string>();
		this.#root.empty();
		for (const group of this.data.groupedData) {
			if (group.hasKey() && group.key) {
				const h = this.#root.createDiv({ cls: 'kifu-bases-group' });
				group.key.renderTo(h, this.app.renderContext);
			}
			const grid = this.#root.createDiv({ cls: 'kifu-bases-grid' });
			for (const entry of group.entries) {
				const card = this.#card(entry, props, scale, playable, key);
				grid.appendChild(card);
				kept.add(entry.file.path);
			}
		}
		for (const [path, c] of this.#cards) {
			if (!kept.has(path)) {
				c.unload();
				this.#cards.delete(path);
			}
		}
	}

	/** A card: the note's board, its name, its properties. Kept as it is while its note is unchanged. */
	#card(entry: BasesEntry, props: BasesPropertyId[], scale: number, playable: boolean, key: string): HTMLElement {
		const file = entry.file;
		const old = this.#cards.get(file.path);
		if (old && old.mtime === file.stat.mtime && old.key === key) {
			this.#fillProps(old.el, entry, props);
			return old.el;
		}
		old?.unload();
		const el = createDiv({ cls: 'kifu-bases-card' });
		const boardEl = el.createDiv({ cls: 'kifu-bases-board' });
		const title = el.createDiv({ cls: 'kifu-bases-title', text: file.basename });
		const open = (ev: MouseEvent): void => {
			void this.app.workspace.openLinkText(file.path, '', Keymap.isModEvent(ev));
		};
		title.addEventListener('click', open);
		if (!playable) boardEl.addEventListener('click', open);
		el.createDiv({ cls: 'kifu-bases-props' });
		this.#fillProps(el, entry, props);
		// the board itself: once the card is in sight
		const owner = new BoardHolder();
		this.addChild(owner);
		(boardEl as HTMLElement & { kifuDraw?: () => void }).kifuDraw = () => void this.#draw(owner, boardEl, file, scale);
		this.#observer?.observe(boardEl);
		this.#cards.set(file.path, {
			el,
			mtime: file.stat.mtime,
			key,
			unload: () => {
				this.#observer?.unobserve(boardEl);
				this.removeChild(owner);
			},
		});
		return el;
	}

	#fillProps(el: HTMLElement, entry: BasesEntry, props: BasesPropertyId[]): void {
		const list = el.querySelector<HTMLElement>('.kifu-bases-props');
		if (!list) return;
		list.empty();
		for (const p of props) {
			const value = entry.getValue(p);
			if (!value || !value.isTruthy()) continue;
			const row = list.createDiv({ cls: 'kifu-bases-prop' });
			row.createSpan({ cls: 'kifu-bases-prop-name', text: this.config.getDisplayName(p) });
			value.renderTo(row.createSpan({ cls: 'kifu-bases-prop-value' }), this.app.renderContext);
		}
	}

	async #draw(owner: BoardHolder, el: HTMLElement, file: TFile, scale: number): Promise<void> {
		await this.#plugin.settingsLoaded();
		let body: string | null = null;
		try {
			body = await firstBoard(this.#plugin, file);
		} catch (e) {
			if (!owner.alive) return;
			// (a board from a link that could not be fetched: why, in its place)
			el.createDiv({ cls: ['kifu-bases-none', 'is-error'], text: `Kifu: ${e instanceof ImportError ? e.message : `could not draw the board of ${file.basename}.`}` });
			if (!(e instanceof ImportError)) console.error('Kifu: board for a base', e);
			return;
		}
		if (!owner.alive) return;
		if (body === null) {
			el.createDiv({ cls: 'kifu-bases-none', text: 'No board in this note.' });
			return;
		}
		// the view's own board size, whatever the block says
		const parsed = parseBlock(body);
		const sized = composeBlock(setOption(parsed.header, 'scale', `${scale}%`), parsed.rest, null, null);
		mountDetached(owner, el, this.#plugin, file.path, sized, `base:${file.path}`, 'this board is shown in a base. Open the note to edit it.');
	}
}

/** What a card's board lives in: gone when the card is. */
class BoardHolder extends Component {
	alive = true;

	onunload(): void {
		this.alive = false;
	}
}
