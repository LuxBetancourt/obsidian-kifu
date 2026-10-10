/**
 * Boards drawn from links: `![](https://online-go.com/game/123)` or a goproblems.com
 * problem. Fetched each time the note is shown (a while ago's answer is reused for a few
 * minutes), played like any other board, never edited: there is no block to write to.
 */

import { MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type KifuPlugin from './main';
import { problemId, problemUrl } from './goproblems';
import { ImportError } from './importing';
import { OgsTarget, ogsPage, ogsTarget } from './ogs';
import { Session } from './session';
import { BoardView } from './ui/boardview';

export type LinkTarget = { site: 'ogs'; ogs: OgsTarget; url: string } | { site: 'goproblems'; id: number; url: string };

/** The game or problem a link is to, when it is one a board can be drawn from. */
export function linkTarget(href: string): LinkTarget | null {
	const s = href.trim();
	if (!/^https?:\/\//i.test(s)) return null;
	if (/^https?:\/\/(www\.)?online-go\.com\//i.test(s)) {
		const t = ogsTarget(s, 'game');
		return t ? { site: 'ogs', ogs: t, url: ogsPage(t) } : null;
	}
	if (/^https?:\/\/(www\.)?goproblems\.com\//i.test(s)) {
		const id = problemId(s);
		return id ? { site: 'goproblems', id, url: problemUrl(id) } : null;
	}
	return null;
}

/** A board in place of a link: fetched, then drawn; or a line saying why it could not be. */
export class LinkedBoard extends MarkdownRenderChild {
	#plugin: KifuPlugin;
	#target: LinkTarget;
	#notePath: string;
	#ctx: MarkdownPostProcessorContext | null;
	#session: Session | null = null;
	#gone = false;

	constructor(containerEl: HTMLElement, plugin: KifuPlugin, target: LinkTarget, notePath: string, ctx: MarkdownPostProcessorContext | null) {
		super(containerEl);
		this.#plugin = plugin;
		this.#target = target;
		this.#notePath = notePath;
		this.#ctx = ctx;
	}

	onload(): void {
		this.containerEl.addClass('kifu-linked');
		const msg = this.containerEl.createDiv({ cls: 'kifu-linked-msg', text: `Kifu: fetching ${this.#target.url}…` });
		void this.#show(msg);
	}

	async #show(msg: HTMLElement): Promise<void> {
		const t = this.#target;
		try {
			await this.#plugin.settingsLoaded();
			const body = await this.#plugin.fetchLinked(t);
			if (this.#gone) return;
			msg.remove();
			const s = new Session(this.#plugin, this.#notePath, body);
			s.link = t.url;
			s.fixed = `this board is drawn from ${t.url}. To edit it, import it instead (right-click, then Kifu).`;
			this.#session = s;
			this.#plugin.linkedShown(s, true);
			// (a board in the editor has no section of the note to tell about)
			const stub: MarkdownPostProcessorContext = { docId: '', sourcePath: this.#notePath, frontmatter: null, getSectionInfo: () => null, addChild: (c: MarkdownRenderChild) => this.addChild(c) };
			const ctx = this.#ctx ?? stub;
			const view = new BoardView(this.containerEl, this.#plugin, ctx, body);
			this.addChild(view);
			view.attach(s);
		} catch (e) {
			if (this.#gone) return;
			msg.setText(`Kifu: ${e instanceof ImportError ? e.message : `could not draw ${t.url}.`}`);
			msg.addClass('is-error');
			if (!(e instanceof ImportError)) console.error('Kifu: board from a link', e);
		}
	}

	onunload(): void {
		this.#gone = true;
		if (this.#session) this.#plugin.linkedShown(this.#session, false);
	}
}
