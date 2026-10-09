/** One rendered board block: the drawing, the lock, the caption and (while editing) the tools. */

import { MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type KifuPlugin from '../main';
import { BASE_CELL } from '../config';
import { Rect, parseBool, parseScale } from '../options';
import type { Model, Session, SessionView, Tool } from '../session';
import { BoardSvg } from './boardsvg';
import { clear, el, icon, iconButton, setIcon } from './dom';
import { fromShown, orientModel, shownColor } from '../orient';

const TOOLS: [Tool, string, string][] = [
	['play', 'playB', 'Play moves (click again to change who plays)'],
	['black', 'black', 'Black stone'],
	['white', 'white', 'White stone'],
	['TR', 'TR', 'Triangle'],
	['SQ', 'SQ', 'Square'],
	['CR', 'CR', 'Circle'],
	['MA', 'MA', 'Cross'],
	['label', 'label', 'Letter or number'],
	['erase', 'erase', 'Eraser'],
	['crop', 'crop', 'Choose the part of the board to show (drag; double-click or double-tap for the default)'],
];

/** Events that stay inside a board (see the constructor). */
const CONTAINED = [
	'keydown',
	'keyup',
	'keypress',
	'beforeinput',
	'input',
	'paste',
	'cut',
	'copy',
	'compositionstart',
	'compositionupdate',
	'compositionend',
];

// Members are #private throughout: this class extends one of Obsidian's, and a
// plain property could silently shadow something the app keeps there.
export class BoardView extends MarkdownRenderChild implements SessionView {
	session: Session | null = null;
	/** The block text this board was drawn from. */
	readonly source: string;
	#plugin: KifuPlugin;
	#ctx: MarkdownPostProcessorContext;
	#root: HTMLElement;
	#frame: HTMLElement;
	#board: BoardSvg;
	#lockBtn: HTMLButtonElement;
	#resetBtn: HTMLButtonElement;
	#problemBtn: HTMLButtonElement;
	#randomBtn: HTMLButtonElement;
	#backBtn: HTMLButtonElement;
	#forwardBtn: HTMLButtonElement;
	#solutionBtn: HTMLButtonElement;
	#cap: HTMLElement;
	#msg: HTMLElement;
	#tools: HTMLElement | null = null;
	#toolBtns = new Map<string, HTMLButtonElement>();
	#labelInput: HTMLInputElement | null = null;
	#drag: [number, number] | null = null;
	/** When the last plain tap with the crop tool ended, and when a double tap last reset the crop. */
	#lastTap = 0;
	#tapReset = 0;
	#hover = '';
	/** The ✓ or ✗ shown over the board when a line ends, and the move it was shown for. */
	#stamp: HTMLElement | null = null;
	#stampAt: object | null = null;
	/** Reached with the Tab key (then, and only then, a focus ring is shown). */
	#keyFocus = false;
	#onChange = (): void => this.#render();

	constructor(containerEl: HTMLElement, plugin: KifuPlugin, ctx: MarkdownPostProcessorContext, source: string) {
		super(containerEl);
		this.#plugin = plugin;
		this.#ctx = ctx;
		this.source = source;

		const root = (this.#root = el(containerEl, 'div', 'kifu'));
		root.tabIndex = 0;
		this.#msg = el(root, 'div', 'kifu-msg');
		this.#msg.hidden = true;
		this.#frame = el(root, 'div', 'kifu-frame');
		this.#board = new BoardSvg(this.#frame);
		const ctl = el(this.#frame, 'div', 'kifu-ctl');
		this.#lockBtn = iconButton(ctl, 'lock', 'Unlock to edit', () => this.#toggleLock());
		// On a locked board: take back the moves played on it, and make them again. Never
		// a step into the record itself, before the resting position or after it (that
		// would give a problem's answer away). Unlocked, the toolbar has its own buttons.
		this.#backBtn = iconButton(ctl, 'prev', 'Take back your last move', () => this.session?.stepBack());
		this.#forwardBtn = iconButton(ctl, 'next', 'Play it again', () => this.session?.stepForth());
		this.#solutionBtn = iconButton(ctl, 'eye', 'Show the solution', () => this.session?.showSolution());
		this.#resetBtn = iconButton(ctl, 'reset', 'Back to the starting position', () => this.session?.reset());
		this.#problemBtn = iconButton(ctl, 'problem', 'Problem: judge the moves played on this board', () => {
			const s = this.session;
			if (s) s.setProblem(!s.problem);
		});
		this.#problemBtn.hidden = true;
		this.#randomBtn = iconButton(ctl, 'shuffle', 'Shuffle: each time the note is opened, show this board turned or mirrored, and perhaps with the colors swapped', () => {
			const s = this.session;
			if (s) s.setRandomize(!s.randomized);
		});
		this.#randomBtn.hidden = true;
		this.#cap = el(root, 'div', 'kifu-cap');

		const svgEl = this.#board.el;
		// Keep the press to ourselves: no text selection, and in Live Preview the
		// editor ignores a mouse press whose default has been prevented. That goes for
		// the label box too, so a press there is acted on here.
		root.addEventListener('mousedown', (ev) => {
			this.#setKeyFocus(false);
			ev.preventDefault();
			const field = this.#labelInput;
			if (field && ev.target === field) {
				field.focus({ preventScroll: true });
				field.select();
			} else if (root.ownerDocument.activeElement !== root) {
				root.focus({ preventScroll: true });
			}
		});
		// A click that reaches Obsidian with its default prevented is one Obsidian leaves
		// alone (inside a callout, an unclaimed click would open the callout for editing).
		root.addEventListener('click', (ev) => ev.preventDefault());
		// What is typed or pasted while the board or its label box has the keyboard is
		// meant for the board. In Live Preview the board sits inside the editor's own
		// element, so none of it may travel on to the editor.
		for (const type of CONTAINED) root.addEventListener(type, (ev) => ev.stopPropagation());
		root.addEventListener('pointerdown', () => this.#activate());
		root.addEventListener('contextmenu', () => {
			if (this.session) this.#plugin.menuOn(this.session);
		});
		root.addEventListener('focusin', () => this.#activate());
		root.addEventListener('focusout', () => this.#setKeyFocus(false));
		root.addEventListener('keyup', (ev) => {
			if (ev.key === 'Tab' && ev.target === root) this.#setKeyFocus(true);
		});
		root.addEventListener('keydown', (ev) => this.#onKey(ev));
		svgEl.addEventListener('click', (ev) => this.#onClick(ev));
		svgEl.addEventListener('dblclick', () => {
			// (a double tap that the browser reports as a double click too was dealt with already)
			if (this.#cropping() && Date.now() - this.#tapReset > 600) this.session?.setCrop(null);
		});
		svgEl.addEventListener('pointerdown', (ev) => this.#onDown(ev));
		svgEl.addEventListener('pointermove', (ev) => this.#onMove(ev));
		svgEl.addEventListener('pointerup', (ev) => this.#onUp(ev));
		svgEl.addEventListener('pointercancel', () => this.#endDrag());
		svgEl.addEventListener('pointerleave', () => {
			this.#hover = '';
			this.#board.setGhost(-1, -1, 0);
		});
	}

	/* ------------------------------------------------------------ SessionView */

	connected(): boolean {
		return this.#root.isConnected;
	}

	sectionInfo(): { text: string; lineStart: number; lineEnd: number } | null {
		try {
			const info = this.#ctx.getSectionInfo(this.containerEl);
			if (!info || typeof info.text !== 'string') return null;
			return { text: info.text, lineStart: info.lineStart, lineEnd: info.lineEnd };
		} catch {
			return null;
		}
	}

	/** The pane this board sits in (or, outside any pane, its document). */
	pane(): unknown {
		return this.#root.closest('.workspace-leaf') ?? this.#root.ownerDocument;
	}

	focusState(): { pane: unknown; label: boolean } | null {
		const root = this.#root;
		const active = root.ownerDocument.activeElement;
		if (!root.isConnected || !active || !root.contains(active)) return null;
		return { pane: this.pane(), label: active === this.#labelInput };
	}

	/* -------------------------------------------------------------- lifecycle */

	/**
	 * In Live Preview the block's own "edit" button sits in the corner the lock uses.
	 * A class on the block's container lets the stylesheet move it out of the way.
	 */
	#markHost(on = true): void {
		const host = this.containerEl.parentElement;
		if (host?.classList.contains('cm-preview-code-block')) host.classList.toggle('kifu-block-host', on);
	}

	onload(): void {
		// (the container may only be put around the block after it was handed to us)
		window.requestAnimationFrame(() => this.#markHost());
	}

	attach(s: Session): void {
		if (this.session === s) return;
		this.#detach();
		this.session = s;
		s.views.add(this);
		s.on(this.#onChange);
		this.#render();
		const want = s.refocus;
		if (want && Date.now() < want.until) {
			// We rewrote the block while its board had the keyboard, and this is the
			// replacement: take the keyboard back once we are on the page.
			const root = this.#root;
			let tries = 20;
			const take = (): void => {
				if (this.session !== s || s.refocus !== want) return;
				// (looked up now, not earlier: the board may be shown in another window by now)
				const doc = root.ownerDocument;
				if (!root.isConnected) {
					if (tries-- > 0) (doc.defaultView ?? window).requestAnimationFrame(take);
					return;
				}
				if (this.pane() !== want.pane) return;
				s.refocus = null;
				// unless the keyboard has gone somewhere else meanwhile
				if (doc.activeElement !== doc.body && doc.activeElement !== null) return;
				const input = want.label ? this.#labelInput : null;
				if (input && !input.hidden) {
					input.focus({ preventScroll: true });
					input.setSelectionRange(input.value.length, input.value.length);
				} else {
					root.focus({ preventScroll: true });
				}
			};
			(root.ownerDocument.defaultView ?? window).requestAnimationFrame(take);
		}
	}

	#detach(): void {
		const s = this.session;
		if (!s) return;
		s.off(this.#onChange);
		s.views.delete(this);
		if (s.lastView === this) s.lastView = null;
		this.session = null;
	}

	onunload(): void {
		const s = this.session;
		this.#markHost(false);
		this.#detach();
		if (s) this.#plugin.sessionReleased(s);
	}

	/** The plugin is being switched off: stay on the page as a picture, but do nothing any more. */
	freeze(): void {
		this.#detach();
		this.#tools?.remove();
		this.#tools = null;
		this.#lockBtn.hidden = true;
		this.#resetBtn.hidden = true;
		this.#problemBtn.hidden = true;
		this.#randomBtn.hidden = true;
		this.#backBtn.hidden = this.#forwardBtn.hidden = true;
		this.#solutionBtn.hidden = true;
		this.#board.setGhost(-1, -1, 0);
		this.#root.classList.remove('is-editing', 'is-crop');
	}

	#setKeyFocus(on: boolean): void {
		this.#keyFocus = on;
		this.#root.classList.toggle('is-keyfocus', on);
	}

	/** Tell the plugin this is the board being used. */
	#activate(): void {
		if (this.session) this.#plugin.useSession(this);
	}

	/* ----------------------------------------------------------------- render */

	/** Show a message in place of the board ('' shows nothing at all, null shows the board). */
	#message(text: string | null): void {
		this.#msg.textContent = text ?? '';
		this.#msg.hidden = !text;
		this.#frame.hidden = text !== null;
		if (text !== null) {
			this.#cap.hidden = true;
			this.#tools?.remove();
			this.#tools = null;
		}
	}

	#render(): void {
		const s = this.session;
		if (!s) return;
		this.#markHost();
		if (this.#drag && !this.#cropping()) this.#endDrag();
		const root = this.#root;
		if (s.error || !s.ready) {
			root.className = 'kifu';
			// (while a file is being read there is nothing to say yet: stay blank)
			this.#message(s.error ? `Kifu: ${s.error}` : '');
			return;
		}
		this.#message(null);
		const set = this.#plugin.settings;
		const cell = Math.max(6, Math.round(BASE_CELL * (parseScale(s.opts.scale) ?? set.scale)));
		const coords = parseBool(s.opts.coords) ?? set.coords;
		const style = /^(paper|theme)$/.test(s.opts.style ?? '') ? s.opts.style : set.style;
		const align = /^(left|center|right)$/.test(s.opts.align ?? '') ? s.opts.align : set.align;
		root.className =
			`kifu kifu-${style} kifu-${align}` +
			(s.edit ? ' is-editing' : '') +
			(s.edit && s.tool === 'crop' ? ' is-crop' : '') +
			(this.#keyFocus ? ' is-keyfocus' : '');

		// (a randomized board is drawn turned and recoloured; the session itself knows nothing of it)
		const o = s.orientation;
		const m = o ? orientModel(s.model(), o) : s.model();
		this.#board.draw(m, { cell, coords });
		this.#hover = '';

		setIcon(this.#lockBtn.firstChild as SVGSVGElement, s.edit ? 'unlock' : 'lock');
		this.#lockBtn.setAttribute('aria-label', s.edit ? 'Lock (stop editing)' : 'Unlock to edit');
		this.#lockBtn.classList.toggle('is-active', s.edit);
		this.#resetBtn.hidden = s.edit || !s.moved;
		// (shown once something has been played, like the reset button)
		this.#backBtn.hidden = this.#forwardBtn.hidden = s.edit || !(s.canStepBack || s.canStepForth);
		this.#backBtn.disabled = !s.canStepBack;
		this.#forwardBtn.disabled = !s.canStepForth;
		// a locked problem that has an answer saved can show it
		const answer = s.edit ? null : s.solution();
		this.#solutionBtn.hidden = !answer;
		this.#solutionBtn.disabled = !!answer && s.cur === answer;
		// (while editing, under the lock: is this board a problem?)
		this.#problemBtn.hidden = !s.edit;
		this.#problemBtn.classList.toggle('is-active', s.problem);
		this.#problemBtn.setAttribute('aria-pressed', String(s.problem));
		this.#randomBtn.hidden = !s.edit;
		this.#randomBtn.classList.toggle('is-active', s.randomized);
		this.#randomBtn.setAttribute('aria-pressed', String(s.randomized));

		// (an answer that was shown rather than found gets no stamp: the caption says enough)
		this.#renderStamp(!s.edit && s.cur !== s.solutionShown ? m.status : null, s.cur);
		this.#renderCaption(m);
		if (s.edit) this.#renderTools(s, m);
		else if (this.#tools) {
			this.#tools.remove();
			this.#tools = null;
		}
	}

	/**
	 * A line that has just ended says so over the board as well as in the caption.
	 * It is shown once per ending (redrawing the same position does not show it again)
	 * and fades by itself, so the final position can be read.
	 */
	#renderStamp(status: Model['status'], at: object): void {
		if (!status) {
			this.#stamp?.remove();
			this.#stamp = this.#stampAt = null;
			return;
		}
		if (this.#stamp && this.#stampAt === at && this.#stamp.classList.contains(`is-${status}`)) return;
		this.#stamp?.remove();
		this.#stamp = el(this.#frame, 'div', `kifu-stamp is-${status}`);
		this.#stamp.setAttribute('aria-hidden', 'true');
		icon(this.#stamp, status === 'correct' ? 'check' : 'cross');
		this.#stampAt = at;
	}

	#renderCaption(m: Model): void {
		const cap = this.#cap;
		clear(cap);
		const doc = cap.ownerDocument;
		const stone = (parent: HTMLElement, color: number, text = ''): void => {
			el(parent, 'span', `kifu-st ${color === 1 ? 'kifu-st-b' : 'kifu-st-w'}`, text);
		};
		if (m.status) {
			const v = el(cap, 'span', `kifu-verdict is-${m.status}`);
			icon(v, m.status === 'correct' ? 'check' : 'cross');
			// (many files already say it in the comment)
			if (!/^\s*(correct|right|wrong|incorrect|fail)/i.test(m.text)) {
				v.appendChild(doc.createTextNode(m.status === 'correct' ? 'Correct' : 'Incorrect'));
			}
			if (!this.session?.edit) iconButton(cap, 'reset', 'Try again', () => this.session?.reset());
		} else if (m.hint) {
			const h = el(cap, 'span', 'kifu-hint');
			stone(h, m.toPlay);
			h.appendChild(doc.createTextNode(m.hint));
		}
		for (const n of m.notes) {
			const s = el(cap, 'span', 'kifu-note');
			stone(s, n.color, n.label);
			s.appendChild(doc.createTextNode('at '));
			if (n.atColor) stone(s, n.atColor, n.at);
			else s.appendChild(doc.createTextNode(n.at));
		}
		if (m.text) el(cap, 'span', 'kifu-comment', m.text);
		cap.hidden = !cap.firstChild;
	}

	#buildTools(s: Session): void {
		const bar = (this.#tools = el(this.#root, 'div', 'kifu-tools'));
		this.#toolBtns.clear();
		let group = el(bar, 'div', 'kifu-group');
		for (const [tool, ic, title] of TOOLS) {
			if (tool === 'TR' || tool === 'crop') group = el(bar, 'div', 'kifu-group');
			const b = iconButton(group, ic, title, () => {
				if (tool === 'play' && s.tool === 'play') s.togglePlayer();
				else s.setTool(tool);
			});
			this.#toolBtns.set(tool, b);
			if (tool === 'label') {
				const input = (this.#labelInput = el(group, 'input', 'kifu-label'));
				input.type = 'text';
				input.maxLength = 4;
				input.setAttribute('aria-label', 'Next label');
				input.addEventListener('input', () => {
					s.nextLabel = input.value;
				});
				input.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter' || ev.key === 'Escape') this.#root.focus({ preventScroll: true });
				});
			}
		}
		const more: [string, string, string, () => void][] = [
			['figure', 'figure', 'When locked, show the moves as a numbered figure', () => s.setFigure(!s.figure)],
			['start', 'flag', 'Open the board at this position when the note is shown', () => s.toggleStart()],
			['undo', 'undo', 'Undo (redo with Ctrl/Cmd+Shift+Z)', () => s.undo()],
			['prev', 'prev', 'Previous move', () => s.prev()],
			['next', 'next', 'Next move', () => s.next()],
			['correct', 'check', 'Mark this line as correct', () => s.mark('correct')],
			['incorrect', 'cross', 'Mark this line as incorrect', () => s.mark('incorrect')],
			['promote', 'up', 'Move this variation up', () => s.promote()],
			['delete', 'trash', 'Delete this move and what follows', () => s.deleteNode()],
		];
		for (const [id, ic, title, fn] of more) {
			if (id === 'undo' || id === 'prev' || id === 'correct' || id === 'promote') group = el(bar, 'div', 'kifu-group');
			// (the figure and start switches sit with the crop tool: they all decide what the locked board shows)
			this.#toolBtns.set(id, iconButton(group, ic, title, fn));
		}
	}

	#renderTools(s: Session, m: Model): void {
		if (!this.#tools) this.#buildTools(s);
		const btn = (id: string) => this.#toolBtns.get(id) as HTMLButtonElement;
		for (const [tool] of TOOLS) btn(tool).classList.toggle('is-active', s.tool === tool);
		setIcon(btn('play').firstChild as SVGSVGElement, m.toPlay === 1 ? 'playB' : 'playW');
		const input = this.#labelInput;
		if (input) {
			input.hidden = s.tool !== 'label';
			if (input.ownerDocument.activeElement !== input && input.value !== s.nextLabel) input.value = s.nextLabel;
		}
		btn('figure').classList.toggle('is-active', s.figure);
		const isStart = s.hasStart && s.cur === s.home;
		btn('start').classList.toggle('is-active', isStart);
		btn('start').disabled = !isStart && !s.canSetStart;
		const mark = s.ownMark();
		btn('correct').classList.toggle('is-active', mark === 'correct');
		btn('incorrect').classList.toggle('is-active', mark === 'incorrect');
		btn('undo').disabled = !s.canUndo;
		btn('prev').disabled = !s.cur.parent;
		btn('next').disabled = !s.cur.children.length;
		btn('correct').disabled = btn('incorrect').disabled = btn('delete').disabled = !s.cur.parent;
		btn('promote').disabled = !s.canPromote;
	}

	/* ------------------------------------------------------------ interaction */

	#toggleLock(): void {
		// (first: being used can change which session this board shows)
		this.#activate();
		const s = this.session;
		if (s) this.#plugin.toggleLock(s);
	}

	#onKey(ev: KeyboardEvent): void {
		const s = this.session;
		if (!s || !s.ready || (ev.target as Element).closest('input, textarea')) return;
		let handled = true;
		if (ev.ctrlKey || ev.metaKey) {
			// Undo and redo are always ours while the board has the keyboard: left alone,
			// the browser would carry them out on the note's text behind the board's back.
			// Unlocked they undo an edit; locked they step back and forth, like the arrows.
			const key = ev.key.toLowerCase();
			const undo = key === 'z' && !ev.shiftKey;
			const redo = (key === 'z' && ev.shiftKey) || key === 'y';
			if (ev.altKey || !(undo || redo)) handled = false;
			else if (s.edit && undo) s.undo();
			else if (s.edit) s.redo();
			else if (undo) s.stepBack();
			else s.stepForth();
		} else if (ev.altKey) {
			handled = false;
		} else {
			switch (ev.key) {
				case 'ArrowLeft':
					s.prev();
					break;
				case 'ArrowRight':
					s.next();
					break;
				case 'ArrowUp':
					s.sibling(-1);
					break;
				case 'ArrowDown':
					s.sibling(1);
					break;
				case 'Home':
					s.first();
					break;
				case 'End':
					s.last();
					break;
				case 'Escape':
					if (this.#drag) this.#endDrag(); // (a crop that was being dragged out: never mind)
					else if (s.edit) this.#toggleLock();
					else if (s.moved) s.reset();
					else handled = false;
					break;
				default:
					handled = false;
			}
		}
		if (handled) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	}

	#cropping(): boolean {
		const s = this.session;
		return !!s && s.edit && s.tool === 'crop';
	}

	#onClick(ev: MouseEvent): void {
		const s = this.session;
		if (!s || !s.ready || ev.button !== 0 || this.#cropping()) return;
		const p = this.#board.pointAt(ev.clientX, ev.clientY);
		if (p) s.click(...this.#toGame(s, p));
	}

	/** The point of the game under a point of the picture (they differ on a randomized board). */
	#toGame(s: Session, p: [number, number]): [number, number] {
		const o = s.orientation;
		return o ? fromShown(o, p[0], p[1], s.w, s.h) : p;
	}

	#rectTo(p: [number, number]): Rect {
		const d = this.#drag as [number, number];
		return { x0: Math.min(d[0], p[0]), y0: Math.min(d[1], p[1]), x1: Math.max(d[0], p[0]), y1: Math.max(d[1], p[1]) };
	}

	#onDown(ev: PointerEvent): void {
		if (!this.#cropping() || ev.button !== 0) return;
		const p = this.#board.pointAt(ev.clientX, ev.clientY, true);
		if (!p) return;
		this.#drag = p;
		this.#board.el.setPointerCapture(ev.pointerId);
		this.#board.setSelection(this.#rectTo(p));
	}

	#onMove(ev: PointerEvent): void {
		const s = this.session;
		if (!s || !s.ready) return;
		if (this.#drag) {
			const p = this.#board.pointAt(ev.clientX, ev.clientY, true);
			if (p) this.#board.setSelection(this.#rectTo(p));
			return;
		}
		if (ev.pointerType !== 'mouse') return;
		const p = this.#board.pointAt(ev.clientX, ev.clientY);
		const key = p ? `${p[0]},${p[1]}` : '';
		if (key === this.#hover) return;
		this.#hover = key;
		let color = 0;
		if (p) {
			const [x, y] = this.#toGame(s, p);
			if (!s.edit || s.tool === 'play') color = s.canPlay(x, y) ? shownColor(s.orientation, s.toPlay()) : 0;
			else if (s.tool === 'black' || s.tool === 'white') {
				color = s.position().board.g[p[1] * s.w + p[0]] ? 0 : s.tool === 'black' ? 1 : 2;
			}
		}
		this.#board.setGhost(p ? p[0] : -1, p ? p[1] : -1, color);
	}

	#onUp(ev: PointerEvent): void {
		const s = this.session;
		if (!this.#drag || !s) return;
		// (the board may have been locked, or the tool changed, while the mouse was down)
		const still = this.#cropping();
		const p = still ? this.#board.pointAt(ev.clientX, ev.clientY, true) : null;
		const rect = p ? this.#rectTo(p) : null;
		this.#endDrag();
		// a plain click is not a selection
		if (rect && (rect.x1 > rect.x0 || rect.y1 > rect.y0)) {
			s.setCrop(rect);
			this.#lastTap = 0;
			return;
		}
		// Touch screens (iPad Safari among them) do not reliably report a double tap
		// as a double click, so two quick taps are spotted here.
		if (!still || ev.pointerType === 'mouse') return;
		const now = Date.now();
		if (now - this.#lastTap < 400) {
			this.#lastTap = 0;
			this.#tapReset = now;
			s.setCrop(null);
		} else {
			this.#lastTap = now;
		}
	}

	#endDrag(): void {
		this.#drag = null;
		this.#board.setSelection(null);
	}
}
