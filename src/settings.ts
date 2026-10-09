/** The settings page. Everything here is a default that a single board can override. */

import { App, PluginSettingTab, Setting, requireApiVersion } from 'obsidian';
import type KifuPlugin from './main';
import { BASE_CELL, DEFAULT_SETTINGS, KifuSettings } from './config';
import { Session } from './session';
import { BoardSvg } from './ui/boardsvg';
import { clear, el } from './ui/dom';

// A classic (star point, knight's approach; then knight's answer, slide, 3-3, extension),
// as a position with four moves played on it, so that the numbering has something to show.
const SAMPLE = 'view: top-right 11x9\n(;SZ[19]AB[pd]AW[nc];B[qf];W[pb];B[qc];W[kc])';

/** Bring stored data back into shape: unknown keys dropped, wrong types replaced by defaults. */
export function sanitize(data: unknown): KifuSettings {
	const out: KifuSettings = { ...DEFAULT_SETTINGS };
	if (!data || typeof data !== 'object') return out;
	const d = data as Record<string, unknown>;
	const pick = <K extends keyof KifuSettings>(key: K, ok: (v: unknown) => boolean): void => {
		if (ok(d[key])) out[key] = d[key] as KifuSettings[K];
	};
	const bool = (v: unknown) => typeof v === 'boolean';
	const oneOf = (...opts: unknown[]) => (v: unknown) => opts.includes(v);
	pick('scale', (v) => typeof v === 'number' && v >= 0.25 && v <= 4);
	pick('style', oneOf('paper', 'theme'));
	pick('coords', bool);
	pick('view', oneOf('auto', 'full'));
	pick('numberPlayed', bool);
	pick('align', oneOf('left', 'center', 'right'));
	pick('boardSize', (v) => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 52);
	pick('showComments', bool);
	pick('reply', oneOf('first', 'random'));
	pick('replyDelay', (v) => typeof v === 'number' && v >= 0 && v <= 5000);
	pick('revealPanel', bool);
	pick('hideAnswers', bool);
	return out;
}

export class KifuSettingTab extends PluginSettingTab {
	#plugin: KifuPlugin;

	constructor(app: App, plugin: KifuPlugin) {
		super(app, plugin);
		this.#plugin = plugin;
		// (shown beside the tab's name; older versions have no such thing)
		if (requireApiVersion('1.11.0')) this.icon = 'kifu-tree';
	}

	display(): void {
		clear(this.containerEl);
		void this.#plugin.settingsLoaded().then(() => this.#build());
	}

	#build(): void {
		const root = this.containerEl;
		clear(root);
		const s = this.#plugin.settings;

		// A sample board that follows the settings as they change.
		const sampleBox = el(root, 'div', 'kifu kifu-sample');
		const frame = el(sampleBox, 'div', 'kifu-frame');
		const board = new BoardSvg(frame);
		// (it is only ever looked at: nothing to save, nothing to wait for)
		const sample = new Session({ settings: s, requestSave: () => undefined, later: () => () => undefined }, '', SAMPLE);
		sample.goto(sample.home);
		const redraw = (): void => {
			sampleBox.className = `kifu kifu-sample kifu-${s.style} kifu-${s.align}`;
			sample.refresh();
			sample.last();
			board.draw(sample.model(), { cell: Math.max(6, Math.round(BASE_CELL * s.scale)), coords: s.coords });
		};
		redraw();
		const save = (): void => {
			redraw();
			void this.#plugin.saveSettings();
		};

		const scaleDesc = (): string =>
			`How big boards are drawn: ${Math.round(s.scale * 100)}%. One board can differ with a line such as "scale: 80%".`;
		const scale = new Setting(root)
			.setName('Board scale')
			.setDesc(scaleDesc())
			.addSlider((c) =>
				c
					.setLimits(50, 250, 5)
					.setValue(Math.round(s.scale * 100))
					.onChange((v) => {
						s.scale = v / 100;
						scale.setDesc(scaleDesc());
						save();
					}),
			);

		new Setting(root)
			.setName('Colors')
			.setDesc('Black ink on white paper like a book, or the colors of your theme. Per board: "style: paper" or "style: theme".')
			.addDropdown((c) =>
				c
					.addOption('paper', 'White paper')
					.addOption('theme', 'Follow the theme')
					.setValue(s.style)
					.onChange((v) => {
						s.style = v === 'theme' ? 'theme' : 'paper';
						save();
					}),
			);

		new Setting(root)
			.setName('Part of the board shown')
			.setDesc('Crop to where the stones are, or always show the whole board. Per board: "view: top-right", "view: full", and so on.')
			.addDropdown((c) =>
				c
					.addOption('auto', 'Crop to the stones')
					.addOption('full', 'Whole board')
					.setValue(s.view)
					.onChange((v) => {
						s.view = v === 'full' ? 'full' : 'auto';
						save();
					}),
			);

		new Setting(root)
			.setName('Coordinates')
			.setDesc('Letters and numbers along the edge. Per board: "coords: on" or "coords: off".')
			.addToggle((c) =>
				c.setValue(s.coords).onChange((v) => {
					s.coords = v;
					save();
				}),
			);

		new Setting(root)
			.setName('Alignment')
			.setDesc('Where a board sits in the note. Per board: "align: left".')
			.addDropdown((c) =>
				c
					.addOption('center', 'Center')
					.addOption('left', 'Left')
					.addOption('right', 'Right')
					.setValue(s.align)
					.onChange((v) => {
						s.align = v === 'left' || v === 'right' ? v : 'center';
						save();
					}),
			);

		new Setting(root)
			.setName('New board size')
			.setDesc('Size of a board that has nothing on it yet. Per board: "size: 13" or "size: 13x9".')
			.addDropdown((c) =>
				c
					.addOption('19', '19 × 19')
					.addOption('13', '13 × 13')
					.addOption('9', '9 × 9')
					.setValue(String(s.boardSize))
					.onChange((v) => {
						s.boardSize = parseInt(v) || 19;
						save();
					}),
			);

		new Setting(root).setName('Playing a position out').setHeading();

		new Setting(root)
			.setName('Number the moves you play')
			.setDesc('Stones played on a locked board are numbered from 1. Otherwise only the latest one is flagged. Per board: "numbers: on" or "numbers: off".')
			.addToggle((c) =>
				c.setValue(s.numberPlayed).onChange((v) => {
					s.numberPlayed = v;
					save();
				}),
			);

		new Setting(root)
			.setName('Show comments under the board')
			.setDesc('The comment saved with the current move. It is always shown in the move tree panel. Per board: "comments: off".')
			.addToggle((c) =>
				c.setValue(s.showComments).onChange((v) => {
					s.showComments = v;
					save();
				}),
			);

		new Setting(root)
			.setName('Replies')
			.setDesc('When a saved line has more than one answer to your move: always play the first, or pick one at random.')
			.addDropdown((c) =>
				c
					.addOption('first', 'First saved answer')
					.addOption('random', 'Random')
					.setValue(s.reply)
					.onChange((v) => {
						s.reply = v === 'random' ? 'random' : 'first';
						save();
					}),
			);

		const delayDesc = (): string => `Pause before the answer is played: ${s.replyDelay} ms.`;
		const delay = new Setting(root)
			.setName('Reply delay')
			.setDesc(delayDesc())
			.addSlider((c) =>
				c
					.setLimits(0, 1500, 50)
					.setValue(s.replyDelay)
					.onChange((v) => {
						s.replyDelay = v;
						delay.setDesc(delayDesc());
						save();
					}),
			);

		new Setting(root)
			.setName('Keep answers out of the move tree')
			.setDesc('While a problem is locked, the panel shows only the moves played so far. Its eye button shows the saved lines.')
			.addToggle((c) =>
				c.setValue(s.hideAnswers).onChange((v) => {
					s.hideAnswers = v;
					save();
				}),
			);

		new Setting(root).setName('Editing').setHeading();

		new Setting(root)
			.setName('Open the move tree when a board is unlocked')
			.setDesc('Brings the panel in the right sidebar forward, where comments are written.')
			.addToggle((c) =>
				c.setValue(s.revealPanel).onChange((v) => {
					s.revealPanel = v;
					save();
				}),
			);
	}
}
