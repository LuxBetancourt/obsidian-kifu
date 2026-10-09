/** Tiny DOM helpers and the handful of line icons the plugin draws itself. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
	parent: Node,
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = (parent.ownerDocument as Document).createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	parent.appendChild(e);
	return e;
}

export function svg<K extends keyof SVGElementTagNameMap>(
	parent: Node,
	tag: K,
	attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
	const e = (parent.ownerDocument as Document).createElementNS(SVG_NS, tag);
	if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
	parent.appendChild(e);
	return e;
}

export function clear(node: Node): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

const CIRCLE = 'M12 3.75a8.25 8.25 0 1 0 0 16.5a8.25 8.25 0 1 0 0-16.5z';
const ONE = 'M10.2 9.4l2.3-1.7v8.8';

/**
 * Icons on a 24 x 24 grid. Paths are separated by "|". A path is a line in the
 * button's text colour unless it starts with one of these:
 *   "*" filled in the text colour     "B" a black stone     "W" a white stone
 *   "b" a line drawn on a black stone  "w" a line drawn on a white stone
 */
const ICONS: Record<string, string> = {
	lock: 'M7 11h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 17 20H7a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 7 11z|M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
	unlock: 'M7 11h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 17 20H7a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 7 11z|M8.5 11V7.5a3.5 3.5 0 0 1 6.7-1.4',
	reset: 'M4.5 12a7.5 7.5 0 1 0 7.5-7.5a7.5 7.5 0 0 0-5.3 2.2L4.5 9|M4.5 4.8V9h4.2',
	first: 'M17 6l-6 6l6 6|M7.5 6v12',
	prev: 'M14.5 6l-6 6l6 6',
	next: 'M9.5 6l6 6l-6 6',
	last: 'M7 6l6 6l-6 6|M16.5 6v12',
	check: 'M5 12.5l4.5 4.5L19 7.5',
	cross: 'M6.5 6.5l11 11|M17.5 6.5l-11 11',
	trash: 'M4.5 7h15|M9.5 7V4.5h5V7|M6.5 7l.8 12.5h9.4L17.5 7|M10 10.5v6|M14 10.5v6',
	up: 'M12 19V5.5|M6 11.5l6-6l6 6',
	undo: 'M8.5 6.5L4 11l4.5 4.5|M4 11h9.5a4.75 4.75 0 0 1 0 9.5H11',
	erase: 'M8.5 19.5l-4.2-4.2a1.5 1.5 0 0 1 0-2.1l8.5-8.5a1.5 1.5 0 0 1 2.1 0l4.8 4.8a1.5 1.5 0 0 1 0 2.1L11.8 19.5z|M9.2 8.7l6.1 6.1|M8.5 19.5h11',
	crop: 'M6.5 2.5v15h15|M2.5 6.5h15v15',
	TR: 'M12 5l7.8 13.5H4.2z',
	SQ: 'M5.5 5.5h13v13h-13z',
	CR: 'M12 4.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z',
	MA: 'M6 6l12 12|M18 6L6 18',
	label: 'M6.5 19L12 5l5.5 14|M8.7 13.5h6.6',
	problem: 'M12 4.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z|M9.7 9.9a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.4v.5|M12 16.3v.2',
	flag: 'M6.5 20.5v-17|M6.5 4.5h11l-2.5 4l2.5 4h-11',
	figure: 'M9.75 4.5l-2 15|M16.25 4.5l-2 15|M4.75 9.25h15|M4.25 14.75h15',
	eye: 'M2.75 12c2.3-4.2 5.4-6.3 9.25-6.3s6.95 2.1 9.25 6.3c-2.3 4.2-5.4 6.3-9.25 6.3S5.05 16.2 2.75 12z|M12 9.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6z',
	black: 'B' + CIRCLE,
	white: 'W' + CIRCLE,
	playB: 'B' + CIRCLE + '|b' + ONE,
	playW: 'W' + CIRCLE + '|w' + ONE,
};

const PART_CLASS: Record<string, string> = {
	'*': 'kifu-ic-fill',
	B: 'kifu-ic-black',
	W: 'kifu-ic-white',
	b: 'kifu-ic-on-black',
	w: 'kifu-ic-on-white',
};

export function icon(parent: Node, name: string): SVGSVGElement {
	const s = svg(parent, 'svg', { viewBox: '0 0 24 24', class: 'kifu-ic', 'aria-hidden': 'true' });
	setIcon(s, name);
	return s;
}

export function setIcon(s: SVGSVGElement, name: string): void {
	if (s.dataset.icon === name) return;
	s.dataset.icon = name;
	clear(s);
	for (const part of (ICONS[name] ?? '').split('|')) {
		const cls = PART_CLASS[part[0]];
		if (cls) svg(s, 'path', { d: part.slice(1), class: cls });
		else svg(s, 'path', { d: part });
	}
}

/** A small round button showing one icon. */
export function iconButton(parent: Node, name: string, title: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement {
	const b = el(parent, 'button', 'kifu-btn');
	b.type = 'button';
	b.setAttribute('aria-label', title);
	icon(b, name);
	b.addEventListener('click', (ev) => {
		ev.preventDefault();
		onClick(ev);
	});
	// keep focus (and the editor's cursor) where it is
	b.addEventListener('mousedown', (ev) => ev.preventDefault());
	return b;
}

/** Tab icon for the move tree panel (addIcon wants a 100 x 100 drawing). */
export const TREE_ICON =
	'<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round">' +
	'<path d="M30 30v40M30 50l40 20"/><circle cx="30" cy="20" r="11" fill="currentColor"/>' +
	'<circle cx="30" cy="82" r="11"/><circle cx="72" cy="78" r="11"/></g>';
