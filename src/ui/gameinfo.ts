/**
 * The game's details (players, ranks, komi, result…) in a form: what an SGF file keeps
 * in its first node. Saved as one edit of the board; empty fields are left out.
 */

import { App, Modal, Setting } from 'obsidian';
import { GAME_INFO } from '../session';

export class GameInfoPrompt extends Modal {
	#info: Record<string, string>;
	#done: (info: Record<string, string>) => void;

	constructor(app: App, info: Record<string, string>, done: (info: Record<string, string>) => void) {
		super(app);
		this.#info = { ...info };
		this.#done = done;
	}

	onOpen(): void {
		this.setTitle('Game info');
		const el = this.contentEl;
		el.addClass('kifu-game-info');
		const save = (): void => {
			this.close();
			this.#done(this.#info);
		};
		let first: HTMLInputElement | null = null;
		for (const [id, name] of GAME_INFO) {
			new Setting(el).setName(name).addText((t) => {
				t.setValue(this.#info[id] ?? '').onChange((v) => {
					this.#info[id] = v;
				});
				if (id === 'KM') t.setPlaceholder('6.5');
				if (id === 'DT') t.setPlaceholder('2026-10-21');
				if (id === 'RE') t.setPlaceholder('B+R, W+3.5');
				t.inputEl.dataset.prop = id;
				t.inputEl.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter') {
						ev.preventDefault();
						save();
					}
				});
				first ??= t.inputEl;
			});
		}
		const row = el.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		row.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', save);
		const focus = first as HTMLInputElement | null;
		if (focus) window.setTimeout(() => focus.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
