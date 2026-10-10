/**
 * One board's state: the game tree, where we are in it, and every way of
 * changing either. No DOM and no Obsidian in here, so it can be tested on its own.
 */

import { Orient, rollOrient } from './orient';
import {
	BLACK,
	WHITE,
	Color,
	SgfNode,
	boardSize,
	coord,
	eachNode,
	escapeText,
	followIndexes,
	getMove,
	getText,
	isClosed,
	newNode,
	parseSgf,
	pathIndexes,
	pathTo,
	points,
	serializeSgf,
	setText,
	unescapeText,
	xy2pt,
} from './sgf';
import { FigureNote, Replay, buildFigure, replay } from './goban';
import {
	Numbers,
	Rect,
	autoView,
	composeBlock,
	formatRect,
	fullRect,
	isFull,
	parseBlock,
	parseBool,
	parseNumbers,
	parseSize,
	parseView,
	pointName,
	setOption,
} from './options';
import { Place, squash } from './blocks';
import type { KifuSettings } from './config';

export type Tool = 'play' | 'black' | 'white' | 'TR' | 'SQ' | 'CR' | 'MA' | 'label' | 'erase' | 'crop';
export type Status = 'correct' | 'incorrect' | null;

const MARKS = ['TR', 'SQ', 'CR', 'MA'];
/** Undo keeps at most this many steps, and at most this much game text. */
const UNDO_STEPS = 100;
const UNDO_CHARS = 3_000_000;

/** What the plugin provides to a session. */
export interface Host {
	settings: KifuSettings;
	/** Something worth saving changed. `now` skips the usual short delay. */
	requestSave(s: Session, now?: boolean): void;
	/** Do something a little later. The function that comes back calls it off. */
	later(fn: () => void, ms: number): () => void;
}

/** A board on screen that shows a session. */
export interface SessionView {
	/** The block text this board was drawn from. */
	readonly source: string;
	connected(): boolean;
	/**
	 * The note as the renderer that drew this board has it, and the lines of the
	 * section the board is in. Null when the renderer will not say.
	 */
	sectionInfo(): { text: string; lineStart: number; lineEnd: number } | null;
	/** Where the keyboard is, if this board has it: its pane, and whether it is in the label box. */
	focusState(): { pane: unknown; label: boolean } | null;
}

/** Everything the renderer needs to draw the current position. */
export interface Model {
	w: number;
	h: number;
	/** The part of the board that is drawn. */
	view: Rect;
	/** While editing the whole board is drawn; this is the part that stays visible afterwards. */
	crop: Rect | null;
	grid: Uint8Array;
	/** Text on a point: a move number or a label. */
	labels: Map<number, string>;
	/** TR, SQ, CR or MA on a point. */
	marks: Map<number, string>;
	/** Point to flag as the latest move, or -1. */
	last: number;
	notes: FigureNote[];
	toPlay: Color;
	status: Status;
	hint: string;
	text: string;
}

interface Snapshot {
	/** The game, or null for a step that only changed the option lines. */
	sgf: string | null;
	header: string[];
	at: number[];
	hasGame: boolean;
}

/**
 * An explicit "this is right / this is wrong" on a move: TE and BM, or a comment
 * that says so. Comments only count on moves, and only when they open with the
 * word (or are goproblems-style, with RIGHT at either end): an introduction
 * saying "find the correct move" is not a verdict.
 */
export function nodeMark(n: SgfNode): Status {
	const p = n.props;
	if (p.TE) return 'correct';
	if (p.BM) return 'incorrect';
	const c = (p.B || p.W) && p.C ? (p.C[0] ?? '') : '';
	if (!c) return null;
	if (/^\s*(correct|right|solved|success)\s*([.!:;,)\n]|$)/i.test(c) || /^\s*RIGHT\b|RIGHT[\s.!]*$/.test(c)) return 'correct';
	if (/^\s*(wrong|incorrect|fail(ure|ed|s)?)\s*([.!:;,)\n]|$)/i.test(c)) return 'incorrect';
	return null;
}

const firstSaved = (n: SgfNode): SgfNode | undefined => n.children.find((c) => !c.temp);

function removePoint(node: SgfNode, id: string, pt: string): boolean {
	const vals = node.props[id];
	if (!vals) return false;
	// LB values are "pt:text"; the others may be compressed rectangles
	const flat = id === 'LB' ? vals : points(vals);
	const kept = flat.filter((v) => v.slice(0, 2) !== pt);
	if (kept.length === flat.length) return false;
	if (kept.length) node.props[id] = kept;
	else delete node.props[id];
	return true;
}

function addPoint(node: SgfNode, id: string, value: string): void {
	const vals = node.props[id];
	node.props[id] = (vals ? (id === 'LB' ? vals : points(vals)) : []).concat(value);
}

function bumpLabel(s: string): string {
	if (/^\d+$/.test(s)) return String(parseInt(s) + 1);
	if (/^[a-yA-Y]$/.test(s)) return String.fromCharCode(s.charCodeAt(0) + 1);
	if (s === 'z') return 'a';
	if (s === 'Z') return 'A';
	return s;
}

export class Session {
	readonly host: Host;
	/** The note that holds the block. */
	notePath: string;
	/** Block body as it currently stands in the note. Used to find the block again. */
	body: string;
	/** The option lines, and everything after them, both exactly as written. */
	header: string[] = [];
	opts: Record<string, string> = {};
	rest = '';
	/** Where our game sits in `rest` (null while the block has none). */
	range: [number, number] | null = null;
	/** Whether a game of ours belongs in the block (a new, empty board has none yet). */
	hasGame = false;
	/** Raw `sgf:` reference when the game lives in a file of its own. */
	fileRef: string | null = null;
	/** Vault path of that file once resolved, and the game's text as last read or written. */
	filePath: string | null = null;
	fileGame = '';
	/** Problem loading the board (shown instead of it). */
	error = '';

	root: SgfNode = newNode(null);
	w = 19;
	h = 19;
	/** False until the game has been read (boards that point at a file load it later). */
	ready = false;
	/** The first position of the game (past a root that only carries game info). */
	start: SgfNode = this.root;
	/** The position the block shows at rest. */
	home: SgfNode = this.root;
	cur: SgfNode = this.root;
	/** The number of the last move at `start` and at `home` (0 when none was played before). */
	private startNo = 0;
	private homeNo = 0;
	/** Are there scratch moves in the tree? */
	private scratch = false;

	edit = false;
	tool: Tool = 'play';
	nextLabel = 'a';
	/** The solver asked to see the saved lines of this problem. */
	reveal = false;
	/** The end of the answer, when the solver asked to be shown it (rather than finding it). */
	solutionShown: SgfNode | null = null;
	/** How this board is turned and coloured while locked, once that has been decided ("randomize: on"). */
	private orientRoll: Orient | null = null;
	private solutionCache: { rev: number; home: SgfNode; leaf: SgfNode | null } | null = null;

	/** Unsaved changes to the game / to the option lines. */
	dirtyTree = false;
	dirtyHeader = false;
	/** Counts data changes, so a save can tell whether more happened meanwhile. */
	editRev = 0;
	/** Counts changes to the shape of the tree (for the tree panel). */
	treeRev = 0;
	/** Counts every change. */
	rev = 0;

	/** Boards on screen showing this session. */
	views = new Set<SessionView>();
	/** The one that was used most recently. */
	lastView: SessionView | null = null;
	/**
	 * Where our block stands among the note's blocks (null: not known), and the note's
	 * whole text that this is true of. Both come from a board on screen or from our own
	 * writing, and are then carried along as the note is seen to change, one change at
	 * a time. Then the block's own text letter for letter as the note had it when it
	 * was last looked at with nothing waiting to be written. An edit is only written
	 * where all of this still fits: that is what keeps it out of a block that merely
	 * reads the same.
	 */
	place: Place | null = null;
	known: string | null = null;
	raw: string | null = null;
	/**
	 * The note's text when the place was last seen with our own eyes (by a board on
	 * screen, or because we wrote the block), rather than carried along. Carrying is
	 * exact as far as the text goes, but blocks that read the same can trade places
	 * without the text showing which went where.
	 */
	witnessed: string | null = null;
	/**
	 * The block's text alone must not be used to find it: another block may read the
	 * same and ours may be the one that changed. Only a board on screen can say where
	 * it stands (again).
	 */
	lost = false;
	/** When we last wrote the block, did no other block of the note read the same? */
	alone = false;
	/**
	 * What we have written into the note ourselves lately (white space removed), newest
	 * last. A block that is drawn from one of these texts may be ours coming back (if it
	 * also stands where ours does).
	 */
	written: { text: string; at: number }[] = [];
	/** Set just before we rewrite the block: where the keyboard should go back to. */
	refocus: { pane: unknown; label: boolean; until: number } | null = null;
	/** Why this board can not be edited, if it can not: something about its SGF file... */
	readOnly = '';
	/** ...or something about the block itself or where it is shown, which no file changes. */
	fixed = '';
	/** A save is running / another one is wanted after it. */
	saving = false;
	saveAgain = false;
	/**
	 * An edit of this session was refused: what it holds is in no note, and is not
	 * going to be. The session is finished and must never be shown on a board again.
	 */
	gone = false;
	/** How many times in a row writing has failed (the disk, not the note's contents). */
	failures = 0;
	/** Last used; for pruning cached sessions. */
	stamp = 0;

	private subs = new Set<() => void>();
	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	/** The move whose comment is being typed: one undo step for the whole burst. */
	private burst: SgfNode | null = null;
	private figureWas = 'on';
	private plainWas: string | null = null;
	private lastChild = new WeakMap<SgfNode, SgfNode>();
	/** Calls off the reply that is waiting to be played, if one is. */
	private replyTimer: (() => void) | null = null;
	private posCache: Replay | null = null;
	private posRev = -1;
	private infoCache: { rev: number; problem: boolean; anyCorrect: boolean } | null = null;
	private lockedView: { key: string; rect: Rect } | null = null;

	constructor(host: Host, notePath: string, body: string) {
		this.host = host;
		this.notePath = notePath;
		this.body = body;
		const block = parseBlock(body);
		this.header = block.header;
		this.opts = block.opts;
		this.rest = block.rest;
		this.fileRef = this.opts.sgf || null;
		if (this.fileRef) return; // the game is in a file: whoever can read files loads it
		try {
			const games = block.games;
			const n = this.gameNumber();
			if (!games.length && n === 1) {
				this.load('');
			} else if (!(n >= 1 && n <= games.length)) {
				throw new Error(
					games.length
						? `this block holds ${games.length} game${games.length === 1 ? '' : 's'}; there is no game ${this.opts.game}.`
						: `this block holds no game yet, so there is no game ${this.opts.game}.`,
				);
			} else {
				this.range = games[n - 1];
				this.hasGame = true;
				const game = this.rest.slice(this.range[0], this.range[1]);
				// (cut short: what follows it in the block would count as part of it)
				if (!isClosed(game)) this.fixed = 'the SGF in this block has no closing parenthesis, so it can be looked at but not edited.';
				this.load(game);
			}
		} catch (e) {
			this.error = (e as Error).message;
		}
	}

	/** Why this board can not be unlocked ('' if it can). */
	get cantEdit(): string {
		return this.fixed || this.readOnly;
	}

	/** Which game of a collection this board shows, counting from 1. */
	gameNumber(): number {
		return this.opts.game === undefined ? 1 : parseInt(this.opts.game);
	}

	/* ---------------------------------------------------------------- loading */

	/** Read a game. Empty text makes a new, empty board. */
	load(sgf: string): void {
		let root: SgfNode | undefined;
		if (sgf) {
			root = parseSgf(sgf)[0];
			if (!root) throw new Error('this does not look like SGF.');
		} else {
			const size = parseSize(this.opts.size) ?? [this.host.settings.boardSize, this.host.settings.boardSize];
			root = newNode(null, {
				GM: ['1'],
				FF: ['4'],
				CA: ['UTF-8'],
				SZ: [size[0] === size[1] ? String(size[0]) : `${size[0]}:${size[1]}`],
			});
		}
		this.root = root;
		const [w, h] = boardSize(root);
		// (a board that changed shape can not keep a turn that would not fit it)
		if (w !== this.w || h !== this.h) this.orientRoll = null;
		[this.w, this.h] = [w, h];
		this.error = '';
		this.ready = true;
		this.scratch = false;
		this.treeRev++;
		this.rev++;
		this.findHome();
		this.cur = this.home;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.burst = null;
	}

	/** The game changed on disk: load it again and stay on the same move if we can. */
	reload(sgf: string): void {
		const at = pathIndexes(this.cur);
		const edit = this.edit;
		this.cancelReply();
		this.load(sgf);
		this.cur = followIndexes(this.root, at);
		this.edit = edit;
		this.dirtyTree = false;
		this.emit();
	}

	get numbers(): Numbers | null {
		return parseNumbers(this.opts.numbers);
	}

	/** Work out which node the block shows at rest. */
	private findHome(): void {
		const { w, h } = this;
		// A root that only carries game info, followed by the position itself: start there.
		let start = this.root;
		for (;;) {
			const p = start.props;
			if (p.AB || p.AW || p.AE) break;
			const kids = start.children.filter((c) => !c.temp);
			if (kids.length !== 1 || getMove(kids[0], w, h)) break;
			start = kids[0];
		}
		this.start = start;
		let target: number | null = null;
		const mv = this.opts.move;
		const nums = this.numbers;
		if (mv !== undefined && mv !== '') {
			target = /^(last|end)$/i.test(mv) ? Infinity : parseInt(mv);
			if (isNaN(target)) target = null;
		} else if (nums && !nums.off) {
			target = nums.to ?? Infinity;
		} else if (!this.problem) {
			// Nothing to solve: a record of a game, or a position with a sequence played on
			// it. Where the moves lead is the picture worth showing (and after drawing them
			// with the play tool, it is what one expects to see). A diagram made of setup
			// steps alone stays on its first step.
			for (let n = firstSaved(start); n; n = firstSaved(n)) {
				if (getMove(n, w, h)) {
					target = Infinity;
					break;
				}
			}
		}
		const home = target !== null && target > 0 ? this.walkMain(target) : start;
		this.home = home;
		this.startNo = replay(pathTo(start), w, h).moveNo;
		this.homeNo = home === start ? this.startNo : replay(pathTo(home), w, h).moveNo;
	}

	/** The node a "move: N" line leads to: along the main line from `start` until move N. */
	private walkMain(target: number): SgfNode {
		const { w, h } = this;
		let no = replay(pathTo(this.start), w, h).moveNo;
		let n: SgfNode = this.start;
		while (no < target) {
			const next = firstSaved(n);
			if (!next) break;
			n = next;
			if (getMove(n, w, h)) {
				const mn = parseInt(n.props.MN?.[0] ?? '');
				no = mn > 0 ? mn : no + 1;
			}
		}
		return n;
	}

	/**
	 * The "move:" value that makes the current node the resting position, or null when
	 * none can: a variation, or a setup step after a move, is not on the way a move
	 * number leads.
	 */
	private startValue(): string | null {
		const cur = this.cur;
		if (cur.temp) return null;
		// (a root that only carries game info shows the same board as the start)
		for (let n: SgfNode | null = this.start; n; n = n.parent) if (n === cur) return '0';
		const no = replay(pathTo(cur), this.w, this.h).moveNo;
		return no > 0 && this.walkMain(no) === cur ? String(no) : null;
	}

	/** Can the current position be made the one the board opens at? */
	get canSetStart(): boolean {
		return this.startValue() !== null;
	}

	/** Does a "move:" line choose where the board opens? */
	get hasStart(): boolean {
		return !!this.opts.move;
	}

	/**
	 * Make the current position the one the locked board opens at. Pressed again on
	 * that position, it takes the choice back, so the board opens where it would anyway.
	 */
	toggleStart(): void {
		if (this.hasStart && this.cur === this.home) {
			this.setHeader('move', null);
			return;
		}
		const value = this.startValue();
		if (value !== null) this.setHeader('move', value);
	}

	/* ----------------------------------------------------------------- events */

	on(fn: () => void): void {
		this.subs.add(fn);
	}

	off(fn: () => void): void {
		this.subs.delete(fn);
	}

	emit(): void {
		this.rev++;
		for (const fn of Array.from(this.subs)) fn();
	}

	/** Settings changed: forget anything derived from them and redraw. */
	refresh(): void {
		this.lockedView = null;
		this.findHome();
		this.emit();
	}

	/* --------------------------------------------------------------- position */

	position(): Replay {
		if (!this.posCache || this.posRev !== this.rev) {
			this.posCache = replay(pathTo(this.cur), this.w, this.h);
			this.posRev = this.rev;
		}
		return this.posCache;
	}

	/** Whose turn it is at a node. */
	toPlay(node: SgfNode = this.cur): Color {
		const colorOf = (v: string) => (/^(w|2)/i.test(v) ? WHITE : BLACK);
		const pl = node.props.PL?.[0];
		if (pl) return colorOf(pl);
		for (const c of node.children) {
			if (c.temp) continue;
			const m = getMove(c, this.w, this.h);
			if (m) return m.color;
		}
		let black = false;
		let white = false;
		for (let n: SgfNode | null = node; n; n = n.parent) {
			const m = getMove(n, this.w, this.h);
			if (m) return m.color === BLACK ? WHITE : BLACK;
			if (n !== node && n.props.PL) return colorOf(n.props.PL[0] ?? '');
			if (n.props.AB) black = true;
			if (n.props.AW) white = true;
		}
		// Nothing played yet: White moves first after handicap stones, otherwise Black.
		return black && !white ? WHITE : BLACK;
	}

	/** Which moves get numbers, and what the first of them is called. */
	numbering(): { from: number; start: number } | null {
		const n = this.numbers;
		if (n) return n.off ? null : { from: n.from, start: n.start ?? n.from };
		if (!this.host.settings.numberPlayed) return null;
		// On a locked board the moves played from the resting position are numbered from 1.
		// While editing, every move shows its place in the sequence.
		return { from: (this.edit ? this.startNo : this.homeNo) + 1, start: 1 };
	}

	private info(): { problem: boolean; anyCorrect: boolean } {
		if (!this.infoCache || this.infoCache.rev !== this.treeRev) {
			let anyCorrect = false;
			let moves = false;
			eachNode(this.root, (n) => {
				if (n.temp) return;
				if (nodeMark(n) === 'correct') anyCorrect = true;
				if (!moves && getMove(n, this.w, this.h)) moves = true;
			});
			// A position set up with stones of both colours, and moves saved from it: that
			// reads as a problem. (Marks alone do not make one: a reviewed game has its
			// good and bad moves marked too.)
			let ab = false;
			let aw = false;
			for (let n: SgfNode | undefined = this.root; n && !getMove(n, this.w, this.h); n = firstSaved(n)) {
				if (n.props.AB) ab = true;
				if (n.props.AW) aw = true;
			}
			this.infoCache = { rev: this.treeRev, problem: moves && ab && aw, anyCorrect };
		}
		return this.infoCache;
	}

	/** Does this board judge the moves played on it? (A numbered figure is an illustration, not a problem.) */
	get problem(): boolean {
		const asked = parseBool(this.opts.problem);
		if (asked !== null) return asked;
		return this.figure ? false : this.info().problem;
	}

	private continues(n: SgfNode): boolean {
		return n.children.some((c) => !c.temp && getMove(c, this.w, this.h) !== null);
	}

	private belowHome(n: SgfNode): boolean {
		for (let a = n.parent; a; a = a.parent) if (a === this.home) return true;
		return false;
	}

	/**
	 * Should the saved lines be kept out of sight? They are while a problem is being
	 * solved: showing the tree would give the answer away.
	 */
	get concealed(): boolean {
		return this.host.settings.hideAnswers && !this.edit && !this.reveal && this.problem;
	}

	setReveal(on: boolean): void {
		if (on === this.reveal) return;
		this.reveal = on;
		this.emit();
	}

	/** Verdict on the line being played, once it has ended or left the saved lines. */
	status(): Status {
		if (!this.problem) return this.markedEnd();
		let n = this.cur;
		let off = false;
		while (n.temp && n.parent) {
			n = n.parent;
			off = true;
		}
		if (this.continues(n)) return off && (n === this.home || this.belowHome(n)) ? 'incorrect' : null;
		return this.verdict(n);
	}

	/**
	 * A board that is not a problem judges nothing by itself, but a line someone
	 * marked ✓ or ✗ says so when it has been played out to its end. ("problem: no"
	 * asks for no judging at all.)
	 */
	private markedEnd(): Status {
		if (parseBool(this.opts.problem) === false) return null;
		const n = this.cur;
		if (n.temp || this.continues(n) || !this.belowHome(n)) return null;
		for (let a: SgfNode | null = n; a && a !== this.home; a = a.parent) {
			const mk = nodeMark(a);
			if (mk) return mk;
		}
		return null;
	}

	/**
	 * The answer to this problem: the end of the first saved line from the resting
	 * position that is judged correct (main line first), or null when there is none.
	 */
	solution(): SgfNode | null {
		if (!this.problem) return null;
		const c = this.solutionCache;
		if (c && c.rev === this.treeRev && c.home === this.home) return c.leaf;
		let leaf: SgfNode | null = null;
		// (depth first, in saved order, without recursion: a game record can be long)
		const stack: SgfNode[] = [this.home];
		while (stack.length && !leaf) {
			const n = stack.pop() as SgfNode;
			const kids = n.children.filter((k) => !k.temp);
			if (!kids.length) {
				if (n !== this.home && this.verdict(n) === 'correct') leaf = n;
			} else {
				for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
			}
		}
		this.solutionCache = { rev: this.treeRev, home: this.home, leaf };
		return leaf;
	}

	/** Start again and play the answer out on the board (the saved lines show in the panel too). */
	showSolution(): void {
		const leaf = this.solution();
		if (!leaf || this.edit) return;
		this.reset();
		this.solutionShown = leaf;
		this.reveal = true;
		this.cur = leaf;
		this.emit();
	}

	/** The verdict a saved line carries at its last move (null anywhere else). */
	verdict(leaf: SgfNode): Status {
		if (!this.problem || leaf.temp || this.continues(leaf) || !this.belowHome(leaf)) return null;
		return this.lineStatus(leaf);
	}

	/**
	 * Is the line ending at `leaf` right or wrong? The deepest mark on the way decides.
	 * With no mark on the line: wrong if some other line is marked correct, otherwise
	 * the main line is the answer. "Main line" is about the solver's choices only:
	 * whichever saved reply the other side gives, the solver is still on it.
	 */
	private lineStatus(leaf: SgfNode): Status {
		const solver = this.toPlay(this.home);
		let main = true;
		for (let a: SgfNode | null = leaf; a && a !== this.home; a = a.parent) {
			const mk = nodeMark(a);
			if (mk) return mk;
			const m = getMove(a, this.w, this.h);
			if (m && m.color === solver && a.parent && firstSaved(a.parent) !== a) main = false;
		}
		if (this.info().anyCorrect) return 'incorrect';
		return main ? 'correct' : 'incorrect';
	}

	/** The part of the board shown while locked. */
	restingView(): Rect {
		const key = `${this.treeRev}|${this.opts.view ?? ''}|${this.host.settings.view}`;
		if (this.lockedView && this.lockedView.key === key) return this.lockedView.rect;
		const { w, h, root } = this;
		let v = parseView(this.opts.view, w, h);
		if (v === null) {
			// SGF's own "visible area" property (ignored when it names no point of this board)
			const vw = points(root.props.VW)
				.map((p) => [coord(p.charCodeAt(0)), coord(p.charCodeAt(1))])
				.filter(([x, y]) => x >= 0 && y >= 0 && x < w && y < h);
			if (vw.length) {
				const xs = vw.map((p) => p[0]);
				const ys = vw.map((p) => p[1]);
				v = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
			} else {
				v = this.host.settings.view;
			}
		}
		const rect = v === 'full' ? fullRect(w, h) : v === 'auto' ? autoView(root, w, h) : v;
		this.lockedView = { key, rect };
		return rect;
	}

	model(): Model {
		const { w, h, cur } = this;
		const pos = this.position();
		const numbering = this.numbering();
		let grid = pos.board.g;
		let labels = new Map<number, string>();
		let notes: FigureNote[] = [];
		if (numbering && this.figure && cur === this.home && !this.edit) {
			// At rest, a numbered board is a book figure: captured stones stay in place.
			const fig = buildFigure(pathTo(cur), w, h, numbering.from, numbering.start, (i) =>
				pointName(i % w, Math.floor(i / w), h),
			);
			grid = fig.grid;
			labels = fig.labels;
			notes = fig.notes;
		} else if (numbering) {
			for (let i = 0; i < grid.length; i++) {
				if (pos.num[i] >= numbering.from) labels.set(i, String(pos.num[i] - numbering.from + numbering.start));
			}
		}
		const marks = new Map<number, string>();
		const index = (pt: string): number => {
			const x = coord(pt.charCodeAt(0));
			const y = coord(pt.charCodeAt(1));
			return x >= 0 && y >= 0 && x < w && y < h ? y * w + x : -1;
		};
		for (const id of MARKS) {
			for (const pt of points(cur.props[id])) {
				const i = index(pt);
				if (i >= 0) marks.set(i, id);
			}
		}
		for (const v of cur.props.LB ?? []) {
			const i = index(v);
			if (i >= 0 && v[2] === ':') labels.set(i, unescapeText(v.slice(3)));
		}
		const resting = this.restingView();
		const wanted = parseBool(this.opts.comments) ?? this.host.settings.showComments;
		const text = (cur === this.home ? this.opts.caption : undefined) ?? (wanted ? getText(cur, 'C') : '');
		const toPlay = this.toPlay();
		// Say whose turn it is under a problem, unless its caption already does.
		const hint =
			cur === this.home && this.problem && !/\b(black|white)\b/i.test(text)
				? toPlay === BLACK
					? 'Black to play'
					: 'White to play'
				: '';
		return {
			w,
			h,
			view: this.edit ? fullRect(w, h) : resting,
			crop: this.edit && !isFull(resting, w, h) ? resting : null,
			grid,
			labels,
			marks,
			// the latest move gets a dot when nothing else is written on it
			last: cur !== this.home && pos.last >= 0 && !labels.has(pos.last) ? pos.last : -1,
			notes,
			toPlay,
			status: this.status(),
			hint,
			text,
		};
	}

	/* ------------------------------------------------------------- navigation */

	private cancelReply(): void {
		this.replyTimer?.();
		this.replyTimer = null;
	}

	goto(n: SgfNode): void {
		this.cancelReply();
		if (n === this.cur) return;
		this.cur = n;
		this.burst = null;
		this.emit();
	}

	next(): void {
		const kids = this.cur.children;
		if (!kids.length) return;
		const remembered = this.lastChild.get(this.cur);
		this.goto(remembered && kids.includes(remembered) ? remembered : kids[0]);
	}

	prev(): void {
		const p = this.cur.parent;
		if (!p) return;
		this.lastChild.set(p, this.cur);
		this.goto(p);
	}

	first(): void {
		this.goto(this.start);
	}

	last(): void {
		let n = this.cur;
		while (n.children.length) n = n.children[0];
		this.goto(n);
	}

	/** Undo on a locked board: take back the last step, if anything was done on it at all. */
	stepBack(): void {
		if (this.canStepBack) this.prev();
	}

	/** Redo on a locked board: make again the step that was just taken back. */
	stepForth(): void {
		if (this.canStepForth) this.goto(this.lastChild.get(this.cur) as SgfNode);
	}

	/** Is there a step to take back? Only what was played from the resting position: never the record before it. */
	get canStepBack(): boolean {
		return this.belowHome(this.cur);
	}

	/** Is there a step that was just taken back, to make again? */
	get canStepForth(): boolean {
		const was = this.lastChild.get(this.cur);
		return !!was && this.cur.children.includes(was);
	}

	/** Step sideways to the previous or next variation of the current move. */
	sibling(d: number): void {
		const p = this.cur.parent;
		if (!p) return;
		const next = p.children[p.children.indexOf(this.cur) + d];
		if (next) this.goto(next);
	}

	/** Anything to undo with reset()? */
	get moved(): boolean {
		return this.cur !== this.home || this.scratch;
	}

	private dropScratch(): void {
		let n = this.cur;
		while (n.temp && n.parent) n = n.parent;
		this.cur = n;
		if (!this.scratch) return;
		eachNode(this.root, (node) => {
			if (node.children.some((c) => c.temp)) node.children = node.children.filter((c) => !c.temp);
		});
		this.scratch = false;
		this.treeRev++;
	}

	/** Back to the position the block shows at rest; scratch moves are thrown away. */
	reset(): void {
		this.cancelReply();
		this.dropScratch();
		this.cur = this.home;
		this.burst = null;
		this.reveal = false; // a fresh try
		this.solutionShown = null;
		this.lastChild = new WeakMap(); // (nothing to make again on a fresh try)
		this.emit();
	}

	/* ---------------------------------------------------------------- playing */

	/** A click on the board. */
	click(x: number, y: number): void {
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
		if (this.edit) this.editAt(x, y);
		else this.playAt(x, y);
	}

	/** Could a click here do something? (Used for the hover stone.) */
	canPlay(x: number, y: number): boolean {
		if (this.replyTimer !== null) return false;
		if (this.childAt(x, y)) return true;
		return this.position().board.legal(y * this.w + x, this.toPlay());
	}

	private childAt(x: number, y: number): SgfNode | undefined {
		return this.cur.children.find((c) => {
			const m = getMove(c, this.w, this.h);
			return m !== null && m.x === x && m.y === y;
		});
	}

	/** Locked board: play the position out. Nothing here is ever saved. */
	private playAt(x: number, y: number): void {
		if (this.replyTimer !== null) return;
		let next = this.childAt(x, y);
		if (!next) {
			const color = this.toPlay();
			if (!this.position().board.legal(y * this.w + x, color)) return;
			next = newNode(this.cur, { [color === BLACK ? 'B' : 'W']: [xy2pt(x, y)] });
			next.temp = true;
			this.cur.children.push(next);
			this.scratch = true;
			this.treeRev++;
		}
		this.cur = next;
		this.emit();
		if (!next.temp) this.scheduleReply(next);
	}

	/** A saved line was followed: let it answer. */
	private scheduleReply(node: SgfNode): void {
		const mine = getMove(node, this.w, this.h);
		if (!mine) return;
		const replies = node.children.filter((c) => {
			const m = getMove(c, this.w, this.h);
			return !c.temp && m !== null && m.color !== mine.color;
		});
		if (!replies.length) return;
		const s = this.host.settings;
		const pick = s.reply === 'random' ? replies[Math.floor(Math.random() * replies.length)] : replies[0];
		const play = () => {
			this.replyTimer = null;
			if (this.cur !== node) return;
			this.cur = pick;
			this.emit();
		};
		if (s.replyDelay > 0) this.replyTimer = this.host.later(play, s.replyDelay);
		else play();
	}

	/* ------------------------------------------------------------------- undo */

	private capture(headerOnly: boolean): Snapshot {
		let saved = this.cur;
		while (saved.temp && saved.parent) saved = saved.parent;
		return {
			sgf: headerOnly ? null : serializeSgf(this.root),
			header: this.header.slice(),
			at: pathIndexes(saved),
			hasGame: this.hasGame,
		};
	}

	/** Remember the state before a change. `headerOnly`: the change will not touch the game. */
	private snapshot(headerOnly = false): void {
		this.undoStack.push(this.capture(headerOnly));
		this.redoStack.length = 0;
		this.burst = null;
		// keep the pile bounded, in steps and in size, but never drop the newest step
		let chars = 0;
		for (let i = this.undoStack.length - 1; i > 0; i--) {
			chars += this.undoStack[i].sgf?.length ?? 0;
			if (this.undoStack.length - i >= UNDO_STEPS || chars > UNDO_CHARS) {
				this.undoStack.splice(0, i);
				break;
			}
		}
	}

	private restore(s: Snapshot): void {
		const headerChanged = s.header.join('\n') !== this.header.join('\n');
		this.header = s.header;
		this.opts = parseBlock(s.header.join('\n')).opts;
		if (s.sgf !== null) {
			const root = parseSgf(s.sgf)[0];
			if (root) {
				this.root = root;
				const [w, h] = boardSize(root);
				if (w !== this.w || h !== this.h) this.orientRoll = null;
				[this.w, this.h] = [w, h];
				this.cur = followIndexes(root, s.at);
				this.scratch = false;
			}
			this.dirtyTree = true;
		}
		if (headerChanged) this.dirtyHeader = true;
		this.hasGame = s.hasGame;
		this.burst = null;
		this.commit(true);
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): void {
		const s = this.undoStack.pop();
		if (!s) return;
		this.cancelReply();
		this.redoStack.push(this.capture(s.sgf === null));
		this.restore(s);
	}

	redo(): void {
		const s = this.redoStack.pop();
		if (!s) return;
		this.cancelReply();
		this.undoStack.push(this.capture(s.sgf === null));
		this.restore(s);
	}

	/* ---------------------------------------------------------------- editing */

	/** Note that something changed, ask for it to be saved, and redraw. */
	private commit(shape: boolean): void {
		if (shape) this.treeRev++;
		this.editRev++;
		this.findHome();
		this.host.requestSave(this);
		this.emit();
	}

	/**
	 * Record a change. `shape` says whether the tree looks different afterwards
	 * (as opposed to, say, a comment being typed).
	 */
	private changed(tree: boolean, header = false, shape = tree): void {
		if (tree) {
			this.dirtyTree = true;
			this.hasGame = true;
		}
		if (header) this.dirtyHeader = true;
		this.commit(shape);
	}

	setEdit(on: boolean): void {
		if (on === this.edit || (on && this.cantEdit)) return;
		this.cancelReply();
		this.burst = null;
		if (on) {
			// The line on the board is kept; any other scratch work goes.
			let keep = false;
			for (let n: SgfNode | null = this.cur; n; n = n.parent) if (n.temp) keep = true;
			if (keep) {
				this.snapshot(); // (taken while the line is still scratch, so undo removes it again)
				for (let n: SgfNode | null = this.cur; n; n = n.parent) delete n.temp;
			}
			const here = this.cur;
			this.dropScratch();
			this.cur = here;
			this.edit = true;
			if (keep) {
				this.changed(true);
				return;
			}
		} else {
			// Locking shows the board the way the note will show it from now on.
			this.edit = false;
			this.reveal = false;
			this.cur = this.home;
			// steps taken back while editing are not the solver's to make again
			this.lastChild = new WeakMap();
			this.host.requestSave(this, true);
		}
		this.emit();
	}

	setTool(tool: Tool): void {
		if (tool === 'label' && this.tool !== 'label') this.nextLabel = this.freeLabel();
		this.tool = tool;
		this.emit();
	}

	/** First label of the current series that is not on the board yet. */
	private freeLabel(): string {
		const used = new Set((this.cur.props.LB ?? []).map((v) => unescapeText(v.slice(3))));
		let s = /^\d+$/.test(this.nextLabel) ? '1' : /^[A-Z]$/.test(this.nextLabel) ? 'A' : 'a';
		for (let k = 0; k < 400 && used.has(s); k++) s = bumpLabel(s);
		return s;
	}

	private marked(pt: string): boolean {
		const p = this.cur.props;
		return MARKS.some((id) => points(p[id]).includes(pt)) || (p.LB ?? []).some((v) => v.slice(0, 2) === pt);
	}

	private editAt(x: number, y: number): void {
		const i = y * this.w + x;
		const pt = xy2pt(x, y);
		const cur = this.cur;
		const board = this.position().board;
		switch (this.tool) {
			case 'play': {
				let next = this.childAt(x, y);
				if (!next) {
					const color = this.toPlay();
					if (!board.legal(i, color)) return;
					this.snapshot();
					next = newNode(cur, { [color === BLACK ? 'B' : 'W']: [pt] });
					cur.children.push(next);
					this.cur = next;
					this.changed(true);
				} else {
					this.goto(next);
				}
				return;
			}
			case 'black':
			case 'white': {
				const c = this.tool === 'black' ? BLACK : WHITE;
				this.snapshot();
				this.setStone(i, pt, board.g[i] === c ? 0 : c);
				this.changed(true);
				return;
			}
			case 'TR':
			case 'SQ':
			case 'CR':
			case 'MA': {
				this.snapshot();
				const had = points(cur.props[this.tool]).includes(pt);
				this.clearMarks(pt);
				if (!had) addPoint(cur, this.tool, pt);
				this.changed(true);
				return;
			}
			case 'label': {
				const had = (cur.props.LB ?? []).some((v) => v.slice(0, 2) === pt);
				if (!had && !this.nextLabel && !this.marked(pt)) return; // nothing to write, nothing to clear
				this.snapshot();
				this.clearMarks(pt);
				if (!had && this.nextLabel) {
					addPoint(cur, 'LB', pt + ':' + escapeText(this.nextLabel).replace(/:/g, '\\:'));
					this.nextLabel = bumpLabel(this.nextLabel);
				}
				this.changed(true);
				return;
			}
			case 'erase': {
				if (!this.marked(pt) && !board.g[i]) return;
				this.snapshot();
				if (!this.clearMarks(pt)) this.setStone(i, pt, 0);
				this.changed(true);
				return;
			}
		}
	}

	private clearMarks(pt: string): boolean {
		let any = false;
		for (const id of MARKS) if (removePoint(this.cur, id, pt)) any = true;
		if (removePoint(this.cur, 'LB', pt)) any = true;
		return any;
	}

	/** Make a point black, white or empty at the current node, using setup properties. */
	private setStone(i: number, pt: string, want: number): void {
		const cur = this.cur;
		// what the point would hold without this node's own setup stones
		const base = replay(pathTo(cur), this.w, this.h, true).board.g[i];
		removePoint(cur, 'AB', pt);
		removePoint(cur, 'AW', pt);
		removePoint(cur, 'AE', pt);
		if (want !== base) addPoint(cur, want === BLACK ? 'AB' : want === WHITE ? 'AW' : 'AE', pt);
	}

	/** Change who plays next from here. */
	togglePlayer(): void {
		this.snapshot();
		this.cur.props.PL = [this.toPlay() === BLACK ? 'W' : 'B'];
		this.changed(true);
	}

	/** The mark set directly on the current move (not inherited, not guessed from a comment). */
	ownMark(): Status {
		return this.cur.props.TE ? 'correct' : this.cur.props.BM ? 'incorrect' : null;
	}

	/** Mark the line through the current move as right or wrong. Asking twice clears the mark. */
	mark(status: Status): void {
		if (this.cur === this.root) return;
		this.snapshot();
		const same = this.ownMark() === status;
		delete this.cur.props.TE;
		delete this.cur.props.BM;
		if (!same && status === 'correct') this.cur.props.TE = ['1'];
		if (!same && status === 'incorrect') this.cur.props.BM = ['1'];
		this.changed(true);
	}

	/** Set the comment of the current move. A run of typing on one move is a single undo step. */
	setComment(text: string): void {
		const cur = this.cur;
		const next = text.replace(/\r\n?/g, '\n');
		const before = getText(cur, 'C');
		if (before === next) return;
		if (this.burst !== cur) {
			this.snapshot();
			this.burst = cur;
		}
		const mark = nodeMark(cur);
		setText(cur, 'C', next);
		// typing only redraws the tree when a comment appears, disappears or changes a verdict
		this.changed(true, false, !before !== !next || nodeMark(cur) !== mark);
	}

	/** Remove the current move and everything after it. */
	deleteNode(): void {
		const p = this.cur.parent;
		if (!p) return;
		this.snapshot();
		p.children.splice(p.children.indexOf(this.cur), 1);
		this.cur = p;
		this.changed(true);
	}

	/** Can the current variation move up a place? */
	get canPromote(): boolean {
		for (let n = this.cur; n.parent; n = n.parent) if (n.parent.children.indexOf(n) > 0) return true;
		return false;
	}

	/** Move the current variation one place towards being the main line. */
	promote(): void {
		let n = this.cur;
		while (n.parent && n.parent.children.indexOf(n) === 0) n = n.parent;
		const p = n.parent;
		if (!p) return;
		this.snapshot();
		const k = p.children.indexOf(n);
		p.children[k] = p.children[k - 1];
		p.children[k - 1] = n;
		this.changed(true);
	}

	private setHeader(key: string, value: string | null): void {
		this.snapshot(true);
		this.header = setOption(this.header, key, value);
		if (value === null) delete this.opts[key];
		else this.opts[key] = value;
		this.changed(false, true);
	}

	/**
	 * The "problem:" line that makes this board judge its moves (or not): none at all
	 * when the board would decide the same by itself.
	 */
	problemValue(on: boolean): string | null {
		const auto = this.figure ? false : this.info().problem;
		return on === auto ? null : on ? 'yes' : 'no';
	}

	/** Judge the moves played on this board, or stop judging them. */
	setProblem(on: boolean): void {
		if (on === this.problem) return;
		this.setHeader('problem', this.problemValue(on));
	}

	/** Does the block ask for the board to be shown turned, mirrored or recoloured at random? */
	get randomized(): boolean {
		return parseBool(this.opts.randomize) === true;
	}

	/**
	 * How the locked board is shown, when it is randomized: decided the first time it is
	 * asked for (the board being shown), then kept for as long as this board lives.
	 * While editing the board is always shown as recorded.
	 */
	get orientation(): Orient | null {
		if (this.edit || !this.randomized || !this.ready) return null;
		return (this.orientRoll ??= rollOrient(this.w, this.h));
	}

	/** Show the locked board turned, mirrored and recoloured at random, or as recorded. */
	setRandomize(on: boolean): void {
		if (on === this.randomized) return;
		this.setHeader('randomize', on ? 'on' : null);
	}

	/** Is the locked board a numbered figure rather than the starting position? */
	get figure(): boolean {
		const n = this.numbers;
		return n !== null && !n.off;
	}

	/** Show the main line as a numbered figure when locked, or (off) go back to how it was. */
	setFigure(on: boolean): void {
		if (on === this.figure) return;
		// what the line said before comes back: a range written by hand when the figure
		// is switched on again, a "numbers: off" when it is switched off
		const now = this.opts.numbers;
		if (on) {
			this.plainWas = now ?? null;
			this.setHeader('numbers', this.figureWas);
		} else {
			if (now) this.figureWas = now;
			this.setHeader('numbers', this.plainWas);
		}
	}

	/** Choose the part of the board that is shown while locked (null: back to the default). */
	setCrop(rect: Rect | null): void {
		this.setHeader('view', rect === null ? null : isFull(rect, this.w, this.h) ? 'full' : formatRect(rect, this.w, this.h));
	}

	/* ----------------------------------------------------------------- saving */

	/** The block body as it should be written to the note. */
	blockBody(): string {
		// a board on a file never puts its game in the note
		if (this.fileRef) return composeBlock(this.header, this.rest, null, null);
		let game: string | null = null;
		if (this.hasGame) {
			// a game that has not changed stays exactly as it was written
			game = !this.dirtyTree && this.range ? this.rest.slice(this.range[0], this.range[1]) : serializeSgf(this.root);
		}
		return composeBlock(this.header, this.rest, game, this.range);
	}

	/** The note now holds `body`: take note of where our game sits in it. */
	wrote(body: string): void {
		this.body = body;
		const block = parseBlock(body);
		this.rest = block.rest;
		this.range = !this.fileRef && this.hasGame ? (block.games[this.gameNumber() - 1] ?? null) : null;
	}

	/** We are about to write `body` into the note ourselves. Returns the record, for taking it back. */
	expecting(body: string, now: number): { text: string; at: number } {
		const entry = { text: squash(body), at: now };
		this.written.push(entry);
		if (this.written.length > 12) this.written.shift();
		return entry;
	}

	/** When we wrote this text (white space removed) ourselves, if that was after `since`; otherwise 0. */
	wroteAt(loose: string, since: number): number {
		for (let i = this.written.length - 1; i >= 0; i--) {
			const w = this.written[i];
			if (w.at < since) break;
			if (w.text === loose) return w.at;
		}
		return 0;
	}

	/** When we last wrote to the note ourselves (0: never). */
	get lastWrite(): number {
		return this.written.length ? this.written[this.written.length - 1].at : 0;
	}

	/** The game as it should be written to its SGF file. */
	gameText(): string {
		return serializeSgf(this.root);
	}
}
