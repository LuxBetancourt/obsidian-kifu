/**
 * Boards drawn from links: `![](https://online-go.com/game/123)` or a goproblems.com
 * problem. Fetched each time the note is shown (a while ago's answer is reused for a few
 * minutes), played like any other board, never edited: there is no block to write to.
 */

import { Component, MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type KifuPlugin from './main';
import { problemId, problemUrl } from './goproblems';
import { ImportError } from './importing';
import { OgsTarget, ogsPage, ogsTarget } from './ogs';
import { Session } from './session';
import { isSgfLink } from './sgflink';
import { ServerTarget, serverTarget } from './servers';
import { BoardView } from './ui/boardview';

export type LinkTarget =
	| { site: 'ogs'; ogs: OgsTarget; url: string }
	| { site: 'goproblems'; id: number; url: string }
	| { site: 'server'; server: ServerTarget; url: string }
	| { site: 'sgf'; url: string };

/** The game or problem a link is to, when it is one a board can be drawn from. */
export function linkTarget(href: string): LinkTarget | null {
	const s = href.trim();
	if (!/^https?:\/\//i.test(s)) return null;
	// other Go servers: Dragon Go Server, Fox, GoQuest, and OGS games as Stone.gs shows them
	const other = serverTarget(s);
	if (other?.server === 'stonegs-ogs') {
		const ogs: OgsTarget = { kind: 'game', id: other.ogsId };
		return { site: 'ogs', ogs, url: ogsPage(ogs) };
	}
	if (other) return { site: 'server', server: other, url: other.url };
	// an SGF file anywhere (a file server of one's own, say)
	if (isSgfLink(s)) return { site: 'sgf', url: s };
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

/**
 * A board that belongs to no block of the note (drawn from a link, or shown in a base):
 * played like any other, never edited (`why` says so to whoever tries). It lives as long
 * as `owner` does. `from` names where it came from.
 */
export function mountDetached(
	owner: Component,
	el: HTMLElement,
	plugin: KifuPlugin,
	notePath: string,
	body: string,
	from: string,
	why: string,
	ctx: MarkdownPostProcessorContext | null = null,
): Session {
	const s = new Session(plugin, notePath, body);
	s.link = from;
	s.fixed = why;
	plugin.linkedShown(s, true);
	owner.register(() => plugin.linkedShown(s, false));
	// (a board in the editor or a base has no section of the note to tell about)
	const stub: MarkdownPostProcessorContext = { docId: '', sourcePath: notePath, frontmatter: null, getSectionInfo: () => null, addChild: (c: MarkdownRenderChild) => owner.addChild(c) };
	const view = new BoardView(el, plugin, ctx ?? stub, body);
	owner.addChild(view);
	view.attach(s);
	return s;
}

/** `![alt](link)` and `![alt](<link>)`, with an optional title. */
const EMBED = /!\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * The first link in a note's text that is drawn as a board, and the line it is on; not
 * one inside code (a fenced block, or between backticks on its line).
 */
export function firstEmbed(text: string): { line: number; target: LinkTarget } | null {
	const lines = text.split('\n');
	let fence: string | null = null;
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n];
		const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f.index + f[0].length).trim()) fence = null;
			continue;
		}
		if (f) {
			fence = f[1];
			continue;
		}
		EMBED.lastIndex = 0;
		for (let m: RegExpExecArray | null; (m = EMBED.exec(line)); ) {
			if (((line.slice(0, m.index).match(/`/g) ?? []).length & 1) === 1) continue;
			const target = linkTarget(m[1]);
			if (target) return { line: n, target };
		}
	}
	return null;
}

/** A board in place of a link: fetched, then drawn; or a line saying why it could not be. */
export class LinkedBoard extends MarkdownRenderChild {
	#plugin: KifuPlugin;
	#target: LinkTarget;
	#notePath: string;
	#ctx: MarkdownPostProcessorContext | null;
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
			mountDetached(this, this.containerEl, this.#plugin, this.#notePath, body, t.url, `this board is drawn from ${t.url}. To edit it, import it instead (right-click, then Kifu).`, this.#ctx);
		} catch (e) {
			if (this.#gone) return;
			msg.setText(`Kifu: ${e instanceof ImportError ? e.message : `could not draw ${t.url}.`}`);
			msg.addClass('is-error');
			if (!(e instanceof ImportError)) console.error('Kifu: board from a link', e);
		}
	}

	onunload(): void {
		this.#gone = true;
	}
}
