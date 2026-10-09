/** The settings page. Everything here is a default that a single board can override. */

import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type KifuPlugin from './main';
import { BASE_CELL, DEFAULT_SETTINGS, KifuSettings } from './config';
import { Session } from './session';
import { BoardSvg } from './ui/boardsvg';
import { el } from './ui/dom';

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
	/** Redraws the sample board, while it is on screen. */
	#redraw: (() => void) | null = null;

	constructor(app: App, plugin: KifuPlugin) {
		super(app, plugin);
		this.#plugin = plugin;
		this.icon = 'kifu-tree';
	}

	/*
	 * Obsidian draws the page from these definitions and indexes them for its settings
	 * search. They are asked for once when the plugin starts, so building them reads
	 * nothing: the settings themselves are read when the page is first shown.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Preview',
				desc: 'A board drawn with the settings below.',
				searchable: false,
				render: (setting) => this.#sample(setting.controlEl),
			},
			{
				name: 'Board scale',
				desc: 'How big boards are drawn, in percent. One board can differ with a line such as "scale: 80%".',
				control: { type: 'slider', key: 'scale', min: 50, max: 250, step: 5 },
			},
			{
				name: 'Colors',
				desc: 'Black ink on white paper like a book, or the colors of your theme. Per board: "style: paper" or "style: theme".',
				control: { type: 'dropdown', key: 'style', options: { paper: 'White paper', theme: 'Follow the theme' } },
			},
			{
				name: 'Part of the board shown',
				desc: 'Crop to where the stones are, or always show the whole board. Per board: "view: top-right", "view: full", and so on.',
				control: { type: 'dropdown', key: 'view', options: { auto: 'Crop to the stones', full: 'Whole board' } },
			},
			{
				name: 'Coordinates',
				desc: 'Letters and numbers along the edge. Per board: "coords: on" or "coords: off".',
				control: { type: 'toggle', key: 'coords' },
			},
			{
				name: 'Alignment',
				desc: 'Where a board sits in the note. Per board: "align: left".',
				control: { type: 'dropdown', key: 'align', options: { center: 'Center', left: 'Left', right: 'Right' } },
			},
			{
				name: 'New board size',
				desc: 'Size of a board that has nothing on it yet. Per board: "size: 13" or "size: 13x9".',
				control: { type: 'dropdown', key: 'boardSize', options: { '19': '19 × 19', '13': '13 × 13', '9': '9 × 9' } },
			},
			{
				type: 'group',
				heading: 'Playing a position out',
				items: [
					{
						name: 'Number the moves you play',
						desc: 'Stones played on a locked board are numbered from 1. Otherwise only the latest one is flagged. Per board: "numbers: on" or "numbers: off".',
						control: { type: 'toggle', key: 'numberPlayed' },
					},
					{
						name: 'Show comments under the board',
						desc: 'The comment saved with the current move. It is always shown in the move tree panel. Per board: "comments: off".',
						control: { type: 'toggle', key: 'showComments' },
					},
					{
						name: 'Replies',
						desc: 'When a saved line has more than one answer to your move: always play the first, or pick one at random.',
						control: { type: 'dropdown', key: 'reply', options: { first: 'First saved answer', random: 'Random' } },
					},
					{
						name: 'Reply delay',
						desc: 'Pause before the answer is played, in milliseconds.',
						control: { type: 'slider', key: 'replyDelay', min: 0, max: 1500, step: 50 },
					},
					{
						name: 'Keep answers out of the move tree',
						desc: 'While a problem is locked, the panel shows only the moves played so far. Its eye button shows the saved lines.',
						control: { type: 'toggle', key: 'hideAnswers' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Editing',
				items: [
					{
						name: 'Open the move tree when a board is unlocked',
						desc: 'Brings the panel in the right sidebar forward, where comments are written.',
						control: { type: 'toggle', key: 'revealPanel' },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const plugin = this.#plugin;
		if (!plugin.settingsReady) {
			// First time the page is on screen: read the settings, then draw it again with
			// them. (When Obsidian only indexes the page, nothing is on screen and nothing is read.)
			window.setTimeout(() => {
				if (this.containerEl.isConnected) void plugin.settingsLoaded().then(() => this.update());
			}, 0);
		}
		const s = plugin.settings;
		// (the slider counts in percent, the dropdown in text)
		if (key === 'scale') return Math.round(s.scale * 100);
		if (key === 'boardSize') return String(s.boardSize);
		return s[key as keyof KifuSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const plugin = this.#plugin;
		await plugin.settingsLoaded();
		const v = key === 'scale' ? Number(value) / 100 : key === 'boardSize' ? parseInt(String(value)) : value;
		const checked = sanitize({ ...plugin.settings, [key]: v });
		// a value that does not fit (or a key we do not have) leaves the settings as they were
		if (!(key in checked) || checked[key as keyof KifuSettings] !== v) return;
		Object.assign(plugin.settings, checked);
		this.#redraw?.();
		await plugin.saveSettings();
	}

	/** A sample board that follows the settings as they change. */
	#sample(parent: HTMLElement): () => void {
		const s = this.#plugin.settings;
		const sampleBox = el(parent, 'div', 'kifu kifu-sample');
		const frame = el(sampleBox, 'div', 'kifu-frame');
		const board = new BoardSvg(frame);
		// (it is only ever looked at: nothing to save, nothing to wait for)
		const sample = new Session({ settings: s, requestSave: () => undefined, later: () => () => undefined }, '', SAMPLE);
		const redraw = (): void => {
			sampleBox.className = `kifu kifu-sample kifu-${s.style} kifu-${s.align}`;
			sample.refresh();
			sample.last();
			board.draw(sample.model(), { cell: Math.max(6, Math.round(BASE_CELL * s.scale)), coords: s.coords });
		};
		redraw();
		this.#redraw = redraw;
		return () => {
			if (this.#redraw === redraw) this.#redraw = null;
		};
	}
}
