import {
	Editor,
	FuzzySuggestModal,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	MenuItem,
	Modal,
	Notice,
	Platform,
	Plugin,
	Setting,
	TAbstractFile,
	TFile,
	addIcon,
	requestUrl,
} from 'obsidian';
import { BLOCK_LANG, DEFAULT_SETTINGS, HANDBACK, KifuSettings, VIEW_TYPE } from './config';
import { Note, Place, alike, follow, normalize, reading, sameText, squash } from './blocks';
import { Host, Session } from './session';
import { problemApi, problemId, problemUrl, readProblem } from './goproblems';
import { ImportError } from './importing';
import { OgsKind, OgsTarget, ogsApi, ogsPage, ogsTarget, readOgsGame, readOgsPuzzle } from './ogs';
import { composeBlock, parseBlock, setOption } from './options';
import { KifuSettingTab, sanitize } from './settings';
import { Outcome, RETRY_WAITS, SaveHooks, Seen, blockUnder, editorTexts, editorsHold, evidence, loadGame, read, refreshGame, saveSession } from './store';
import { BoardView } from './ui/boardview';
import { TREE_ICON } from './ui/dom';
import { TreePanel } from './ui/panel';

/**
 * How long an unlocked board waits after the last edit before writing it. Writing
 * redraws the block, which swaps the board for a new one under the pointer: a click
 * that is pressed on the old board and let go on the new one is lost. So nothing is
 * written while someone is still at work, only after a pause, or when the board is
 * locked or goes away (scrolled off, note closed) and when the plugin stops.
 */
const SAVE_DELAY = 3000;
/** While a press on the board is held, a write that is due waits this long and looks again. */
const PRESS_WAIT = 250;
/** The board sizes the editor menu offers to insert. */
const MENU_SIZES = [19, 13, 9];
/** How many boards that are off the page but were left unlocked or played out are remembered. */
const KEEP = 24;
/** How many frames a board is given to arrive on the page before it is asked where it stands. */
const FRAMES = 40;
/** While a note is being typed in, how often what is known about its boards is brought up to date. */
const CARRY_DELAY = 200;

export default class KifuPlugin extends Plugin implements Host {
	settings: KifuSettings = { ...DEFAULT_SETTINGS };
	/** The board the move tree panel follows. */
	activeSession: Session | null = null;
	#sessions: Session[] = [];
	/** The panel's board while it is off screen; it gets the panel back if it returns. */
	#dormant: Session | null = null;
	#settingsLoad: Promise<void> | null = null;
	#settingsReady = false;
	#timers = new Map<Session, { id: number }>();
	#loads = new Map<Session, Promise<void>>();
	#watching = false;
	#retry = 0;
	/** Notes that were typed in a moment ago, each with the timer that will bring its boards up to date. */
	#carrying = new Map<string, number>();
	/** Notes that were written to a while ago, each with the timer for one more look at their boards. */
	#late = new Map<string, number>();
	/** Counts the times a note's file was read to that end (per note), so that an answer that comes late is not used. */
	#reads = new Map<string, number>();
	#unloaded = false;
	/** Boards that were given an existing session by their text, and have not yet shown that they stand on its block. */
	#unsure = new WeakSet<BoardView>();
	#hooks: SaveHooks = {
		elementOf: (v) => (v instanceof BoardView ? v.containerEl : null),
		settled: (v) => v instanceof BoardView && !this.#unsure.has(v),
		wrote: (s, before, after, ord, was) => this.#wrote(s, before, after, ord, was),
		astray: (v) => {
			if (v instanceof BoardView && !this.#unloaded) this.#rehome(v);
		},
		dropped: (s, lost) => {
			if (this.#unloaded) return;
			for (const v of Array.from(s.views)) {
				if (v instanceof BoardView) this.#ownSession(v, s.notePath).lost = lost;
			}
		},
	};

	/**
	 * Nothing here reads a file, parses anything or touches the workspace: it only
	 * tells Obsidian what exists. The work happens the first time a board is shown.
	 */
	onload(): void {
		addIcon('kifu-tree', TREE_ICON);
		this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => this.#renderBlock(source, el, ctx));
		this.registerView(VIEW_TYPE, (leaf) => new TreePanel(leaf, this));
		this.addSettingTab(new KifuSettingTab(this.app, this));
		this.addCommand({
			id: 'insert-board',
			name: 'Insert board',
			editorCallback: (editor) => insertBlock(editor, ''),
		});
		this.addCommand({
			id: 'insert-sgf',
			name: 'Insert board from an SGF file',
			editorCallback: (editor, ctx) => this.#insertSgf(editor, ctx.file?.path ?? ''),
		});
		this.addCommand({
			id: 'import-goproblems',
			name: 'Import a problem from goproblems.com',
			editorCallback: (editor) => this.#promptImport(editor),
		});
		this.addCommand({
			id: 'import-ogs',
			name: 'Import a game or puzzle from online-go.com',
			editorCallback: (editor) => this.#promptOgs(editor),
		});
		this.addCommand({
			id: 'show-tree',
			name: 'Show move tree',
			callback: () => void this.showPanel(true),
		});
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => this.#editorMenu(menu, editor, info.file?.path ?? '')));
	}

	/** Ask which problem to import from goproblems.com, then import it. */
	#promptImport(editor: Editor): void {
		new ImportPrompt(
			this,
			{
				title: 'Import a problem from goproblems.com',
				desc: 'Its number, or a link to it.',
				wrong: 'That is not a problem number, or a link to a problem.',
				parse: (text) => problemId(text),
			},
			(id) => void this.#importProblem(editor, id),
		).open();
	}

	/** Ask which game, review or puzzle to import from OGS, then import it. */
	#promptOgs(editor: Editor): void {
		new ImportPrompt(
			this,
			{
				title: 'Import from online-go.com',
				desc: 'Its number, or a link to it.',
				wrong: 'That is not a number, or a link to a game, review or puzzle on online-go.com.',
				kinds: { game: 'Game', review: 'Review or demo board', puzzle: 'Puzzle' },
				kindOf: (text) => (/^#?\d+$/.test(text.trim()) ? null : (ogsTarget(text, 'game')?.kind ?? null)),
				parse: (text, kind) => ogsTarget(text, kind as OgsKind),
			},
			(t) => void this.#importOgs(editor, t),
		).open();
	}

	/** Fetch a game, review or puzzle from OGS and put it where the cursor is, with a link back to it. */
	async #importOgs(editor: Editor, t: OgsTarget): Promise<void> {
		const name = `${t.kind === 'game' ? 'game' : t.kind === 'review' ? 'review' : 'puzzle'} ${t.id}`;
		try {
			let res;
			try {
				res = await requestUrl({ url: ogsApi(t), headers: { accept: t.kind === 'puzzle' ? 'application/json' : 'application/x-go-sgf' }, throw: false });
			} catch {
				throw new ImportError('could not reach OGS (online-go.com). Are you online?');
			}
			const answer = res;
			const { sgf, about } = t.kind === 'puzzle' ? readOgsPuzzle(t, answer.status, () => answer.json) : readOgsGame(t, answer.status, answer.status === 200 ? answer.text : '');
			insertBlock(editor, (t.kind === 'puzzle' ? 'problem: yes\n' : '') + sgf, `[OGS ${name}](${ogsPage(t)})` + (about ? ` · ${about}` : ''));
		} catch (e) {
			new Notice(`Kifu: ${e instanceof ImportError ? e.message : `importing OGS ${name} failed.`}`);
			if (!(e instanceof ImportError)) console.error('Kifu: import from OGS', e);
		}
	}

	/** Fetch a problem from goproblems.com and put it where the cursor is, with a link back to it. */
	async #importProblem(editor: Editor, id: number): Promise<void> {
		await this.settingsLoaded();
		const name = this.settings.goproblemsKey;
		const key = name ? this.app.secretStorage.getSecret(name) : null;
		try {
			let res;
			try {
				const headers: Record<string, string> = { accept: 'application/json' };
				if (key) headers['X-Api-Key'] = key;
				res = await requestUrl({ url: problemApi(id), headers, throw: false });
			} catch {
				throw new ImportError('could not reach goproblems.com. Are you online?');
			}
			const answer = res;
			const { sgf, about } = readProblem(id, answer.status, () => answer.json, !!key);
			insertBlock(editor, 'problem: yes\n' + sgf, `[goproblems.com #${id}](${problemUrl(id)})` + (about ? ` · ${about}` : ''));
		} catch (e) {
			new Notice(`Kifu: ${e instanceof ImportError ? e.message : `importing problem ${id} failed.`}`);
			if (!(e instanceof ImportError)) console.error('Kifu: import from goproblems.com', e);
		}
	}

	/**
	 * A new board of size `n`. The default size needs no line: that board keeps following
	 * the setting. (The settings are read first: they may not have been yet.)
	 */
	async #insertSized(editor: Editor, n: number): Promise<void> {
		await this.settingsLoaded();
		insertBlock(editor, n === this.settings.boardSize ? '' : `size: ${n}`);
	}

	#insertSgf(editor: Editor, from: string): void {
		new SgfPicker(this, (file) => {
			insertBlock(editor, `sgf: [[${this.app.metadataCache.fileToLinktext(file, from, false)}]]`);
		}).open();
	}

	/** The board that was right-clicked last, and when: the editor menu that follows is about it. */
	#menuBoard: { session: Session; at: number } | null = null;

	menuOn(session: Session): void {
		this.#menuBoard = { session, at: Date.now() };
	}

	/**
	 * The editor's right-click menu gets a Kifu submenu: the insert commands and, for
	 * the board that was right-clicked (or the block the cursor is in), whether it is
	 * a problem.
	 */
	#editorMenu(menu: Menu, editor: Editor, from: string): void {
		type Entry = { title: string; flat: string; run: () => void; checked?: boolean; disabled?: boolean };
		const entries: Entry[] = [
			...MENU_SIZES.map((n) => ({
				title: `Insert ${n} × ${n} board`,
				flat: `Insert ${n} × ${n} Kifu board`,
				run: () => void this.#insertSized(editor, n),
			})),
			{ title: 'Display SGF file…', flat: 'Display SGF file with Kifu…', run: () => this.#insertSgf(editor, from) },
			// (OGS first: it is the more widely used)
			{ title: 'Import from online-go.com…', flat: 'Import a game or puzzle from online-go.com…', run: () => this.#promptOgs(editor) },
			{ title: 'Import from goproblems.com…', flat: 'Import a problem from goproblems.com…', run: () => this.#promptImport(editor) },
		];
		const problem = this.#problemEntry(editor, from);
		if (problem) entries.push({ title: 'Problem board', flat: 'Kifu problem board', ...problem });
		const fill = (i: MenuItem, e: Entry, title: string): void => {
			i.setTitle(title).onClick(e.run);
			if (e.checked !== undefined) i.setChecked(e.checked);
			if (e.disabled) i.setDisabled(true);
		};
		menu.addItem((item) => {
			// Submenus work in Obsidian but are not in its published API, so check first
			// and fall back to plain items, named so they still read as Kifu's.
			const sub = (item as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.();
			if (sub) {
				item.setTitle('Kifu').setIcon('kifu-tree').setSection('insert');
				for (const e of entries) sub.addItem((i) => fill(i, e, e.title));
				return;
			}
			const [first, ...others] = entries;
			fill(item.setIcon('kifu-tree').setSection('insert'), first, first.flat);
			for (const e of others) menu.addItem((i) => fill(i.setIcon('kifu-tree').setSection('insert'), e, e.flat));
		});
	}

	/** The "Problem board" switch for the menu, or null when the menu is about no board. */
	#problemEntry(editor: Editor, from: string): { run: () => void; checked: boolean; disabled: boolean } | null {
		// A board that was just right-clicked: through its session, like its own button.
		const pressed = this.#menuBoard;
		this.#menuBoard = null;
		if (pressed && Date.now() - pressed.at < 1000 && pressed.session.notePath === from && !pressed.session.gone && pressed.session.ready) {
			const s = pressed.session;
			return {
				checked: s.problem,
				disabled: !!s.cantEdit,
				run: () => {
					s.setProblem(!s.problem);
					// what the solver sees changes: start again from the resting position
					if (!s.edit) s.reset();
				},
			};
		}
		// Otherwise the block the cursor is in: its text is changed in the editor itself,
		// exactly there, and the board is drawn again from it.
		const line = editor.getCursor().line;
		const block = read(editor.getValue()).blocks.find((b) => b.open <= line && b.close >= line);
		if (!block) return null;
		const probe = new Session(this, from, block.body);
		if (probe.error) return null;
		const on = probe.problem;
		return {
			checked: on,
			disabled: false,
			run: () => {
				const now = read(editor.getValue()).blocks.find((b) => b.open === block.open && b.close === block.close && b.body === block.body);
				if (!now) return; // (the note changed meanwhile)
				const parsed = parseBlock(now.body);
				const body = composeBlock(setOption(parsed.header, 'problem', probe.problemValue(!on)), parsed.rest, null, null);
				const text = body === '' ? '' : body.split('\n').map((l) => now.prefix + l).join('\n') + '\n';
				editor.replaceRange(text, { line: now.open + 1, ch: 0 }, { line: now.close, ch: 0 });
			},
		};
	}

	/** First time the plugin is switched on: put the panel in the right sidebar, quietly. */
	onUserEnable(): void {
		void this.showPanel(false, false);
	}

	/** Switched off: write what is still pending and leave the boards on the page as pictures. */
	onunload(): void {
		this.#unloaded = true;
		window.clearTimeout(this.#retry);
		for (const t of this.#timers.values()) window.clearTimeout(t.id);
		this.#timers.clear();
		for (const id of [...this.#carrying.values(), ...this.#late.values()]) window.clearTimeout(id);
		this.#carrying.clear();
		this.#late.clear();
		// (every edit that is not in its note yet: also one whose last write failed and has no timer running)
		for (const s of this.#sessions) {
			if ((s.dirtyTree || s.dirtyHeader) && !s.gone) void this.#lastSave(s);
		}
		for (const s of this.#sessions) {
			for (const v of Array.from(s.views)) if (v instanceof BoardView) v.freeze();
		}
		this.#sessions = [];
		this.activeSession = null;
		this.#dormant = null;
	}

	async onExternalSettingsChange(): Promise<void> {
		Object.assign(this.settings, sanitize(await this.loadData()));
		this.#refreshAll();
	}

	/* --------------------------------------------------------------- settings */

	/** Have the settings been read yet? */
	get settingsReady(): boolean {
		return this.#settingsReady;
	}

	/** Settings are read on first use rather than at startup. */
	settingsLoaded(): Promise<void> {
		return (this.#settingsLoad ??= (async () => {
			try {
				Object.assign(this.settings, sanitize(await this.loadData()));
			} catch (e) {
				console.error('Kifu: could not read settings', e);
			}
			this.#settingsReady = true;
		})());
	}

	async saveSettings(): Promise<void> {
		this.#refreshAll();
		// Only what differs from the defaults is written, so a default that changes in a
		// later version reaches everyone who never chose otherwise.
		const changed: Partial<KifuSettings> = {};
		for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof KifuSettings)[]) {
			if (this.settings[k] !== DEFAULT_SETTINGS[k]) Object.assign(changed, { [k]: this.settings[k] });
		}
		await this.saveData(changed);
	}

	#refreshAll(): void {
		for (const s of this.#sessions) if (s.ready) s.refresh();
	}

	/* ----------------------------------------------------------------- boards */

	async #renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		if (!this.#settingsReady) await this.settingsLoaded();
		if (this.#unloaded) return;
		this.#watch();
		const text = normalize(source);
		const view = new BoardView(el, this, ctx, text);
		ctx.addChild(view);
		const known = this.#sessionFor(ctx.sourcePath, text);
		const s = known ?? this.#newSession(ctx.sourcePath, text);
		view.attach(s);
		if (known) {
			// The text fits; whether this is that session's block is another matter (a block
			// further down may read the same). The board has to show where it stands.
			this.#unsure.add(view);
			this.#confirmSoon(view, FRAMES);
		}
		// (once this round of drawing is over, see whether the session's other boards still belong)
		if (s.views.size > 1) queueMicrotask(() => this.#settle(s));
		if (!s.ready && !s.error) await this.#loadFile(s);
	}

	#newSession(path: string, text: string): Session {
		const s = new Session(this, path, text);
		if (/\.canvas$/i.test(path)) s.fixed = 'a board on a canvas card can be played, but not edited.';
		s.stamp = Date.now();
		this.#sessions.push(s);
		return s;
	}

	/** Has this session written `loose` (a block's text, white space removed) lately, and may a drawing of it be its block? */
	#wroteLately(s: Session, loose: string, now: number): number {
		const at = s.wroteAt(loose, now - HANDBACK);
		// A text we wrote but have replaced since: a pane that lags behind the editor may
		// still draw that, and it is our block all the same. But the note may also have
		// gone back to it (an undo in the editor), and then it no longer is.
		if (at && squash(s.body) !== loose && !this.#noteHolds(s)) return 0;
		return at;
	}

	/**
	 * Is this a session whose board left the page and that would read like `text`? One
	 * with an edit still to write does not count (it writes it the moment its board
	 * goes, and then knows its block by another text) unless the write is failing and
	 * being tried again: the board that comes back should show what is waiting.
	 */
	#waits(s: Session, text: string): boolean {
		const unwritten = s.dirtyTree || s.dirtyHeader;
		return s.views.size === 0 && (!unwritten || s.failures > 0) && s.place !== null && normalize(s.body) === text;
	}

	/**
	 * A session that a block being drawn may belong to, going by its text. There are two
	 * kinds, and they are what lets a board keep its state when it is drawn again: the
	 * session that has just written this text, and one that was left behind by a board
	 * of this text when it left the page. The text alone settles nothing, though; see
	 * #confirm.
	 */
	#sessionFor(path: string, text: string): Session | null {
		const now = Date.now();
		const loose = squash(text);
		let hit: Session | null = null;
		let newest = 0;
		for (const s of this.#sessions) {
			if (s.notePath !== path || s.gone || !s.place) continue;
			const at = this.#wroteLately(s, loose, now);
			if (at > newest) {
				newest = at;
				hit = s;
			}
		}
		if (!hit) {
			const left = this.#sessions.filter((s) => s.notePath === path && !s.gone && this.#waits(s, text));
			if (left.length) hit = left.reduce((a, b) => (b.stamp > a.stamp ? b : a));
		}
		if (hit) hit.stamp = now;
		return hit;
	}

	/** Where a session's block stands in `note`, going by where it stood when the session last knew. */
	#expected(s: Session, note: Note): Place | null {
		return s.place && s.known !== null ? follow(read(s.known), s.place, note) : null;
	}

	/**
	 * Is this board a drawing of this session's block? It is when it stands where the
	 * session's block has got to and, if it shows the text as the session has it, when
	 * the note holds that text letter for letter as the session last saw it (otherwise
	 * it was changed by hand since, and the session's picture of it is out of date).
	 * Null: the board can not say where it stands.
	 */
	#fits(view: BoardView, s: Session, seen: Seen | null): boolean | null {
		if (!seen || seen.ord === null) return null;
		if (seen.ord < 0 || !s.place) return false;
		if (!alike(view.source, s.body)) {
			// A drawing of an older text of ours (from a pane that is behind): its block
			// can not be followed through our own rewriting of it. Its number has to do.
			return s.place.ord === seen.ord && s.place.total === seen.note.blocks.length;
		}
		if (this.#expected(s, seen.note)?.ord !== seen.ord) return false;
		if (s.raw !== null && normalize(seen.note.blocks[seen.ord].body) !== normalize(s.raw)) return false;
		// Blocks that read the same can change places without the text showing which went
		// where. So among look-alikes a board is only taken for the session's if the note
		// has not changed at all since the session's place was last seen for a fact.
		return reading(seen.note.blocks, s.body).length === 1 || this.#unchanged(s, seen.note);
	}

	/** Does the note read as it did when the session's place was last witnessed (rather than carried along)? */
	#unchanged(s: Session, note: Note): boolean {
		return s.witnessed !== null && sameText(s.witnessed, note.text);
	}

	/** Keep asking a board that was given a session by its text where it stands, until it is on the page and can say. */
	#confirmSoon(view: BoardView, frames: number): void {
		const step = (left: number): void => {
			if (this.#unloaded || !this.#unsure.has(view) || !view.session) return;
			// (a board that is on the page and still can not say after a few frames is not going to)
			const last = left <= 0 || (view.connected() && left < frames - 4);
			this.#confirm(view, last);
			if (this.#unsure.has(view)) (view.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => step(left - 1));
		};
		queueMicrotask(() => step(frames));
	}

	/**
	 * Settle whether a board that was given a session by its text keeps it. `last`: now or
	 * never (the board is about to be used, or has had its time to appear).
	 */
	#confirm(view: BoardView, last: boolean): void {
		const s = view.session;
		if (!s || !this.#unsure.has(view)) return;
		const seen = evidence(this.app, s.notePath, view, view.containerEl, view.source);
		let fits = this.#fits(view, s, seen);
		if (fits === null) {
			if (!last) return;
			// Nothing says where this board stands (in an embedded note, say). Then it is
			// the board of the session that wrote this text a moment ago, if no other
			// block read the same when it did. Anything less is a guess.
			fits = s.alone && normalize(s.body) === view.source && this.#wroteLately(s, squash(view.source), Date.now()) > 0;
		}
		this.#unsure.delete(view);
		if (!fits) {
			this.#rehome(view, seen);
			return;
		}
		if (s === this.#dormant) {
			this.#dormant = null;
			this.activeSession = s;
			this.#syncPanels();
		}
	}

	/**
	 * This board is not its session's. Give it the session whose block it does stand
	 * on, if one is waiting for its board, or else one of its own.
	 */
	#rehome(view: BoardView, seen: Seen | null = null): Session {
		const from = view.session;
		const path = from?.notePath ?? '';
		this.#unsure.delete(view);
		seen ??= evidence(this.app, path, view, view.containerEl, view.source);
		if (seen && seen.ord !== null && seen.ord >= 0) {
			const now = Date.now();
			const loose = squash(view.source);
			const pane = view.pane();
			const other = this.#sessions.find(
				(o) =>
					o !== from &&
					o.notePath === path &&
					!o.gone &&
					(this.#waits(o, view.source) || this.#wroteLately(o, loose, now) > 0) &&
					this.#fits(view, o, seen) === true &&
					// (two boards in one pane are two blocks, never one)
					!Array.from(o.views).some((v) => v instanceof BoardView && v.pane() === pane && v.connected()),
			);
			if (other) {
				view.attach(other);
				other.stamp = now;
				if (from && from.views.size === 0) this.sessionReleased(from);
				if (other === this.#dormant) {
					this.#dormant = null;
					this.activeSession = other;
					this.#syncPanels();
				}
				return other;
			}
		}
		return this.#ownSession(view, path);
	}

	/** Does an editor that has the note open hold this session's block, as the session knows it? */
	#noteHolds(s: Session): boolean {
		return editorsHold(this.app, s.notePath, s.body) === true;
	}

	/** Read the SGF file behind a board (once, however many boards are waiting for it). */
	#loadFile(s: Session): Promise<void> {
		let p = this.#loads.get(s);
		if (!p) {
			p = loadGame(this.app, s).then(() => {
				this.#loads.delete(s);
				s.emit();
			});
			this.#loads.set(s, p);
		}
		return p;
	}

	/**
	 * A board whose drawing is older than its session's text is normally about to be
	 * drawn again. But a renderer may just as well keep such a drawing and use it for
	 * another block that reads the same, and then it must not go on showing this
	 * session. The renderer's own copy of the note tells the two apart: once that holds
	 * the block as we wrote it, a drawing made from the older text is not of our block.
	 */
	#displaced(view: BoardView, s: Session): boolean {
		if (alike(view.source, s.body)) return false;
		const info = view.sectionInfo();
		if (info) {
			if (reading(read(info.text).blocks, s.body).length > 0) return true;
		} else {
			// (no word from the renderer; an editor may still know which block the board stands on)
			const under = blockUnder(this.app, s.notePath, view.containerEl);
			if (under !== null) {
				if (!alike(under, s.body)) return true;
			} else if (view.connected()) {
				// Nothing at all says where this drawing stands (an embedded note is the likely
				// case). Then there are two signs that its pane is not going to replace it: the
				// pane has drawn the text as it stands now, or it has had ample time to.
				if (this.#drawn(s.notePath, view.pane(), s.body, view) || Date.now() - s.lastWrite > HANDBACK) return true;
			}
		}
		// Otherwise the new drawing is still to come (a pane that follows the editor late).
		// Unless no editor holds what we wrote any more: an undo there took it back before
		// this pane ever saw it. Then no drawing is coming, and the board can only be
		// what it was drawn from.
		return editorsHold(this.app, s.notePath, s.body) === false;
	}

	/** Is there a board in this pane, other than `but`, that was drawn from this text of this note? */
	#drawn(path: string, pane: unknown, body: string, but: BoardView): boolean {
		for (const o of this.#sessions) {
			if (o.notePath !== path) continue;
			for (const v of o.views) {
				if (v !== but && v instanceof BoardView && v.connected() && v.pane() === pane && alike(v.source, body)) return true;
			}
		}
		return false;
	}

	/**
	 * Does this board stand on another block than its session's? That is so when the
	 * session's block can be followed through the note's changes to one place and the
	 * board stands on another: a renderer that keeps drawings by their text has put
	 * this one on a block that reads the same. (When the block can not be followed,
	 * because the note was rearranged around it, the board is the one that knows.)
	 */
	#misplaced(view: BoardView, s: Session, seen: Seen | null = null): boolean {
		if (!s.place || !alike(view.source, s.body)) return false;
		seen ??= evidence(this.app, s.notePath, view, view.containerEl, view.source);
		// (an editor moves a board with its block, whatever happens to the note: there the board is always right)
		if (!seen || seen.editor || seen.ord === null || seen.ord < 0) return false;
		const at = this.#expected(s, seen.note);
		return at !== null && at.ord !== seen.ord;
	}

	/** Give a board a session of its own, made from the text it was drawn from. */
	#ownSession(view: BoardView, path: string): Session {
		const from = view.session;
		this.#unsure.delete(view);
		const own = this.#newSession(path, view.source);
		view.attach(own);
		if (!own.ready && !own.error) void this.#loadFile(own);
		if (from && from.views.size === 0) this.sessionReleased(from);
		return own;
	}

	/** Several boards show one session: see that each of them really is a drawing of its block. */
	#settle(s: Session): void {
		if (this.#unloaded) return;
		const kept: BoardView[] = [];
		for (const v of Array.from(s.views)) {
			if (!(v instanceof BoardView) || this.#unsure.has(v)) continue;
			if (this.#displaced(v, s)) {
				this.#ownSession(v, s.notePath).lost = true;
			} else if (alike(v.source, s.body) && v.connected()) {
				// Two drawings of the block as it stands, in one pane: those are two blocks
				// that read the same. The newcomer goes its own way.
				if (kept.some((k) => k.pane() === v.pane())) this.#rehome(v);
				else kept.push(v);
			}
		}
	}

	/** See that no board of this note shows a session whose block it is not (or no longer) a drawing of. */
	#sweep(path: string): void {
		if (this.#unloaded) return;
		// (nothing in here changes a note: what an editor holds is fetched once for all its boards)
		const held = new Map<MarkdownView, Note>();
		for (const s of this.#sessions.slice()) {
			if (s.notePath !== path) continue;
			for (const v of Array.from(s.views)) {
				if (!(v instanceof BoardView) || v.session !== s || this.#unsure.has(v)) continue;
				if (this.#displaced(v, s)) {
					// (a drawing of what the block used to read: its text says nothing about which block that is)
					this.#ownSession(v, path).lost = true;
					continue;
				}
				if (!alike(v.source, s.body)) continue;
				const seen = evidence(this.app, path, v, v.containerEl, v.source, held);
				if (this.#misplaced(v, s, seen)) this.#rehome(v, seen);
				// (and while we are here: a board that is where it should be knows the latest about its block)
				else this.#learn(s, v, seen);
			}
		}
	}

	/** A board was clicked or focused: the panel follows it from now on. */
	useSession(view: BoardView): void {
		if (!view.session || this.#unloaded) return;
		// (it is about to be used: whose board it is has to be settled now)
		this.#confirm(view, true);
		let s = view.session as Session | null;
		if (!s) return;
		if (this.#displaced(view, s)) {
			s = this.#ownSession(view, s.notePath);
			s.lost = true;
		} else if (this.#misplaced(view, s)) {
			s = this.#rehome(view);
		}
		this.#checkEmbed(view, s);
		s.lastView = view;
		this.#learn(s, view);
		s.stamp = Date.now();
		if (this.activeSession !== s) {
			this.activeSession = s;
			this.#dormant = null;
			this.#syncPanels();
		}
	}

	/**
	 * A board that is shown through an embed (`![[Other note]]`) belongs to the embedded
	 * note. Obsidian is expected to say so itself; should it name the note that does the
	 * embedding instead, the block would be looked for in the wrong file. Then the board
	 * is not edited from here at all.
	 */
	#checkEmbed(view: BoardView, s: Session): void {
		if (s.fixed) return;
		const src = view.containerEl.closest('.internal-embed[src]')?.getAttribute('src');
		if (!src) return;
		const link = src.split('|')[0].split('#')[0].trim();
		// (an embed of a heading or block of the same note has no file name of its own)
		const file = link ? this.app.metadataCache.getFirstLinkpathDest(link, s.notePath) : null;
		if (file && file.path !== s.notePath) s.fixed = 'this board is shown through an embed of another note. Open that note itself to edit the board.';
	}

	/**
	 * Learn from a board on screen where its session's block stands, and what exactly
	 * the note holds there, while it can still tell. (Saving relies on both.)
	 */
	#learn(s: Session, view: BoardView, seen: Seen | null = null): void {
		// (an older drawing can not say anything about the text as it stands now;
		// what was learnt when that text was written still holds)
		if (!alike(view.source, s.body)) return;
		seen ??= evidence(this.app, s.notePath, view, view.containerEl, view.source);
		if (!seen || seen.ord === null || seen.ord < 0) return;
		let ahead: string | null = null;
		if (!seen.editor) {
			// (the board is on another block than ours has got to: not ours to learn from.
			// The caller sees to such a board.)
			const at = this.#expected(s, seen.note);
			if (at && at.ord !== seen.ord) return;
			// A renderer's copy of the note may be behind the note as an editor holds it.
			// Then what is known already is the fresher of the two: that has been carried
			// along with the note itself.
			const held = editorTexts(this.app, s.notePath);
			const copy = seen.note;
			if (held.length && !held.some((t) => sameText(t, copy.text))) {
				if (s.place) return;
				ahead = held[0];
			}
		}
		const dirty = s.dirtyTree || s.dirtyHeader || s.saving;
		s.place = { ord: seen.ord, total: seen.note.blocks.length };
		s.known = seen.note.text;
		s.witnessed = seen.note.text;
		s.lost = false;
		// An edit that is waiting was made on the block as it read then: that is what it
		// has to be checked against, whatever the note holds by now.
		if (!dirty || s.raw === null) s.raw = seen.note.blocks[seen.ord].body;
		// (learnt from a copy that is behind: brought up to the note as it stands, if the two are close enough for that)
		if (ahead !== null) this.#carry(s.notePath, ahead);
	}

	/**
	 * The note is seen to read `text` now. Whatever a session knows about where its
	 * block stands is carried over to that, so that it is never more than one change
	 * behind. (A session whose block the change itself touched keeps what it knew, for
	 * what that is worth: the text may come back, with an undo.)
	 */
	#carry(path: string, text: string): void {
		let now: Note | null = null;
		for (const s of this.#sessions) {
			if (s.notePath !== path || !s.place || s.known === null || s.known === text) continue;
			now ??= read(text);
			const next = follow(read(s.known), s.place, now);
			if (next) {
				s.place = next;
				s.known = text;
			}
		}
	}

	/** A note was changed in an editor. */
	#edited(editor: Editor, path: string | undefined): void {
		if (!path || this.#unloaded) return;
		let any = false;
		let waiting = false;
		for (const s of this.#sessions) {
			if (s.notePath !== path || !s.place) continue;
			any = true;
			waiting ||= s.dirtyTree || s.dirtyHeader || s.saving;
		}
		if (!any) return;
		if (waiting) {
			// (an edit is on its way into this note: it must not lose sight of its block for a moment)
			this.#carry(path, editor.getValue());
			return;
		}
		// Otherwise not at every key: a moment later will do.
		if (this.#carrying.has(path)) return;
		this.#carrying.set(
			path,
			window.setTimeout(() => {
				this.#carrying.delete(path);
				const held = editorTexts(this.app, path);
				if (held.length) this.#carry(path, held[0]);
			}, CARRY_DELAY),
		);
	}

	/** A board left the screen. */
	sessionReleased(s: Session): void {
		if (s.dirtyTree || s.dirtyHeader) this.requestSave(s, true);
		if (s === this.activeSession && s.views.size === 0) {
			// The panel's board is gone. A re-render brings it straight back; if it does not
			// return in a moment the panel lets go of it (and takes it up again if it ever does).
			const letGo = (): void => {
				if (this.#unloaded || this.activeSession !== s || s.views.size > 0) return;
				// Not while the panel itself is being used, though: someone is writing a
				// comment for a board that has scrolled out of sight.
				if (this.#panelInUse()) {
					window.setTimeout(letGo, 500);
					return;
				}
				this.activeSession = null;
				this.#dormant = s;
				this.#syncPanels();
				this.#prune();
			};
			window.setTimeout(letGo, 500);
		}
		this.#prune();
	}

	/** Does the move tree panel have the keyboard? */
	#panelInUse(): boolean {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).some((leaf) => {
			const el = leaf.view.containerEl;
			const active = el.ownerDocument.activeElement;
			return active !== null && el.contains(active);
		});
	}

	/** Save for the last time (the plugin is being switched off, or Obsidian is closing): there will be no other try. */
	async #lastSave(s: Session): Promise<void> {
		const outcome = await saveSession(this.app, s, this.#hooks);
		if (outcome === 'failed') new Notice('Kifu: an edit could not be written before closing, and is lost.', 10000);
	}

	/** A save has been tried. */
	#saved(s: Session, outcome: Outcome): void {
		if (this.#unloaded) return;
		if (s.gone) {
			// it left the session with nothing to show for itself: the session goes
			if (this.activeSession === s) {
				this.activeSession = null;
				this.#syncPanels();
			}
			this.#prune();
		} else if (outcome === 'failed' && (s.dirtyTree || s.dirtyHeader) && !this.#timers.has(s)) {
			// the disk said no: that may pass
			const wait = RETRY_WAITS[Math.min(s.failures, RETRY_WAITS.length) - 1] ?? RETRY_WAITS[0];
			this.requestSave(s, false, wait);
		}
	}

	/** Forget sessions nobody is looking at, unless there is something to come back to. */
	#prune(): void {
		const now = Date.now();
		const idle = (s: Session) => s.views.size === 0 && s !== this.activeSession;
		const unfinished = (s: Session) => s.dirtyTree || s.dirtyHeader || s.saving;
		const worthKeeping = (s: Session) =>
			!s.gone && (s.edit || s.moved || unfinished(s) || now - s.lastWrite < HANDBACK);
		this.#sessions = this.#sessions.filter((s) => !idle(s) || worthKeeping(s));
		const kept = this.#sessions.filter(idle).sort((a, b) => b.stamp - a.stamp);
		for (const s of kept.slice(KEEP)) {
			if (!unfinished(s)) this.#sessions.splice(this.#sessions.indexOf(s), 1);
		}
		if (this.#dormant && !this.#sessions.includes(this.#dormant)) this.#dormant = null;
	}

	toggleLock(s: Session): void {
		if (!s.edit && s.cantEdit) {
			new Notice(`Kifu: ${s.cantEdit}`);
			return;
		}
		s.setEdit(!s.edit);
		// (on a phone the sidebar is a drawer that would cover the board)
		if (s.edit && this.settings.revealPanel && !Platform.isMobile) void this.showPanel(false);
	}

	/**
	 * One of our sessions has rewritten its block: number `ord` of the note, which read
	 * `before` and reads `after` now; the block itself read `was`. Other sessions may
	 * have been showing that very block (in another pane), every other session's block
	 * may have moved by some lines, and a renderer may answer the change by moving
	 * drawings about.
	 */
	#wrote(s: Session, before: Note, after: Note, ord: number, was: string): void {
		if (this.#unloaded) return;
		const path = s.notePath;
		for (const o of this.#sessions.slice()) {
			if (o === s || o.notePath !== path) continue;
			if (!o.place || o.known === null) {
				// It never learnt where its block is. If it reads what this block read, there is
				// no telling whether it was a drawing of this very block: its text must not lead
				// it to another block that reads the same.
				if (alike(o.body, was)) o.lost = true;
				continue;
			}
			// where its block stood a moment ago
			const at = follow(read(o.known), o.place, before);
			if (!at) continue;
			if (at.ord === ord) {
				// Theirs is the block that was rewritten. Their boards show what it used to
				// read, and vouch for nothing any more: the renderer is about to replace them,
				// or has moved them to a block that reads the same. Each starts afresh from
				// the text it was drawn from, and has to see for itself where it stands.
				for (const v of Array.from(o.views)) {
					if (v instanceof BoardView && !alike(v.source, s.body)) this.#ownSession(v, path).lost = true;
				}
				continue;
			}
			// Theirs was not touched: what they know moves on with the note. (And a write
			// of ours changes one block and nothing else: a place that was certain before
			// it is as certain after.)
			const next = follow(before, at, after);
			if (next) {
				if (o.witnessed !== null && sameText(o.witnessed, before.text)) o.witnessed = after.text;
				o.place = next;
				o.known = after.text;
			}
		}
		// The renderer may have re-used drawings for the blocks after this one...
		this.#sweep(path);
		// ...or may be about to (one that draws a moment later)...
		queueMicrotask(() => this.#sweep(path));
		// ...and a drawing that is still showing the old text when every pane has had ample
		// time to replace it is not going to be replaced (see #displaced).
		window.clearTimeout(this.#late.get(path));
		this.#late.set(
			path,
			window.setTimeout(() => {
				this.#late.delete(path);
				this.#sweep(path);
			}, HANDBACK + 250),
		);
	}

	later(fn: () => void, ms: number): () => void {
		const id = window.setTimeout(fn, ms);
		return () => window.clearTimeout(id);
	}

	/* ----------------------------------------------------------------- saving */

	/**
	 * Schedule a save. It never happens within the call itself: we may be in the
	 * middle of an editor update (a board being taken off the page), and the editor
	 * may not be changed from in there.
	 */
	/** See SAVE_DELAY. (The checks set it shorter, to get through their scenarios.) */
	saveDelay = SAVE_DELAY;

	requestSave(s: Session, now = false, delay = this.saveDelay): void {
		if (s.gone) return;
		const pending = this.#timers.get(s);
		if (pending) window.clearTimeout(pending.id);
		const fire = (): void => {
			// (not while a press on one of its boards is held: let it end first)
			if (!now && Array.from(s.views).some((v) => v instanceof BoardView && v.pressed)) {
				this.#timers.set(s, { id: window.setTimeout(fire, PRESS_WAIT) });
				return;
			}
			this.#timers.delete(s);
			void saveSession(this.app, s, this.#hooks).then((outcome) => this.#saved(s, outcome));
		};
		this.#timers.set(s, { id: window.setTimeout(fire, now ? 0 : delay) });
	}

	/** Someone is at work on this board: a write that is waiting waits a full pause again. */
	stillBusy(s: Session): void {
		if (this.#timers.has(s) && (s.dirtyTree || s.dirtyHeader)) this.requestSave(s);
	}

	/**
	 * Keep up with what happens around the boards: notes being written, files being
	 * renamed, SGF files changing underneath open boards, Obsidian closing.
	 */
	#watch(): void {
		if (this.#watching) return;
		this.#watching = true;
		// (Obsidian waits for these before it quits: an edit made a moment ago still gets written)
		this.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				for (const s of this.#sessions) {
					if ((s.dirtyTree || s.dirtyHeader) && !s.gone) tasks.add(() => this.#lastSave(s));
				}
			}),
		);
		this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => this.#edited(editor, info.file?.path)));
		const vault = this.app.vault;
		this.registerEvent(vault.on('modify', (file) => void this.#onModify(file)));
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				for (const s of this.#sessions) {
					if (s.notePath === oldPath) s.notePath = file.path;
					if (s.filePath === oldPath) s.filePath = file.path;
				}
				this.#retryMissing();
			}),
		);
		this.registerEvent(vault.on('create', () => this.#retryMissing()));
	}

	/** A file appeared or moved: boards that could not find their SGF file look again. */
	#retryMissing(): void {
		if (!this.#sessions.some((s) => s.fileRef && !s.ready && s.error)) return;
		window.clearTimeout(this.#retry);
		this.#retry = window.setTimeout(() => {
			for (const s of this.#sessions) {
				if (!s.fileRef || s.ready || !s.error) continue;
				s.error = '';
				void this.#loadFile(s);
			}
		}, 300);
	}

	async #onModify(file: TAbstractFile): Promise<void> {
		// A note was written. What is known about its blocks goes along with it...
		this.#catchUp(file);
		// ...and none of its boards must be left waiting for a drawing that will not come,
		// or on another block than its own (now, and once every pane has had its turn to
		// follow).
		this.#sweep(file.path);
		window.setTimeout(() => this.#sweep(file.path), 0);
		for (const s of this.#sessions.slice()) {
			if (s.filePath !== file.path) continue;
			if (!s.ready) {
				// (a board that could not show the file as it was: the file is different now)
				if (s.error) {
					s.error = '';
					void this.#loadFile(s);
				}
				continue;
			}
			try {
				await refreshGame(this.app, s);
			} catch (e) {
				s.error = (e as Error).message;
				s.emit();
			}
		}
	}

	/** A note's file was written: carry what is known about its blocks over to what it holds now. */
	#catchUp(file: TAbstractFile): void {
		const path = file.path;
		if (!(file instanceof TFile) || !this.#sessions.some((s) => s.notePath === path && s.place)) return;
		// (an editor that has the note open holds the latest there is)
		const held = editorTexts(this.app, path);
		if (held.length) {
			this.#carry(path, held[0]);
			return;
		}
		const turn = (this.#reads.get(path) ?? 0) + 1;
		this.#reads.set(path, turn);
		void this.app.vault.cachedRead(file).then(
			(text) => {
				if (!this.#unloaded && this.#reads.get(path) === turn && !editorTexts(this.app, path).length) this.#carry(path, text);
			},
			() => undefined,
		);
	}

	/* ------------------------------------------------------------------ panel */

	#syncPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof TreePanel) leaf.view.setSession(this.activeSession);
		}
	}

	/** Make sure the panel exists in the right sidebar; optionally bring it forward. */
	async showPanel(focus: boolean, reveal = true): Promise<void> {
		try {
			const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: focus, reveal });
			if (leaf.view instanceof TreePanel) leaf.view.setSession(this.activeSession);
		} catch (e) {
			console.error('Kifu: could not open the move tree panel', e);
		}
	}
}

/** Put a board block at the cursor, on lines of its own, and leave the cursor below it. */
/** Put a new board block where the cursor is (with `before`, a line of text above it). */
function insertBlock(editor: Editor, body: string, before = ''): void {
	const cur = editor.getCursor();
	const line = editor.getLine(cur.line);
	const block = (before ? before + '\n\n' : '') + '```' + BLOCK_LANG + '\n' + (body ? body + '\n' : '') + '```';
	const rows = block.split('\n').length;
	let below: number;
	if (line.trim() === '') {
		editor.replaceRange(block + '\n', { line: cur.line, ch: 0 }, { line: cur.line, ch: line.length });
		below = cur.line + rows;
	} else {
		editor.replaceRange('\n' + block, { line: cur.line, ch: line.length });
		below = cur.line + rows + 1;
		// at the very end of the note there is no line below yet
		if (below >= editor.lineCount()) editor.replaceRange('\n', { line: below - 1, ch: 3 });
	}
	// (with the cursor outside the block, Live Preview shows the board straight away)
	editor.setCursor({ line: below, ch: 0 });
}

interface PromptOptions<T> {
	title: string;
	/** What the text field asks for. */
	desc: string;
	/** What is said when the text is no good. */
	wrong: string;
	/** Kinds of thing a bare number can mean (a link says for itself); none: no choice. */
	kinds?: Record<string, string>;
	/** The kind a link says it is, if it says. */
	kindOf?: (text: string) => string | null;
	/** What to import, or null when the text is no good. */
	parse: (text: string, kind: string) => T | null;
}

/** Asks what to import: its number, or a link to it (and, where it matters, what kind of thing a number is). */
class ImportPrompt<T> extends Modal {
	#opts: PromptOptions<T>;
	#done: (what: T) => void;

	constructor(plugin: KifuPlugin, opts: PromptOptions<T>, done: (what: T) => void) {
		super(plugin.app);
		this.#opts = opts;
		this.#done = done;
	}

	onOpen(): void {
		const o = this.#opts;
		this.setTitle(o.title);
		let value = '';
		let kind = o.kinds ? Object.keys(o.kinds)[0] : '';
		let hint: HTMLElement | null = null;
		let pickKind: ((k: string) => void) | null = null;
		const go = (): void => {
			const what = o.parse(value, kind);
			if (what === null) {
				hint?.setText(o.wrong);
				return;
			}
			this.close();
			this.#done(what);
		};
		new Setting(this.contentEl)
			.setName('What')
			.setDesc(o.desc)
			.addText((t) => {
				t.setPlaceholder('Number or link').onChange((v) => {
					value = v;
					hint?.setText('');
					// a link says what it is
					const k = o.kindOf?.(v);
					if (k) pickKind?.(k);
				});
				t.inputEl.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter') {
						ev.preventDefault();
						go();
					}
				});
				window.setTimeout(() => t.inputEl.focus(), 0);
			})
			.addButton((b) => b.setButtonText('Import').setCta().onClick(go));
		const kinds = o.kinds;
		if (kinds) {
			new Setting(this.contentEl)
				.setName('Kind')
				.setDesc('What a number is. A link says for itself.')
				.addDropdown((d) => {
					for (const [k, label] of Object.entries(kinds)) d.addOption(k, label);
					d.setValue(kind).onChange((v) => {
						kind = v;
					});
					pickKind = (k: string): void => {
						kind = k;
						d.setValue(k);
					};
				});
		}
		hint = this.contentEl.createDiv({ cls: 'kifu-import-hint' });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class SgfPicker extends FuzzySuggestModal<TFile> {
	#pick: (file: TFile) => void;

	constructor(plugin: KifuPlugin, choose: (file: TFile) => void) {
		super(plugin.app);
		this.#pick = choose;
		this.setPlaceholder('Choose an SGF file…');
	}

	getItems(): TFile[] {
		// The one place the vault's files are listed: only while this picker is open, and
		// only the SGF files are kept.
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'sgf');
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.#pick(file);
	}
}
