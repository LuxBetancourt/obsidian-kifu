/** Reading games from the vault and writing changes back to the note or the SGF file. */

import { App, MarkdownView, Notice, TFile, normalizePath } from 'obsidian';
import { BLOCK_LANG, HANDBACK } from './config';
import { FoundBlock, LineRange, Located, Missing, Note, Place, alike, blockOn, bodyLines, follow, locate, normalize, readNote, reading, replaceBody } from './blocks';
import type { Session, SessionView } from './session';
import { findGames, isClosed } from './sgf';

const NOT_UTF8 = 'this SGF file is not saved as UTF-8, so it can be viewed but not edited here.';
const CUT_SHORT = 'this game has no closing parenthesis in its SGF file, so it can be viewed but not edited here.';

/**
 * Find the SGF file a block points at: a wikilink, a file name, or a path from
 * the vault root or the note's folder. Only ever an .sgf file — a bare name must
 * not land on a note that happens to share it.
 */
export function resolveSgf(app: App, ref: string, notePath: string): TFile | null {
	let name = ref.trim();
	const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(name);
	if (wiki) name = wiki[1];
	else name = name.replace(/^["']|["']$/g, '');
	name = name.split('|')[0].split('#')[0].trim();
	if (!name) return null;
	if (!/\.sgf$/i.test(name)) name += '.sgf';
	const isSgf = (f: unknown): f is TFile => f instanceof TFile && f.extension.toLowerCase() === 'sgf';
	const byLink = app.metadataCache.getFirstLinkpathDest(name, notePath);
	if (isSgf(byLink)) return byLink;
	const folder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/') + 1) : '';
	for (const path of [name, folder + name]) {
		const byPath = app.vault.getAbstractFileByPath(normalizePath(path));
		if (isSgf(byPath)) return byPath;
	}
	return null;
}

/** Read one game out of an SGF file. Throws, with a message fit for the user, when it can not. */
async function readFileGame(app: App, file: TFile, s: Session): Promise<{ game: string; readOnly: string }> {
	let text = await app.vault.cachedRead(file);
	let readOnly = '';
	if (text.includes('�')) {
		// Not UTF-8. Decode it with the charset the file names, for reading only:
		// writing it back would mean re-encoding the whole file.
		const charset = /CA\[([^\]]+)\]/.exec(text)?.[1]?.trim();
		if (charset && !/^utf-?8$/i.test(charset)) {
			try {
				text = new TextDecoder(charset).decode(await app.vault.readBinary(file));
			} catch {
				// unknown charset: show what we have
			}
		}
		readOnly = NOT_UTF8;
	}
	const games = findGames(text);
	if (!games.length) throw new Error(`"${file.path}" has no game in it.`);
	const n = s.gameNumber();
	if (!(n >= 1 && n <= games.length)) {
		throw new Error(`"${file.path}" holds ${games.length} game${games.length === 1 ? '' : 's'}; there is no game ${s.opts.game ?? ''}.`);
	}
	const game = text.slice(games[n - 1][0], games[n - 1][1]);
	// (a file that was cut short: writing "the game" back would swallow whatever follows it)
	if (!readOnly && !isClosed(game)) readOnly = CUT_SHORT;
	return { game, readOnly };
}

/** Read the game a file-backed board shows. Problems end up in `s.error`. */
export async function loadGame(app: App, s: Session): Promise<void> {
	const file = resolveSgf(app, s.fileRef ?? '', s.notePath);
	if (!file) {
		s.error = `can't find the SGF file "${s.fileRef ?? ''}".`;
		return;
	}
	s.filePath = file.path;
	try {
		const { game, readOnly } = await readFileGame(app, file, s);
		s.fileGame = game;
		s.readOnly = readOnly;
		s.load(game);
	} catch (e) {
		s.error = (e as Error).message;
	}
}

/**
 * The file behind a board may have changed: if its game is different now, load it.
 * Returns false when the file (or the game in it) is gone.
 */
export async function refreshGame(app: App, s: Session, force = false): Promise<boolean> {
	const file = s.filePath ? app.vault.getAbstractFileByPath(s.filePath) : null;
	if (!(file instanceof TFile)) return false;
	let fresh: { game: string; readOnly: string };
	try {
		fresh = await readFileGame(app, file, s);
	} catch {
		return false;
	}
	// (an edit made while we were reading goes first; its save will meet the new file)
	if (!force && (s.dirtyTree || s.saving)) return true;
	s.readOnly = fresh.readOnly;
	if (fresh.game !== s.fileGame) {
		s.fileGame = fresh.game;
		if (fresh.readOnly) s.edit = false;
		s.reload(fresh.game);
	} else if (fresh.readOnly && s.edit) {
		s.setEdit(false);
	}
	return true;
}

/** How long the vault is given to do a write before it counts as failed (to be tried again later). */
const WRITE_LIMIT = 15000;

/** Wait for `job`, but not for ever. If it has not answered after `ms`, this fails; the job itself can not be stopped. */
function within<T>(job: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)} seconds`)), ms);
		const over = (): void => window.clearTimeout(timer);
		job.then(
			(v) => {
				over();
				resolve(v);
			},
			(e: unknown) => {
				over();
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

type GameWrite = 'ok' | 'changed' | 'gone' | 'readonly' | 'error';

async function writeGame(app: App, s: Session): Promise<GameWrite> {
	const file = s.filePath ? app.vault.getAbstractFileByPath(s.filePath) : null;
	if (!(file instanceof TFile)) return 'gone';
	if (s.readOnly) return 'readonly';
	const old = s.fileGame;
	const next = s.gameText();
	if (next === old) return 'ok';
	let done = false;
	let givenUp = false;
	s.fileGame = next; // so our own change is not mistaken for someone else's
	try {
		await within(
			app.vault.process(file, (data) => {
				// (we stopped waiting for this: it must not write behind our back now)
				if (givenUp) return data;
				// Only replace the game we loaded. If it changed underneath us — or the file
				// is no longer valid UTF-8 — leave the file alone.
				if (data.includes('�')) return data;
				const g = findGames(data)[s.gameNumber() - 1];
				if (!g || data.slice(g[0], g[1]) !== old) return data;
				done = true;
				return data.slice(0, g[0]) + next + data.slice(g[1]);
			}),
			WRITE_LIMIT,
		);
	} catch (e) {
		givenUp = true;
		console.error('Kifu: writing the SGF file failed', e);
		s.fileGame = old;
		return 'error';
	}
	if (!done) s.fileGame = old;
	return done ? 'ok' : 'changed';
}

/** The panes that have the note open for editing. */
function editors(app: App, path: string): MarkdownView[] {
	const out: MarkdownView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		const v = leaf.view;
		if (v instanceof MarkdownView && v.file?.path === path && v.getMode() === 'source') out.push(v);
	});
	return out;
}

/** A note's text, read for our blocks. */
export const read = (text: string): Note => readNote(text, BLOCK_LANG);

/**
 * Does any editor that has the note open hold a block reading `body`? Null when no
 * editor has it open. (Two editors on one note need not be in step at every moment.)
 */
export function editorsHold(app: App, path: string, body: string): boolean | null {
	const all = editors(app, path);
	if (!all.length) return null;
	return all.some((v) => reading(read(v.editor.getValue()).blocks, body).length > 0);
}

interface CodeMirrorish {
	contentDOM?: Element;
	posAtDOM?: (node: Node, offset?: number) => number;
	state?: { doc?: { lineAt?: (pos: number) => { number: number } } };
}

/**
 * The lines of the note that a board inside this editor stands for. In Live Preview a
 * board sits in a widget that takes the place of some lines: its block, or the callout
 * its block is in. This asks the editor's CodeMirror view, which Obsidian's typings leave
 * out but its guide to editor extensions uses the same way. If it is not there, or the
 * element is not in this editor, the answer is null.
 */
function widgetLines(view: MarkdownView, el: Element): LineRange | null {
	const cm = (view.editor as unknown as { cm?: CodeMirrorish }).cm;
	try {
		const content = cm?.contentDOM;
		if (!cm || !content || !cm.posAtDOM || !cm.state?.doc?.lineAt || !el.isConnected || !content.contains(el)) return null;
		// the widget: the child of the editor's content that holds the board
		let top: Element = el;
		while (top.parentElement && top.parentElement !== content) top = top.parentElement;
		if (top.parentElement !== content) return null;
		const a = cm.state.doc.lineAt(cm.posAtDOM(top, 0)).number - 1;
		const b = cm.state.doc.lineAt(cm.posAtDOM(top, top.childNodes.length)).number - 1;
		if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return null;
		return { lineStart: Math.min(a, b), lineEnd: Math.max(a, b) };
	} catch {
		return null; // not something this editor can place
	}
}

/**
 * What a board on screen can tell about where it stands: the note as its own editor or
 * renderer has it, and which of the blocks there it is a drawing of (the block's
 * number; -1 when the block under it reads something else by now; null when several
 * there read the same). `editor` is the editor it sits in, if it sits in one: then
 * `note` is the note as it is this moment, not a renderer's copy that may be behind.
 */
export interface Seen {
	note: Note;
	ord: number | null;
	editor: MarkdownView | null;
}

/**
 * See `Seen`. Null when the board can not tell anything (it is not on the page, or
 * nothing says where it is). `held`: for asking many boards in one go, the notes of
 * the editors met so far (an editor's whole text is not something to fetch per board).
 */
export function evidence(app: App, path: string, v: SessionView, el: Element | null, body: string, held?: Map<MarkdownView, Note>): Seen | null {
	if (!v.connected()) return null;
	if (el) {
		for (const editor of editors(app, path)) {
			const range = widgetLines(editor, el);
			if (!range) continue;
			let note = held?.get(editor);
			if (!note) {
				note = read(editor.editor.getValue());
				held?.set(editor, note);
			}
			return { note, ord: blockOn(note.blocks, body, range), editor };
		}
	}
	// (the text and the lines come from one answer of the renderer, so they belong
	// together; whether that text is still the note's is for whoever uses this to check)
	const info = v.sectionInfo();
	if (!info) return null;
	const note = read(info.text);
	return { note, ord: blockOn(note.blocks, body, info), editor: null };
}

/** The note as each pane that has it open for editing holds it this moment. (None: nobody is editing it.) */
export function editorTexts(app: App, path: string): string[] {
	return editors(app, path).map((v) => v.editor.getValue());
}

/** The text of the one block a board stands on in an open editor; null when no editor can tell. */
export function blockUnder(app: App, path: string, el: Element): string | null {
	for (const view of editors(app, path)) {
		const range = widgetLines(view, el);
		if (!range) continue;
		const under = read(view.editor.getValue()).blocks.filter((b) => b.open <= range.lineEnd && b.close >= range.lineStart);
		return under.length === 1 ? under[0].body : null;
	}
	return null;
}

type BlockWrite = 'ok' | Missing | 'nonote' | 'error';

/** What the plugin does for a save. */
export interface SaveHooks {
	/** The element a board is drawn in. */
	elementOf(v: SessionView | null): Element | null;
	/** Is it settled that this board is a drawing of its session's block? (Only then is it asked where the block stands.) */
	settled(v: SessionView): boolean;
	/**
	 * A block has been rewritten: number `ord` of the note, which read `before` and now
	 * reads `after`; the block itself read `was`. (Other boards of the note may have
	 * been drawings of it, and every other board's block may have moved by some lines.)
	 */
	wrote(s: Session, before: Note, after: Note, ord: number, was: string): void;
	/** This board turned out to stand on another block than its session's: it is not that session's board. */
	astray(v: SessionView): void;
	/**
	 * This session's edit was refused and the session is finished. Its boards go back to
	 * what they were drawn from; `lost`: without trusting their text to say which block
	 * that is.
	 */
	dropped(s: Session, lost: boolean): void;
}

const turns = new Map<string, Promise<void>>();
/** How long a write may keep the next one waiting. (One that never comes back must not block the note for good.) */
const TURN_LIMIT = 20000;

/** Do `job` once every job queued for `key` before it is done; straight away if there is none. */
function inTurn<T>(key: string, job: () => Promise<T>): Promise<T> {
	const before = turns.get(key);
	const run = before ? before.then(job) : job();
	const done = new Promise<void>((resolve) => {
		const timer = window.setTimeout(resolve, TURN_LIMIT);
		const over = (): void => {
			window.clearTimeout(timer);
			resolve();
		};
		run.then(over, over);
	});
	turns.set(key, done);
	void done.then(() => {
		if (turns.get(key) === done) turns.delete(key);
	});
	return run;
}

/**
 * Write a session's block to its note. Writes to one note take turns: each decides
 * which block is its own by what the note holds, and the one before may have changed that.
 */
function writeBlock(app: App, s: Session, hooks: SaveHooks): Promise<BlockWrite> {
	return inTurn(s.notePath, () => writeBlockNow(app, s, hooks));
}

async function writeBlockNow(app: App, s: Session, hooks: SaveHooks): Promise<BlockWrite> {
	const old = s.body;
	const next = s.blockBody();
	if (normalize(next) === normalize(old)) return 'ok';
	const file = app.vault.getAbstractFileByPath(s.notePath);
	if (!(file instanceof TFile)) return 'nonote';

	// Where is our block? There are two things to go by. What the session knew: its
	// place in the note as the note then read, which can be carried forward to the
	// note as it reads now. And a board of ours on the page, drawn from the block as it
	// stands: it is where the block is.
	interface Lead {
		place: Place;
		note: Note;
		raw: string | null;
	}
	const knew: Lead | null = s.place && s.known !== null ? { place: s.place, note: read(s.known), raw: s.raw } : null;
	let board: (Lead & { editor: MarkdownView | null }) | null = null;
	for (const v of s.lastView ? [s.lastView, ...s.views] : Array.from(s.views)) {
		if (!hooks.settled(v) || !alike(v.source, old)) continue;
		const seen = evidence(app, s.notePath, v, hooks.elementOf(v), old);
		if (!seen || seen.ord === null || seen.ord < 0) continue;
		// (an editor moves a board along with its block: there the board is always right)
		const expected = knew && !seen.editor ? follow(knew.note, knew.place, seen.note) : null;
		if (expected && expected.ord !== seen.ord) {
			// Going by the note our block is elsewhere than under this board: a renderer
			// that keeps drawings by their text has put this one on another block that
			// reads the same. The edit stays with the block it was made on.
			hooks.astray(v);
			continue;
		}
		const lead = { place: { ord: seen.ord, total: seen.note.blocks.length }, note: seen.note, raw: s.raw ?? seen.note.blocks[seen.ord].body, editor: seen.editor };
		// (a board in an editor speaks of the note as it is; a renderer's copy may be behind)
		if (!board || (lead.editor && !board.editor)) board = lead;
		if (lead.editor) break;
	}
	const leads: Lead[] = [];
	if (board?.editor) leads.push(board);
	if (knew) leads.push(knew);
	if (board && !board.editor) leads.push(board);
	const through = board?.editor ?? null;
	/** The block to write to, in the note as it stands. */
	const pick = (target: Note): Located => {
		let first: Located | null = null;
		for (const lead of leads) {
			const place = follow(lead.note, lead.place, target);
			const found: Located = place
				? locate(target.blocks, old, place, lead.raw, false)
				: { block: null, why: reading(target.blocks, old).length ? 'unsure' : 'missing' };
			if (found.block) return found;
			first ??= found;
		}
		// (nothing was ever known about where it stands: its text is all there is to go by)
		return first ?? locate(target.blocks, old, null, s.raw, !s.lost);
	};

	// The block is re-rendered as soon as its text changes, possibly before we get
	// control back: settle now which text belongs to this session...
	const before = { rest: s.rest, range: s.range, refocus: s.refocus, place: s.place, known: s.known, witnessed: s.witnessed, raw: s.raw, lost: s.lost, alone: s.alone };
	s.wrote(next);
	const record = s.expecting(next, Date.now());
	// ...and where the keyboard is, so the replacement board can take it back.
	for (const v of s.views) {
		const f = v.focusState();
		if (f) s.refocus = { pane: f.pane, label: f.label, until: Date.now() + HANDBACK };
	}

	// how it went, and what was written: the note before and after, the block's number, what it read
	const out = { result: 'missing' as BlockWrite, done: null as { was: Note; now: Note; ord: number; read: string } | null };
	let givenUp = false;
	/**
	 * The new text is on its way into the note: from this moment the session knows its
	 * block as it now reads. (Not a moment later: the note's renderers may draw the block
	 * again before we get control back, and ask whether that drawing is ours.)
	 */
	const commit = (was: Note, now: Note, ord: number, body: string): void => {
		const mine = now.blocks[ord] as FoundBlock | undefined;
		if (mine && now.blocks.length === was.blocks.length && alike(mine.body, next)) {
			s.place = { ord, total: now.blocks.length };
			s.known = now.text;
			s.witnessed = now.text;
			s.raw = mine.body;
			s.lost = false;
			s.alone = reading(now.blocks, next).length === 1;
		} else {
			// (a write of ours never adds or removes a block; if the note says otherwise, we know nothing)
			s.place = null;
			s.known = null;
			s.witnessed = null;
			s.raw = null;
			s.lost = true;
		}
		out.done = { was, now, ord, read: body };
		out.result = 'ok';
	};
	try {
		// An open editor is where the note is changed: that keeps its cursor, folds and
		// undo history, and its text may be newer than the file.
		const all = editors(app, s.notePath);
		const near = hooks.elementOf(s.lastView);
		const view = through ?? all.find((v) => near !== null && v.containerEl.contains(near)) ?? all[0];
		if (view) {
			const editor = view.editor;
			const was = read(editor.getValue());
			const found = pick(was);
			if (found.block) {
				const body = bodyLines(found.block, next);
				// (what the editor will hold, worked out beforehand: see `commit`)
				const lines = was.lines.slice();
				lines.splice(found.block.open + 1, found.block.close - found.block.open - 1, ...body);
				commit(was, read(lines.join('\n')), found.ord, found.block.body);
				editor.replaceRange(
					body.length ? body.join('\n') + '\n' : '',
					{ line: found.block.open + 1, ch: 0 },
					{ line: found.block.close, ch: 0 },
				);
			} else {
				out.result = found.why;
			}
		} else {
			// Nobody is editing the note: change the file. First let any open (reading) view
			// write out what it still holds, so we work on the latest text.
			const open: MarkdownView[] = [];
			app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof MarkdownView && leaf.view.file?.path === s.notePath) open.push(leaf.view);
			});
			const write = async (): Promise<void> => {
				for (const v of open) await v.save();
				await app.vault.process(file, (data) => {
					// (we stopped waiting for this: it must not write behind our back now)
					if (givenUp) return data;
					const was = read(data);
					const found = pick(was);
					if (!found.block) {
						out.result = found.why;
						out.done = null;
						return data;
					}
					const text = replaceBody(data, found.block, next);
					commit(was, read(text), found.ord, found.block.body);
					return text;
				});
			};
			await within(write(), WRITE_LIMIT);
		}
	} catch (e) {
		givenUp = true;
		console.error('Kifu: writing the note failed', e);
		out.result = 'error';
		out.done = null;
	}
	if (out.result === 'ok' && out.done) {
		const { was, now, ord, read: body } = out.done;
		hooks.wrote(s, was, now, ord, body);
	} else {
		// nothing was written: the note still holds what it held
		Object.assign(s, before);
		s.body = old;
		const k = s.written.indexOf(record);
		if (k >= 0) s.written.splice(k, 1);
	}
	return out.result;
}

const told = new WeakMap<Session, Map<string, number>>();

/** Tell the user something went wrong with a board, but not the same thing over and over. */
function tell(s: Session, message: string): void {
	const now = Date.now();
	let mine = told.get(s);
	if (!mine) told.set(s, (mine = new Map<string, number>()));
	if (now - (mine.get(message) ?? 0) < 5000) return;
	mine.set(message, now);
	new Notice(message, 10000);
}

const BLOCK_PROBLEM: Record<Missing | 'nonote', string> = {
	missing: "Kifu: this board's block was changed or removed in the note while the board was being edited, so this edit was not saved.",
	ambiguous:
		'Kifu: this note has several boards with the same text, and where this one is shown there is no telling which of them it is, so this edit was not saved. Give one of them a caption line in the note to tell them apart, then make the edit again.',
	unsure: 'Kifu: the note changed while this board was being edited, and it is no longer certain which block the board belongs to, so this edit was not saved.',
	nonote: 'Kifu: the note this board belongs to is gone, so this edit was not saved.',
};

/** How often a write that failed is tried again before the edit is given up, and how long each try waits. */
export const RETRY_WAITS = [2000, 5000, 15000, 30000, 60000];

/** What became of a save: done; another is running; refused (nowhere to write to); failed (could not write: worth another try). */
export type Outcome = 'ok' | 'busy' | 'refused' | 'failed';

/**
 * An edit has nowhere to go. Say so, and do not hold on to it: a later change to the
 * note must not make it look as if it had a place after all (if its own block was
 * changed, a block that merely reads the same is all that could turn up). The session
 * is finished, and its boards go back to showing what they were drawn from.
 */
function refused(s: Session, why: Missing | 'nonote', hooks: SaveHooks, message = BLOCK_PROBLEM[why]): Outcome {
	tell(s, message);
	s.dirtyTree = false;
	s.dirtyHeader = false;
	s.gone = true;
	// (several look-alikes and no telling which: the board itself is a true picture of
	// its block. Otherwise the block is not what the board shows any more.)
	hooks.dropped(s, why !== 'ambiguous');
	return 'refused';
}

/** The note or the SGF file could not be written. That may pass: the edit is kept and tried again. */
function failed(s: Session, what: string): Outcome {
	const tries = s.failures++;
	if (tries >= RETRY_WAITS.length && s.views.size === 0) {
		// (nobody is looking at it and it will not go through: enough)
		s.dirtyTree = false;
		s.dirtyHeader = false;
		s.gone = true;
		tell(s, `Kifu: ${what} still could not be written. The edit that was waiting for it is lost.`);
		return 'refused';
	}
	if (tries === 0) {
		tell(
			s,
			s.views.size > 0
				? `Kifu: ${what} could not be written, so this edit is not saved yet. It is still on the board, and saving will be tried again.`
				: `Kifu: ${what} could not be written, so an edit is not saved yet. Saving will be tried again.`,
		);
	}
	return 'failed';
}

/** Write whatever a session has changed. Never throws. */
export async function saveSession(app: App, s: Session, hooks: SaveHooks): Promise<Outcome> {
	if (s.saving) {
		s.saveAgain = true;
		return 'busy';
	}
	s.saving = true;
	let outcome: Outcome = 'ok';
	try {
		do {
			s.saveAgain = false;
			if (!s.dirtyTree && !s.dirtyHeader) break;
			const rev = s.editRev;
			const unchanged = (): boolean => s.editRev === rev;
			if (s.fileRef) {
				// the game goes to its SGF file, the option lines to the note
				if (s.dirtyTree) {
					const r = await writeGame(app, s);
					if (r === 'changed') {
						// Someone else changed the file. Theirs wins: show what is on disk now.
						s.dirtyTree = false;
						if (await within(refreshGame(app, s, true), WRITE_LIMIT).catch(() => false)) {
							tell(s, 'Kifu: the SGF file was changed (by another board or another program) since this board read it, so the board was reloaded and your last edit dropped.');
						} else {
							tell(s, `Kifu: can't find this game in its SGF file any more, so this edit was not saved.`);
						}
						outcome = 'refused';
						break;
					}
					if (r === 'gone') {
						outcome = refused(s, 'nonote', hooks, `Kifu: can't find the SGF file any more, so this edit was not saved.`);
						break;
					}
					if (r === 'readonly') {
						outcome = refused(s, 'nonote', hooks, `Kifu: ${s.readOnly} This edit was not saved.`);
						break;
					}
					if (r === 'error') {
						outcome = failed(s, 'the SGF file');
						break;
					}
					if (unchanged()) s.dirtyTree = false;
				}
				if (s.dirtyHeader) {
					const r = await writeBlock(app, s, hooks);
					if (r !== 'ok') {
						outcome = r === 'error' ? failed(s, 'the note') : refused(s, r, hooks);
						break;
					}
					if (unchanged()) s.dirtyHeader = false;
				}
			} else {
				const r = await writeBlock(app, s, hooks);
				if (r !== 'ok') {
					outcome = r === 'error' ? failed(s, 'the note') : refused(s, r, hooks);
					break;
				}
				if (unchanged()) {
					s.dirtyTree = false;
					s.dirtyHeader = false;
				}
			}
			s.failures = 0;
			if (!unchanged()) s.saveAgain = true;
		} while (s.saveAgain);
	} catch (e) {
		console.error('Kifu: saving failed', e);
		outcome = failed(s, 'the note');
	} finally {
		s.saving = false;
	}
	return outcome;
}
