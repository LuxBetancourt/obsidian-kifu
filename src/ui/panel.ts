/** The sidebar panel: the move tree of the board in use, and the comment on the current move. */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type KifuPlugin from '../main';
import { VIEW_TYPE } from '../config';
import { pointName } from '../options';
import { shownColor, shownSize, swapWords, toShown } from '../orient';
import type { Session } from '../session';
import { nodeMark } from '../session';
import { SgfNode, getMove, getText, pathTo } from '../sgf';
import { STRIDE, TreeLayout, layoutLine, layoutTree } from '../tree';
import { clear, el, icon, iconButton, setIcon, svg } from './dom';

/** Size of one tree cell, and of the stones in it. */
const CELL = 26;
const RAD = 9;
const PAD = 6;
/** Beyond this many moves the numbers are left out to keep drawing instant. */
const MAX_LABELS = 3000;

const dot = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

// Members are #private: see the note in boardview.ts.
export class TreePanel extends ItemView {
	#plugin: KifuPlugin;
	#session: Session | null = null;
	#empty!: HTMLElement;
	#main!: HTMLElement;
	#pos!: HTMLElement;
	#game!: HTMLElement;
	#treeBox!: HTMLElement;
	#treeSvg!: SVGSVGElement;
	#ring!: SVGCircleElement;
	#info!: HTMLElement;
	#text!: HTMLElement;
	#comment!: HTMLTextAreaElement;
	#btn: Record<string, HTMLButtonElement> = {};
	#layout: TreeLayout | null = null;
	#layoutKey = '';
	#commentNode: SgfNode | null = null;
	#onChange = (): void => this.#update();

	constructor(leaf: WorkspaceLeaf, plugin: KifuPlugin) {
		super(leaf);
		this.#plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Move tree';
	}

	getIcon(): string {
		return 'kifu-tree';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		clear(root);
		root.classList.add('kifu-panel');
		this.#empty = el(root, 'div', 'kifu-p-empty', 'Click a board in a note to see its moves here.');
		const main = (this.#main = el(root, 'div', 'kifu-p-main'));
		main.tabIndex = 0;

		const nav = el(main, 'div', 'kifu-p-nav');
		const act = (fn: (s: Session) => void) => () => {
			if (this.#session) fn(this.#session);
		};
		this.#btn.first = iconButton(nav, 'first', 'First position', act((s) => s.first()));
		this.#btn.prev = iconButton(nav, 'prev', 'Previous move', act((s) => s.prev()));
		this.#pos = el(nav, 'span', 'kifu-p-pos');
		this.#btn.next = iconButton(nav, 'next', 'Next move', act((s) => s.next()));
		this.#btn.last = iconButton(nav, 'last', 'End of this line', act((s) => s.last()));
		el(nav, 'span', 'kifu-p-gap');
		this.#btn.reveal = iconButton(nav, 'eye', 'Show the saved lines', act((s) => s.setReveal(!s.reveal)));
		this.#btn.reset = iconButton(nav, 'reset', 'Back to the starting position', act((s) => s.reset()));
		this.#btn.lock = iconButton(nav, 'lock', 'Unlock to edit', act((s) => this.#plugin.toggleLock(s)));

		this.#game = el(main, 'div', 'kifu-p-game');
		this.#treeBox = el(main, 'div', 'kifu-p-tree');
		this.#treeSvg = svg(this.#treeBox, 'svg', { class: 'kifu-t' });
		this.#treeSvg.addEventListener('click', (ev) => this.#onTreeClick(ev));

		const foot = el(main, 'div', 'kifu-p-foot');
		this.#info = el(foot, 'div', 'kifu-p-info');
		this.#text = el(foot, 'div', 'kifu-p-text');
		this.#comment = el(foot, 'textarea', 'kifu-p-comment');
		this.#comment.placeholder = 'Comment on this position…';
		this.#comment.addEventListener('input', () => this.#session?.setComment(this.#comment.value));

		main.addEventListener('keydown', (ev) => this.#onKey(ev));
		this.setSession(this.#plugin.activeSession);
	}

	async onClose(): Promise<void> {
		this.setSession(null);
	}

	setSession(s: Session | null): void {
		if (s !== this.#session) {
			this.#session?.off(this.#onChange);
			this.#session = s;
			s?.on(this.#onChange);
			this.#layoutKey = '';
			this.#commentNode = null;
		}
		if (this.#main) this.#update();
	}

	#onKey(ev: KeyboardEvent): void {
		const s = this.#session;
		// (in the comment box every key is the text's own, undo included)
		if (!s || ev.target === this.#comment || ev.altKey) return;
		if (ev.ctrlKey || ev.metaKey) {
			// Undo and redo: the board's while it is unlocked, a step back or forth otherwise.
			// Either way they are taken here, or the browser would undo something in the note.
			const key = ev.key.toLowerCase();
			const undo = key === 'z' && !ev.shiftKey;
			const redo = (key === 'z' && ev.shiftKey) || key === 'y';
			if (!undo && !redo) return;
			if (s.edit && undo) s.undo();
			else if (s.edit) s.redo();
			else if (undo) s.stepBack();
			else s.stepForth();
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
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
				if (s.edit) this.#plugin.toggleLock(s);
				else if (s.moved) s.reset();
				else return;
				break;
			default:
				return;
		}
		ev.preventDefault();
		ev.stopPropagation();
	}

	#onTreeClick(ev: MouseEvent): void {
		const s = this.#session;
		if (!s || !this.#layout) return;
		const box = this.#treeSvg.getBoundingClientRect();
		const col = Math.floor((ev.clientX - box.left - PAD) / CELL);
		const row = Math.floor((ev.clientY - box.top - PAD) / CELL);
		const node = this.#layout.cells.get(row * STRIDE + col);
		if (node) s.goto(node);
		this.#main.focus({ preventScroll: true });
	}

	/* ----------------------------------------------------------------- render */

	#update(): void {
		const s = this.#session;
		const usable = !!s && s.ready && !s.error;
		this.#empty.hidden = usable;
		this.#main.hidden = !usable;
		if (!s || !usable) return;

		const pos = s.position();
		this.#pos.textContent = pos.moveNo ? `Move ${pos.moveNo}` : 'Start';
		this.#btn.first.disabled = this.#btn.prev.disabled = !s.cur.parent;
		this.#btn.next.disabled = this.#btn.last.disabled = !s.cur.children.length;
		this.#btn.reset.disabled = s.edit || !s.moved;
		// (only a problem that is being solved has anything to keep out of sight)
		const secretive = this.#plugin.settings.hideAnswers && !s.edit && s.problem;
		this.#btn.reveal.hidden = !secretive;
		this.#btn.reveal.classList.toggle('is-active', secretive && s.reveal);
		this.#btn.reveal.setAttribute('aria-label', s.reveal ? 'Hide the saved lines again' : 'Show the saved lines');
		setIcon(this.#btn.lock.firstChild as SVGSVGElement, s.edit ? 'unlock' : 'lock');
		this.#btn.lock.setAttribute('aria-label', s.edit ? 'Lock (stop editing)' : 'Unlock to edit');
		this.#btn.lock.classList.toggle('is-active', s.edit);

		const p = s.root.props;
		const who = (name: string, rank: string) => {
			const n = getText(s.root, name);
			const r = getText(s.root, rank);
			return n ? n + (r ? ` (${r})` : '') : '';
		};
		const players = [who('PB', 'BR'), who('PW', 'WR')].filter(Boolean).join(' – ');
		const title = [getText(s.root, 'GN'), players, p.RE ? getText(s.root, 'RE') : ''].filter(Boolean).join(' · ');
		this.#game.textContent = title;
		this.#game.hidden = !title;

		this.#drawTree(s);
		this.#drawInfo(s);
	}

	#drawTree(s: Session): void {
		// While a problem is being solved only the line that is on the board is drawn.
		const concealed = s.concealed;
		// (a randomized board shows its stones recoloured while locked, as recorded while editing)
		const o = s.orientation;
		const key = (concealed ? `line ${s.rev}` : `${s.treeRev}`) + (o?.swap ? ' swapped' : '');
		const x = (col: number) => PAD + col * CELL + CELL / 2;
		const y = (row: number) => PAD + row * CELL + CELL / 2;
		if (key !== this.#layoutKey || !this.#layout || !this.#layout.at.has(s.root)) {
			this.#layoutKey = key;
			const L = (this.#layout = concealed ? layoutLine(pathTo(s.cur)) : layoutTree(s.root));
			const g = this.#treeSvg;
			clear(g);
			const width = PAD * 2 + L.cols * CELL;
			const height = PAD * 2 + L.rows * CELL;
			g.setAttribute('width', String(width));
			g.setAttribute('height', String(height));
			g.setAttribute('viewBox', `0 0 ${width} ${height}`);
			let edges = '';
			let black = '';
			let white = '';
			let tblack = '';
			let twhite = '';
			let other = '';
			let notes = '';
			const labels = L.count <= MAX_LABELS;
			const texts = svg(g, 'g'); // moved to the end below
			const badges = svg(g, 'g');
			// walk the tree, counting moves as we go
			const stack: [SgfNode, number][] = [[s.root, 0]];
			while (stack.length) {
				const [n, before] = stack.pop() as [SgfNode, number];
				const at = L.at.get(n) as number;
				const col = at % STRIDE;
				const row = Math.floor(at / STRIDE);
				const cx = x(col);
				const cy = y(row);
				if (n.parent) {
					const pa = L.at.get(n.parent) as number;
					const pc = pa % STRIDE;
					const pr = Math.floor(pa / STRIDE);
					edges += `M${x(pc)} ${y(pr)}`;
					if (col === pc) edges += `V${cy}`;
					else edges += (col - 1 > pc ? `H${x(col - 1)}` : '') + `L${cx} ${cy}`;
				}
				const m = getMove(n, s.w, s.h);
				let no = before;
				if (m) {
					const mn = parseInt(n.props.MN?.[0] ?? '');
					no = mn > 0 ? mn : before + 1;
					const d = dot(cx, cy, RAD);
					const shown = shownColor(o, m.color);
					if (shown === 1) {
						if (n.temp) tblack += d;
						else black += d;
					} else if (n.temp) twhite += d;
					else white += d;
					if (labels) {
						const t = svg(texts, 'text', {
							x: cx,
							y: cy + (no > 99 ? 3 : 3.6),
							class: `kifu-t-num ${shown === 1 ? 'kifu-t-on-b' : 'kifu-t-on-w'}${no > 99 ? ' is-small' : ''}`,
						});
						t.textContent = m.pass ? '–' : String(no);
					}
				} else {
					other += `M${cx} ${cy - 6}l6 6l-6 6l-6-6z`;
				}
				if (!n.temp) {
					const mk = concealed ? null : (nodeMark(n) ?? s.verdict(n));
					if (mk) {
						const bx = cx + RAD - 1;
						const by = cy - RAD + 1;
						svg(badges, 'path', {
							d: mk === 'correct' ? `M${bx - 3.5} ${by}l2.5 2.5l4.5-5` : `M${bx - 3} ${by - 3}l6 6M${bx + 3} ${by - 3}l-6 6`,
							class: `kifu-t-badge is-${mk}`,
						});
					}
					if (n.props.C && n.props.C[0]) notes += dot(cx + RAD + 1.5, cy + RAD - 2.5, 1.8);
				}
				for (let i = n.children.length - 1; i >= 0; i--) {
					if (L.at.has(n.children[i])) stack.push([n.children[i], no]);
				}
			}
			const add = (d: string, cls: string) => {
				if (d) svg(g, 'path', { d, class: cls });
			};
			g.insertBefore(svg(g, 'path', { d: edges, class: 'kifu-t-edge' }), g.firstChild);
			add(other, 'kifu-t-other');
			add(black, 'kifu-t-b');
			add(white, 'kifu-t-w');
			add(tblack, 'kifu-t-b is-temp');
			add(twhite, 'kifu-t-w is-temp');
			add(notes, 'kifu-t-note');
			g.appendChild(texts);
			g.appendChild(badges);
			this.#ring = svg(g, 'circle', { class: 'kifu-t-cur', r: RAD + 3 });
		}
		const at = this.#layout.at.get(s.cur);
		if (at === undefined) return;
		const cx = x(at % STRIDE);
		const cy = y(Math.floor(at / STRIDE));
		this.#ring.setAttribute('cx', String(cx));
		this.#ring.setAttribute('cy', String(cy));
		// keep the current move in sight
		const box = this.#treeBox;
		const m = CELL * 1.5;
		if (cy - m < box.scrollTop) box.scrollTop = Math.max(0, cy - m);
		else if (cy + m > box.scrollTop + box.clientHeight) box.scrollTop = cy + m - box.clientHeight;
		if (cx - m < box.scrollLeft) box.scrollLeft = Math.max(0, cx - m);
		else if (cx + m > box.scrollLeft + box.clientWidth) box.scrollLeft = cx + m - box.clientWidth;
	}

	#drawInfo(s: Session): void {
		const info = this.#info;
		clear(info);
		const n = s.cur;
		const m = getMove(n, s.w, s.h);
		// (on a randomized board: the colour and the point as the board shows them)
		const o = s.orientation;
		if (m) {
			const color = shownColor(o, m.color);
			el(info, 'span', `kifu-st ${color === 1 ? 'kifu-st-b' : 'kifu-st-w'}`);
			let where = 'pass';
			if (!m.pass) {
				const [x, y] = o ? toShown(o, m.x, m.y, s.w, s.h) : [m.x, m.y];
				where = pointName(x, y, o ? shownSize(o, s.w, s.h)[1] : s.h);
			}
			el(info, 'span', 'kifu-p-move', `${color === 1 ? 'Black' : 'White'} ${s.position().moveNo} · ${where}`);
		} else {
			el(info, 'span', 'kifu-p-move', n.parent ? 'Position' : 'Start');
		}
		if (n.temp) el(info, 'span', 'kifu-p-temp', 'not saved');
		const verdict = s.status() ?? (n.temp || s.concealed ? null : nodeMark(n));
		if (verdict) {
			const v = el(info, 'span', `kifu-verdict is-${verdict}`);
			icon(v, verdict === 'correct' ? 'check' : 'cross');
			v.appendChild(info.ownerDocument.createTextNode(verdict === 'correct' ? 'Correct' : 'Incorrect'));
		}

		const text = getText(n, 'C');
		const editing = s.edit && !n.temp;
		this.#comment.hidden = !editing;
		this.#text.hidden = editing || !text;
		if (editing) {
			const active = this.#comment.ownerDocument.activeElement === this.#comment;
			if (this.#commentNode !== n || (!active && this.#comment.value !== text)) this.#comment.value = text;
			this.#commentNode = n;
		} else {
			this.#text.textContent = swapWords(o, text);
			this.#commentNode = null;
		}
	}
}
