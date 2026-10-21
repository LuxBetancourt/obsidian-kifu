/**
 * After an update, once: what is new, each feature with a short animation of it. Not on a
 * fresh install (everything is new then; the README says it better), and not at all
 * when the setting is off. The animations are fetched from the plugin's repository, at
 * the version's own tag, only when the window is shown: they are not in the plugin, so
 * every start of Obsidian does not carry them.
 */

import { App, Modal } from 'obsidian';

export interface News {
	/** The version that brought it. */
	version: string;
	title: string;
	text: string;
	/** Its animation: a file in docs/whatsnew of the repository. */
	gif: string;
}

/** Newest first. A feature belongs to the version that brought it. */
export const NEWS: News[] = [
	{
		version: '1.6.6',
		title: 'Open SGF files',
		text: 'Click an SGF file in the file explorer, or a link to one, and it opens in a tab of its own as a board: play through it, or unlock it and edit the file. A file of several games has a picker. Right-click a folder for New SGF, and, while editing, the Game info button in the move tree panel for the players, ranks, komi and result.',
		gif: 'viewer.gif',
	},
	{
		version: '1.6.4',
		title: 'Drag a stone to move it',
		text: 'While editing, drag the stone of the current move to another point. The moves after it stay as they are, and one undo puts it back.',
		gif: 'drag.gif',
	},
	{
		version: '1.6.4',
		title: 'Embed an SGF file at a move',
		text: 'Embed an SGF file of your vault the way you embed an image: ![[game.sgf]]. Add #50 to open it at move 50, or a point, #Q16, to open it at the first move played there. Links to SGF files on the web take the same #.',
		gif: 'embed.gif',
	},
	{
		version: '1.6.4',
		title: 'Josekipedia',
		text: 'Embed a link to a position on Josekipedia, or import one (right-click, Kifu): the moves that lead to it, the comments its contributors wrote, and the moves that may follow, to play through.',
		gif: 'josekipedia.gif',
	},
];

const REPO = 'https://raw.githubusercontent.com/LuxBetancourt/obsidian-kifu';

/** Is version `a` later than `b`? ("1.10.0" is later than "1.9.2"; "" is earlier than any.) */
export function later(a: string, b: string): boolean {
	const pa = a.split('.').map((n) => parseInt(n) || 0);
	const pb = b.split('.').map((n) => parseInt(n) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d > 0;
	}
	return false;
}

/** What is new for someone who last saw version `seen` and has `now`: brought after the one, up to the other. */
export function newsSince(seen: string, now: string): News[] {
	return NEWS.filter((n) => later(n.version, seen) && !later(n.version, now));
}

export class WhatsNew extends Modal {
	#version: string;
	#items: News[];
	#stop: () => void;

	/** `stop` turns these windows off (the link at the bottom). */
	constructor(app: App, version: string, items: News[], stop: () => void) {
		super(app);
		this.#version = version;
		this.#items = items;
		this.#stop = stop;
	}

	onOpen(): void {
		this.setTitle(`What's new in Kifu ${this.#version}`);
		const el = this.contentEl;
		el.addClass('kifu-news');
		for (const n of this.#items) {
			const item = el.createDiv({ cls: 'kifu-news-item' });
			item.createEl('h3', { text: n.title });
			item.createEl('p', { text: n.text });
			const img = item.createEl('img', {
				cls: 'kifu-news-gif',
				attr: { src: `${REPO}/${n.version}/docs/whatsnew/${n.gif}`, alt: n.title, loading: 'lazy' },
			});
			// (offline, say: a line instead of a broken picture)
			img.addEventListener('error', () => img.replaceWith(createDiv({ cls: 'kifu-news-missing', text: 'The animation could not be loaded.' })));
		}
		const foot = el.createDiv({ cls: 'modal-button-container' });
		const off = foot.createEl('button', { text: "Don't show this after updates" });
		off.addEventListener('click', () => {
			this.#stop();
			this.close();
		});
		const ok = foot.createEl('button', { cls: 'mod-cta', text: 'Close' });
		ok.addEventListener('click', () => this.close());
		window.setTimeout(() => ok.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
