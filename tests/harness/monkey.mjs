// A randomized check of the code that writes boards back into notes.
//
// A "monkey" unlocks boards, places stones, marks and labels with every tool (and takes
// some off again, so that blocks come to read the same once more), plays moves on locked
// boards, types comments in the panel, locks, presses keys and scrolls. Depending on the
// profile it also edits the note by hand at the same time: lines typed above, captions
// typed into blocks, a space added to one, blocks deleted, copied, or cut and pasted at
// the end of the note, the editor's undo, the file changed by another program. The
// notes are full of boards that read exactly the same, because telling those apart is
// where a wrong block would get written.
//
// Whatever the interleaving:
//   - nothing is ever in a block other than the one whose board it was put on (checked after every step)
//   - nothing outside the blocks changes, and no block that nobody touched
//   - at the end, every board on the page shows what its block says
//   - no edit goes missing without a notice
//   - none goes missing at all from a block that nobody changed by hand, whatever was
//     done to the rest of the note (one pane, nothing undone). The one excuse: the note
//     was rearranged in several places at once while the edit was waiting, with no
//     editor to say what happened step by step
//   - a change made by hand is not taken back by a board
//   - no board is unlocked that was not unlocked by hand
//   - no errors on the page
//
//   node tests/harness/monkey.mjs [arrangements|all] [profiles|all] [seeds: 1-6 or 3,5] [steps] [jobs]
//
// Arrangements: live scroll two reading source both lag blind lagblind soloblind.
// Profiles: plain hands wild. The note changes with the seed (default, twins, empty,
// callout, crlf in turn); NOTE=twins in the environment picks one.
import { chromium, open, sleep, notices, out } from './lib.mjs';

const ARRANGEMENTS = {
	/** One Live Preview editor (real CodeMirror). */
	live: { editors: 1 },
	/** The same in a long note, so that boards are taken off the page and put back while scrolling. */
	scroll: { editors: 1, tall: true },
	/** Two editors on the note. */
	two: { editors: 2 },
	/** A reading view and nothing else: changes go straight to the file. */
	reading: { panes: ['preview'] },
	/** The mock's own plain editor, whose renderer keeps drawings by their text. */
	source: { panes: ['source'] },
	/** An editor with a reading view beside it. */
	both: { editors: 1, reading: true },
	/** ...a reading view that only follows once the file has been written. */
	lag: { editors: 1, reading: true, lag: true },
	/** ...a reading view whose boards are not told which lines they stand on. */
	blind: { editors: 1, reading: true, blind: true },
	/** ...both: what an embedded note is likely to be. */
	lagblind: { editors: 1, reading: true, lag: true, blind: true },
	/** A reading view alone that is told nothing about lines. */
	soloblind: { panes: ['preview'], blindAll: true },
};
/** What the monkey does besides using the boards. */
const PROFILES = {
	/** Only types lines above the boards. */
	plain: {},
	/** Also types captions into blocks, deletes blocks and moves them to the end of the note, undoes in the editor and on boards, changes the file from outside. */
	hands: { hands: true },
	/** All that with copies of blocks pasted in as well, and a renderer that moves drawings between blocks that read the same. */
	wild: { hands: true, copies: true },
};

const pickList = (arg, all) => (!arg || arg === 'all' ? Object.keys(all) : arg.split(','));
const args = process.argv.slice(2);
const arrangements = pickList(args[0], ARRANGEMENTS);
const profiles = pickList(args[1], PROFILES);
const seeds = (args[2] ?? '1-3').split(',').flatMap((p) => {
	const m = /^(\d+)-(\d+)$/.exec(p);
	return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(p)];
});
const STEPS = Number(args[3] ?? 40);
const JOBS = Number(args[4] ?? 2);

/** How often a stone or mark that was just placed is taken off again. */
const BACK = 0.3;
const X = '(;SZ[9]AB[cc])';
const GAME = 'caption: a game\n(;SZ[9];B[ee];W[eg])';
/** The notes: for each block [body, prefix of every line, lines before, lines after]. */
const VARIANTS = {
	/** two that read the same, two that differ in a space, a game */
	default: [[X], [X], ['size: 9'], ['size:  9'], [GAME]],
	/** five that read the same */
	twins: [[X], [X], [X], [X], [X], [GAME]],
	/** empty blocks, the way new boards start out */
	empty: [[null], [null], [null], ['size: 9'], ['size: 9']],
	/** blocks in callouts and a list item */
	callout: [[X], [X, '> ', ['> [!note] A callout'], ['> closing words']], [X, '  ', ['- item']], ['size: 9', '>'], ['size: 9'], [GAME, '> ']],
	/** a note with CR LF line ends */
	crlf: [[X], [X], ['size: 9'], ['size:  9'], [GAME]],
};
const NOTES = Object.keys(VARIANTS);
if (process.env.NOTE && !VARIANTS[process.env.NOTE]) throw new Error('unknown NOTE ' + process.env.NOTE);
const fence = ([body, prefix = '', before = [], after = []]) =>
	[...before, prefix + '```kifu', ...(body === null || body === undefined ? [] : body.split('\n').map((l) => prefix + l)), prefix + '```', ...after].join('\n');
const filler = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the text between two boards.`).join('\n\n');

/** The blocks of a note, as [first line, last line, body]. (The monkey never writes anything that looks like a fence.) */
function blocksOf(text) {
	const lines = text.split('\n');
	const found = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^((?:>[ \t]?|[ \t]+)*)```kifu\s*$/.exec(lines[i]);
		if (!m) continue;
		const prefix = m[1];
		const bare = prefix.replace(/\s+$/, '');
		const strip = (l) => {
			l = l.replace(/\r$/, '');
			return l.startsWith(prefix) ? l.slice(prefix.length) : l.startsWith(bare) ? l.slice(bare.length) : l;
		};
		let j = i + 1;
		while (j < lines.length && !/^```\s*$/.test(strip(lines[j]))) j++;
		if (j >= lines.length) break;
		found.push({ open: i, close: j, prefix, body: lines.slice(i + 1, j).map(strip).join('\n') });
		i = j;
	}
	return found;
}
/** A note as what is outside its blocks (one piece more than there are blocks) and the blocks' bodies. */
function split(text) {
	const lines = text.split('\n');
	const outs = [];
	let from = 0;
	const blocks = blocksOf(text);
	for (const b of blocks) {
		outs.push((outs.length ? '\n' : '') + lines.slice(from, b.open).join('\n') + (b.open > from ? '\n' : ''));
		from = b.close + 1;
	}
	outs.push((blocks.length ? '\n' : '') + lines.slice(from).join('\n'));
	return { outs, bodies: blocks.map((b) => b.body) };
}
const coordsOf = (body) => [...body.matchAll(/\[([a-i]{2})(?::[^\]]*)?\]/g)].map((m) => m[1]);
const tokensOf = (body) => body.match(/q\d+q/g) ?? [];
const squash = (s) => s.replace(/\s+/g, '');

/** Everything the page-side of the monkey needs: looking things up by the harness's own means, never the plugin's. */
function install() {
	const H = window.harness;
	const OPEN = /^((?:>[ \t]?|[ \t]+)*)```kifu\s*$/;
	const blocksOf = (text) => {
		const lines = text.split('\n');
		const found = [];
		for (let i = 0; i < lines.length; i++) {
			const m = OPEN.exec(lines[i]);
			if (!m) continue;
			const prefix = m[1];
			const bare = prefix.replace(/\s+$/, '');
			const strip = (l) => {
				l = l.replace(/\r$/, '');
				return l.startsWith(prefix) ? l.slice(prefix.length) : l.startsWith(bare) ? l.slice(bare.length) : l;
			};
			let j = i + 1;
			while (j < lines.length && !/^```\s*$/.test(strip(lines[j]))) j++;
			if (j >= lines.length) break;
			found.push({ open: i, close: j, prefix, body: lines.slice(i + 1, j).map(strip).join('\n') });
			i = j;
		}
		return found;
	};
	window.M = {
		blocksOf,
		boards: () => [...document.querySelectorAll('.kifu')],
		pane: (el) => H.views.find((v) => v.containerEl.contains(el)) ?? null,
		textOf: (v) => (v.cm ? v.cm.state.doc.toString() : v.renderer.text),
		/** Which block of its note (counting from 0) a board stands on, as its pane has it. */
		ordinal(el) {
			if (!el || !el.isConnected) return -1;
			const v = this.pane(el);
			if (!v) return -1;
			let line;
			if (v.cm) {
				try {
					line = v.cm.state.doc.lineAt(v.cm.posAtDOM(el)).number - 1;
				} catch {
					return -1;
				}
			} else {
				const r = v.renderer.rendered.find((x) => x.el.contains(el));
				if (!r) return -1;
				// (a section may begin before its block: a callout's title line)
				line = r.sec.lineEnd;
			}
			return this.textOf(v).split('\n').slice(0, line + 1).filter((l) => OPEN.test(l)).length - 1;
		},
		/** The plugin's own object behind a board (to ask what it would write). */
		view(el) {
			const block = el.parentElement;
			const w = el.closest('.cm-preview-code-block');
			if (w && w._owner) return w._owner._children.find((c) => c.containerEl === block) ?? null;
			for (const v of H.views) {
				if (!v.renderer) continue;
				for (const r of v.renderer.rendered) for (const c of r.children) if (c.containerEl === block) return c;
			}
			return null;
		},
		state(i) {
			const el = this.boards()[i];
			if (!el) return null;
			const frame = el.querySelector('.kifu-frame');
			return { ord: this.ordinal(el), editing: el.classList.contains('is-editing'), shown: !!frame && !frame.hidden };
		},
		/** Where on screen a point of the ith board is (and whether the board is still what it was). */
		aim(i, pt) {
			const el = this.boards()[i];
			const svg = el?.querySelector('.kifu-svg');
			if (!svg) return null;
			const [vx, vy, vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number);
			const box = svg.getBoundingClientRect();
			const x = pt.charCodeAt(0) - 97;
			const y = pt.charCodeAt(1) - 97;
			// (a board may show only part of itself: a point outside that part is not there to click)
			const inside = x * 100 + 50 > vx && x * 100 + 50 < vx + vw && y * 100 + 50 > vy && y * 100 + 50 < vy + vh;
			const px = box.left + ((x * 100 + 50 - vx) / vw) * box.width;
			const py = box.top + ((y * 100 + 50 - vy) / vh) * box.height;
			return {
				x: px,
				y: py,
				ord: inside && document.elementFromPoint(px, py)?.closest('.kifu') === el ? this.ordinal(el) : -1,
				editing: el.classList.contains('is-editing'),
			};
		},
		/** Change the note's text by hand: through the first pane's editor, or (outside) straight in the file. */
		async edit(kind, k, tag, outside) {
			const v = H.views[0];
			const text = v.data;
			const lines = text.split('\n');
			const b = blocksOf(text)[k];
			let from;
			let to;
			let insert;
			const before = v.history ? v.history.length : 0;
			if (kind === 'line') [from, to, insert] = [0, 0, 'typed line\n'];
			else if (kind === 'tail') [from, to, insert] = [lines.length - 1, lines.length - 1, 'line from outside\n'];
			else if (!b) return null;
			else if (kind === 'move') {
				// the block is cut out and pasted at the very end of the note: by another program
				// in one piece, in the editor as a cut and a paste with nothing in between
				const pasted = 'moved here\n\n```kifu\n' + (b.body ? b.body + '\n' : '') + '```\n';
				if (outside) {
					await H.app.vault.modify(v.file, [...lines.slice(0, b.open), ...lines.slice(b.close + 1)].join('\n') + pasted);
					for (const w of H.views) if (w.history) w.history.length = 0;
				} else {
					v.editor.replaceRange('', { line: b.open, ch: 0 }, { line: b.close + 1, ch: 0 });
					v.editor.replaceRange(pasted, { line: v.editor.lineCount() - 1, ch: 0 });
				}
				return { body: b.body, tag, before, after: v.history ? v.history.length : 0 };
			}
			else if (kind === 'caption') [from, to, insert] = [b.open + 1, b.open + 1, `${b.prefix}caption: ${tag}\n`];
			else if (kind === 'space') {
				// one more space after the colon of a caption that was typed by hand earlier: a change in white space only
				const at = lines.findIndex((l, i) => i > b.open && i < b.close && /caption: h\d+\r?$/.test(l));
				if (at < 0) return null;
				tag = /h\d+/.exec(lines[at])[0];
				[from, to, insert] = [at, at + 1, lines[at].replace('caption: h', 'caption:  h') + '\n'];
			} else if (kind === 'delete') [from, to, insert] = [b.open, b.close + 1, ''];
			else if (kind === 'copy') [from, to, insert] = [b.close + 1, b.close + 1, '\ncopied below\n\n```kifu\n' + b.body + '\n```\n'];
			else throw new Error('unknown edit ' + kind);
			if (outside) {
				const next = [...lines.slice(0, from), ...(insert ? insert.slice(0, -1).split('\n') : []), ...lines.slice(to)].join('\n');
				await H.app.vault.modify(v.file, next);
				// (the stand-in's undo history is made of positions in the old text)
				for (const w of H.views) if (w.history) w.history.length = 0;
			} else {
				v.editor.replaceRange(insert, { line: from, ch: 0 }, { line: to, ch: 0 });
			}
			return { body: b?.body ?? '', tag, before, after: v.history ? v.history.length : 0 };
		},
		/** Is any board that stands on this block unlocked? */
		unlocked(ord) {
			return this.boards().some((el) => this.ordinal(el) === ord && el.classList.contains('is-editing'));
		},
		/** Undo in the first pane's editor; says how long its history was. */
		undo() {
			const v = H.views[0];
			const before = v.history.length;
			v.cm.focus();
			v.undo();
			return before;
		},
		/** For every board on the page: what it would write, and what its block says. */
		audit() {
			return this.boards().map((el, i) => {
				const pane = this.pane(el);
				const ord = this.ordinal(el);
				const view = this.view(el);
				const s = view?.session ?? null;
				const block = pane && ord >= 0 ? blocksOf(this.textOf(pane))[ord] : null;
				return {
					i,
					ord,
					editing: el.classList.contains('is-editing'),
					shows: s && s.ready && !s.error ? s.blockBody() : null,
					dirty: !!s && (s.dirtyTree || s.dirtyHeader || s.saving),
					reads: block ? block.body : null,
				};
			});
		},
	};
}

async function run(browser, arrangement, profile, seed) {
	const A = ARRANGEMENTS[arrangement];
	const P = PROFILES[profile];
	const VARIANT = process.env.NOTE ?? NOTES[(seed - 1) % NOTES.length];
	const SPEC = VARIANTS[VARIANT];
	const BODIES = SPEC.map((b) => b[0] ?? '');
	/** Every third run with an editor: the file is also changed from outside while the editor has it open. */
	const OUTSIDE = !!A.editors && seed % 3 === 0;
	let state = seed * 7919 + 13 + arrangement.length * 104729 + profile.length * 1299709;
	const rnd = () => (state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
	const ri = (n) => Math.floor(rnd() * n);
	const one = (list) => list[ri(list.length)];

	const gap = A.tall ? '\n\n' + filler(25) + '\n\n' : '\n\nbetween\n\n';
	const LF = '# Monkey\n\nintro\n\n' + SPEC.map(fence).join(gap) + '\n\nend\n';
	const NOTE = VARIANT === 'crlf' ? LF.replace(/\n/g, '\r\n') : LF;
	// (CodeMirror reads CR LF as line ends and gives LF back: there the pane holds the note with LF from the start)
	const START = A.editors ? LF : NOTE;
	const panes = (A.editors ?? 0) + (A.reading ? 1 : 0) + (A.panes?.length ?? 0);
	const { page, errors } = await open(browser, {
		files: { 'M.md': NOTE },
		width: panes > 1 ? 1700 : 1100,
		height: A.tall ? 900 : 2600,
		live: Array.from({ length: A.editors ?? 0 }, () => 'M.md'),
		panes: (A.panes ?? []).map((mode) => ({ path: 'M.md', mode })),
		autosave: A.lag ? 1200 : 150,
		lagReading: !!A.lag,
		// (a renderer that moves drawings about makes "the block that was clicked" a moot point: only the wild profile has it)
		reuse: P.copies ? 'pool' : P.hands ? 'ends' : 'pool',
	});
	await page.evaluate(install);
	if (A.blindAll) await page.evaluate(() => { window.harness.app._noSectionInfo = true; });
	if (process.env.TRACE) {
		// every click a board gets, and every click a session is told of
		await page.evaluate(() => {
			window.__trace = [];
			const proto = Object.getPrototypeOf(window.M.view(window.M.boards()[0]).session);
			const click = proto.click;
			proto.click = function (x, y) {
				window.__trace.push(`${Math.round(performance.now())} session.click ${String.fromCharCode(97 + x, 97 + y)} edit=${this.edit} tool=${this.tool} views=${this.views.size} body=${JSON.stringify(this.body).slice(0, 60)}`);
				return click.call(this, x, y);
			};
			document.addEventListener(
				'click',
				(ev) => {
					const k = ev.target.closest?.('.kifu');
					if (k) window.__trace.push(`${Math.round(performance.now())} click on board ${window.M.boards().indexOf(k)} (block ${window.M.ordinal(k)}) at ${Math.round(ev.clientX)},${Math.round(ev.clientY)} ${ev.target.tagName}.${ev.target.getAttribute('class') ?? ''}`);
				},
				true,
			);
		});
	}
	if (A.reading) {
		await page.evaluate((blind) => {
			const h = window.harness;
			h.app._noSectionInfo = blind;
			h.views.push(h.app.workspace._open('M.md', 'preview'));
		}, !!A.blind);
		await sleep(100);
	}
	const hasCm = !!A.editors;
	/** Can the editor's undo be used? (The stand-in keeps a history per pane, which two panes writing in turn would break.) */
	const canUndo = hasCm && A.editors === 1 && !OUTSIDE;

	// what is known about each block, by a name that survives blocks being deleted and copied
	let nextId = 0;
	const info = new Map();
	const born = (body) => {
		const id = nextId++;
		info.set(id, {
			first: body,
			allowed: new Set(coordsOf(body)),
			expected: new Set(),
			tokens: new Set(tokensOf(body)),
			typed: new Set(),
			touched: false,
			edit: false,
			/** Its text was changed by hand; something was undone on its board. (Then what it should hold is anyone's guess.) */
			hand: false,
			undone: false,
			/** When each point and comment was put on it. */
			at: new Map(),
		});
		return id;
	};
	let { outs } = split(START);
	let ids = BODIES.map(born);
	/** One entry per step of the editor's undo history: a write of the plugin's, or an edit of ours with what was before it. */
	const history = [];
	const log = [];
	let lastUsed = null;
	let undone = false;
	let editorUndone = false;
	let handled = false;
	/**
	 * The moments at which the note changed in more than one place at once, as far as the
	 * plugin could see: an edit that was waiting just then may be refused. (An editor
	 * reports every change it makes as it makes it; a file that another program rewrites,
	 * or a note "typed into" through a reading view, shows only the result.)
	 */
	const risks = [];
	const stepwise = hasCm || A.panes?.[0] === 'source';
	let lastHand = 0;
	/** How long an edit can wait to be written (the plugin's longest delay, and some). */
	const WAIT = 3600;
	const excused = (id, what) => risks.some((t) => Math.abs((info.get(id).at.get(what) ?? 0) - t) < WAIT);
	let moves = 0;
	/** Edits that went missing, by what excuses that. */
	const gone = { 'block changed by hand': 0, 'undone': 0, 'note rearranged in several places at once': 0, 'several panes, or boards without line numbers': 0 };
	/** Captions that got a second space by hand: no board may take it out again. */
	const spaced = new Set();

	// points nobody has used: rows 0-6 for what gets saved (the point below is always free, so no move is ever suicide),
	// the bottom row for moves played on locked boards
	const taken = new Set(['cc', 'ee', 'eg']);
	const fresh = [];
	for (let k = 0; k < 63; k++) {
		const pt = String.fromCharCode(97 + (k % 9)) + String.fromCharCode(97 + Math.floor(k / 9));
		if (!taken.has(pt)) fresh.push(pt);
	}
	const bottom = Array.from({ length: 9 }, (_, x) => String.fromCharCode(97 + x) + 'i');
	const TOOLS = ['Black stone', 'White stone', 'Black stone', 'White stone', 'Play moves', 'Triangle', 'Square', 'Circle', 'Cross', 'Letter or number'];
	const BACKABLE = new Set(['Black stone', 'White stone', 'Triangle', 'Square', 'Circle', 'Cross']);
	/** What each block got, in order, as [point, tool]: for the eraser to aim at. */
	const placed = new Map();
	let strict = null;
	/** The wrong-block check, on the note as the first pane holds it right now. */
	const lookNow = async (step) => {
		if (P.copies || strict) return;
		const t = await page.evaluate(() => window.harness.views[0].data);
		const now = split(t);
		if (now.bodies.length !== ids.length) return;
		ids.forEach((id, k) => {
			const b = info.get(id);
			for (const pt of coordsOf(now.bodies[k])) if (!b.allowed.has(pt) && !strict) strict = `after step ${step} (${log[log.length - 1] ?? 'nothing yet'}): ${pt} is in block ${id}, where it was never put`;
			for (const tk of tokensOf(now.bodies[k])) if (!b.tokens.has(tk) && !strict) strict = `after step ${step} (${log[log.length - 1] ?? 'nothing yet'}): comment ${tk} is in block ${id}, where it was never typed`;
		});
	};

	const count = () => page.locator('.kifu').count();
	const stateOf = (i) => page.evaluate((i) => window.M.state(i), i);
	const used = (id) => {
		lastUsed = id;
		info.get(id).touched = true;
	};
	/** Whatever is in the editor's history that we did not put there is a write of the plugin's. */
	const syncHistory = (len) => {
		while (history.length < len) history.push({ plugin: true });
		history.length = len;
	};
	/** A board was locked (or so it should be): unless a board of that block is still unlocked, the block counts as locked. */
	const locked = async (id) => {
		const ord = ids.indexOf(id);
		if (ord >= 0 && !(await page.evaluate((ord) => window.M.unlocked(ord), ord))) info.get(id).edit = false;
	};
	const handEdit = async (kind, k, tag) => {
		const outside = (!hasCm || OUTSIDE) && rnd() < 0.5;
		const snapshot = { outs: outs.slice(), ids: ids.slice() };
		if ((kind === 'move' && (outside || !stepwise)) || (!stepwise && Date.now() - lastHand < 600)) risks.push(Date.now());
		const r = await page.evaluate(([kind, k, tag, outside]) => window.M.edit(kind, k, tag, outside), [kind, k, tag, outside]);
		if (!r) return false;
		lastHand = Date.now();
		/** What the editor's history holds for this edit, oldest first: the note as it was before each of its steps. */
		const steps = [snapshot];
		if (kind === 'line') outs[0] = 'typed line\n' + outs[0];
		else if (kind === 'tail') outs[outs.length - 1] += 'line from outside\n';
		else if (kind === 'caption' || kind === 'space') {
			info.get(ids[k]).touched = true;
			info.get(ids[k]).hand = true;
			handled = true;
			if (kind === 'space') spaced.add(r.tag);
		} else if (kind === 'delete') {
			outs.splice(k, 2, outs[k] + outs[k + 1].slice(1));
			ids.splice(k, 1);
			handled = true;
		} else if (kind === 'move') {
			// (it is the same block still, with whatever was put on it: only somewhere else)
			const id = ids[k];
			outs.splice(k, 2, outs[k] + outs[k + 1].slice(1));
			ids.splice(k, 1);
			steps.push({ outs: outs.slice(), ids: ids.slice() });
			outs.push(outs.pop() + 'moved here\n\n', '\n');
			ids.push(id);
			handled = true;
			moves++;
		} else if (kind === 'copy') {
			outs.splice(k + 1, 1, '\n\ncopied below\n\n', '\n' + outs[k + 1].slice(1));
			ids.splice(k + 1, 0, born(r.body));
			handled = true;
		}
		if (canUndo) {
			syncHistory(r.before);
			for (let i = 0; i < r.after - r.before; i++) history.push({ plugin: false, ...(steps[i] ?? steps[steps.length - 1]) });
		}
		log.push(`${kind}${k === null ? '' : ' in block ' + k}${outside ? ' (in the file)' : ''}`);
		return true;
	};

	let verdict = null;
	try {
		for (let step = 0; step < STEPS; step++) {
			const n = await count();
			const roll = ri(P.copies ? 26 : P.hands ? 24 : 18);
			if (roll < 6 && n && fresh.length) {
				/* a stone, a move or a mark on an unlocked board */
				const i = ri(n);
				await page.evaluate((i) => window.M.boards()[i]?.scrollIntoView({ block: 'center' }), i);
				await sleep(60);
				let st = await stateOf(i);
				if (!st || st.ord < 0 || !st.shown) continue;
				const id = ids[st.ord];
				const board = page.locator('.kifu').nth(i);
				if (!st.editing) {
					const box = await board.locator('.kifu-svg').boundingBox();
					if (!box) continue;
					await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
					// (a board may be drawn again, or go back to locked, between any two of these steps: then there is nothing to click)
					if (!(await board.locator('.kifu-ctl .kifu-btn').first().click({ timeout: 1500 }).then(() => true, () => false))) continue;
					used(id);
					info.get(id).edit = true;
					await sleep(30);
					st = await stateOf(i);
					if (!st || !st.editing || st.ord < 0 || ids[st.ord] !== id) {
						log.push(`board ${i} (block ${id}): unlocked, then it was drawn again`);
						continue;
					}
				}
				const tool = one(TOOLS);
				const button = board.locator(`.kifu-tools .kifu-btn[aria-label^="${tool}"]`);
				if (!(await button.evaluate((b) => b.classList.contains('is-active')).catch(() => true))) await button.click({ timeout: 1500 }).catch(() => {});
				used(id);
				const pt = fresh[0];
				const at = await page.evaluate(([i, pt]) => window.M.aim(i, pt), [i, pt]);
				if (!at || !at.editing || at.ord < 0 || ids[at.ord] !== id) continue;
				fresh.shift();
				if (process.env.TRACE) await page.evaluate((m) => window.__trace.push(m), `-- ${tool} ${pt} on board ${i} (block ${id}) at ${Math.round(at.x)},${Math.round(at.y)}`);
				await page.mouse.click(at.x, at.y);
				info.get(id).allowed.add(pt);
				info.get(id).expected.add(pt);
				info.get(id).at.set(pt, Date.now());
				info.get(id).edit = true;
				log.push(`${tool} ${pt} on board ${i} (block ${id})`);
				if (!placed.has(id)) placed.set(id, []);
				placed.get(id).push(pt);
				if (BACKABLE.has(tool) && rnd() < BACK) {
					/* ...and taken off again: at once, or once it has been written (then the block reads again what it read before) */
					await sleep(rnd() < 0.6 ? 650 : 40);
					const again = await page.evaluate(([i, pt]) => window.M.aim(i, pt), [i, pt]);
					const stillActive = await page.locator('.kifu').nth(i).locator(`.kifu-tools .kifu-btn[aria-label^="${tool}"]`).evaluate((b) => b.classList.contains('is-active')).catch(() => false);
					if (again && again.editing && again.ord >= 0 && ids[again.ord] === id && stillActive) {
						await page.mouse.click(again.x, again.y);
						used(id);
						info.get(id).expected.delete(pt);
						log.push(`${tool} ${pt} taken off again on board ${i} (block ${id})`);
					}
				}
			} else if (roll < 8 && n && bottom.length) {
				/* a move played on a locked board: not saved (unless the board is unlocked with it still there) */
				const i = ri(n);
				await page.evaluate((i) => window.M.boards()[i]?.scrollIntoView({ block: 'center' }), i);
				await sleep(60);
				const pt = bottom[0];
				const at = await page.evaluate(([i, pt]) => window.M.aim(i, pt), [i, pt]);
				if (!at || at.editing || at.ord < 0) continue;
				bottom.shift();
				const id = ids[at.ord];
				await page.mouse.click(at.x, at.y);
				used(id);
				info.get(id).allowed.add(pt);
				log.push(`played ${pt} on locked board ${i} (block ${id})`);
			} else if (roll === 8 && n) {
				/* lock a board */
				const i = ri(n);
				const st = await stateOf(i);
				if (!st || !st.editing || st.ord < 0) continue;
				const id = ids[st.ord];
				await page.locator('.kifu').nth(i).locator('.kifu-ctl .kifu-btn').first().click({ force: true }).catch(() => {});
				used(id);
				await locked(id);
				log.push(`locked board ${i} (block ${id})`);
			} else if ((roll === 9 || roll === 10) && n) {
				/* a key on a board */
				const i = ri(n);
				const keys = ['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
				if (P.hands) keys.push('Control+z', 'Control+z', 'Control+Shift+z');
				const key = one(keys);
				const st = await stateOf(i);
				if (!st || st.ord < 0 || !st.shown) continue;
				const id = ids[st.ord];
				await page.evaluate((i) => window.M.boards()[i]?.focus({ preventScroll: true }), i);
				used(id);
				await page.keyboard.press(key);
				if (key === 'Escape') await locked(id);
				if (key.startsWith('Control') && st.editing) {
					undone = true;
					info.get(id).undone = true;
				}
				log.push(`${key} on board ${i} (block ${id})`);
			} else if ((roll === 11 || roll === 12) && lastUsed !== null) {
				/* a comment, typed in the panel: it belongs to the board that was used last */
				const box = page.locator('.kifu-p-comment');
				if (!(await box.isVisible().catch(() => false))) continue;
				const token = `q${step}q`;
				// (noted before the first key: the comment may be on its way into the note while the rest is typed)
				info.get(lastUsed).tokens.add(token);
				info.get(lastUsed).touched = true;
				if (!(await box.click({ timeout: 1500 }).then(() => true, () => false))) continue;
				await box.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length)).catch(() => {});
				await page.keyboard.type(token + ' ', { delay: 10 });
				// (it was typed, letter by letter, into a box that was there to the end: it should be saved)
				if (await box.isVisible().catch(() => false)) {
					info.get(lastUsed).typed.add(token);
					info.get(lastUsed).at.set(token, Date.now());
				}
				log.push(`comment ${token} (block ${lastUsed})`);
			} else if (roll === 13 && n && rnd() < 0.5) {
				/* the eraser, on a point this block got earlier (it may or may not still be there to erase) */
				const i = ri(n);
				const st = await stateOf(i);
				if (!st || !st.editing || st.ord < 0 || !st.shown) continue;
				const id = ids[st.ord];
				const mine = placed.get(id) ?? [];
				if (!mine.length) continue;
				const pt = one(mine);
				const board = page.locator('.kifu').nth(i);
				const button = board.locator('.kifu-tools .kifu-btn[aria-label^="Eraser"]');
				if (!(await button.evaluate((b) => b.classList.contains('is-active')).catch(() => true))) await button.click({ timeout: 1500 }).catch(() => {});
				used(id);
				const at = await page.evaluate(([i, pt]) => window.M.aim(i, pt), [i, pt]);
				if (!at || !at.editing || at.ord < 0 || ids[at.ord] !== id) continue;
				await page.mouse.click(at.x, at.y);
				info.get(id).expected.delete(pt);
				log.push(`Eraser ${pt} on board ${i} (block ${id})`);
			} else if (roll === 13 && n) {
				/* the switch for what the locked board shows */
				const i = ri(n);
				const st = await stateOf(i);
				if (!st || !st.editing || st.ord < 0) continue;
				const b = page.locator('.kifu').nth(i).locator('.kifu-tools .kifu-btn[aria-label^="When locked"]');
				if (!(await b.count())) continue;
				await b.click({ force: true }).catch(() => {});
				used(ids[st.ord]);
				log.push(`figure switch on board ${i} (block ${ids[st.ord]})`);
			} else if (roll === 14 && lastUsed !== null) {
				/* the lock in the panel */
				const b = page.locator('.kifu-p-nav .kifu-btn').last();
				if (!(await b.isVisible().catch(() => false))) continue;
				const label = await b.getAttribute('aria-label').catch(() => null);
				// (set before the click when it unlocks, after it when it locks: the check is that nothing is unlocked unasked)
				if (label?.startsWith('Unlock')) info.get(lastUsed).edit = true;
				// (the panel may let go of its board at any moment: then there is nothing to click)
				if (!(await b.click({ timeout: 1500 }).then(() => true, () => false))) continue;
				if (!label?.startsWith('Unlock')) await locked(lastUsed);
				info.get(lastUsed).touched = true;
				log.push(`${label?.startsWith('Unlock') ? 'unlocked' : 'locked'} in the panel (block ${lastUsed})`);
			} else if (roll === 15) {
				await page.evaluate((f) => {
					for (const sc of document.querySelectorAll('.cm-scroller, .view-content')) sc.scrollTop = f * sc.scrollHeight;
				}, rnd());
				log.push('scrolled');
			} else if (roll === 16 && hasCm) {
				/* the cursor goes into a block (its source is shown instead of the board) and out again */
				const btn = page.locator('.edit-block-button');
				const c = await btn.count();
				if (!c) continue;
				await btn.nth(ri(c)).click({ force: true }).catch(() => {});
				await sleep(150);
				await page.evaluate(() => {
					for (const v of window.harness.views) if (v.cm) v.cm.dispatch({ selection: { anchor: 0 } });
				});
				log.push('cursor into a block and out');
			} else if (roll === 17) {
				await handEdit('line', null);
			} else if (roll === 18 || roll === 19) {
				if (roll === 19 && rnd() < 0.5) await handEdit('space', ri(ids.length));
				else await handEdit('caption', ri(ids.length), `h${step}`);
			} else if (roll === 20 && ids.length > 3 && !A.lag) {
				await handEdit('delete', ri(ids.length));
			} else if (roll === 21 && ids.length >= 3 && !A.lag && (hasCm || rnd() < 0.5)) {
				/* a block is cut and pasted at the end of the note (not beside a pane that is behind: its boards could not be told from here) */
				await handEdit('move', ri(ids.length));
			} else if (roll === 21 && !hasCm) {
				await handEdit('tail', null);
			} else if ((roll === 22 || roll === 23) && canUndo) {
				/* undo in the editor: takes back the last change to the note, ours or the plugin's */
				syncHistory(await page.evaluate(() => window.M.undo()));
				if (!history.length) continue;
				const was = history.pop();
				if (!was.plugin) ({ outs, ids } = { outs: was.outs, ids: was.ids });
				undone = true;
				editorUndone = true;
				log.push(`undo in the editor (${was.plugin ? "a write of the plugin's" : 'an edit of ours'})`);
			} else if ((roll === 24 || roll === 25) && ids.length < 8 && !A.lag) {
				await handEdit('copy', ri(ids.length));
			}
			// (now and then a pause long enough for everything that was "a moment ago" to be over)
			await sleep(rnd() < 0.03 ? 5600 : one([0, 50, 150, 450, 700]));
			await lookNow(step);
			if (strict) break;
		}

		await sleep(A.lag ? 3500 : 1600);

		/* ------------------------------------------------------------ checks */
		const said = await notices(page);
		const text = await page.evaluate(() => window.harness.views[0].data);
		const file = await page.evaluate(() => window.harness.text('M.md'));
		const now = split(text);
		const problems = [];
		if (strict) problems.push(strict);
		if (file !== text) problems.push('the file and the pane do not hold the same text');
		if (now.bodies.length !== ids.length) problems.push(`${now.bodies.length} blocks in the note, ${ids.length} expected`);
		else if (JSON.stringify(now.outs) !== JSON.stringify(outs)) {
			const k = now.outs.findIndex((o, i) => o !== outs[i]);
			problems.push(`text outside the blocks changed: ${JSON.stringify(now.outs[k]).slice(0, 200)} where ${JSON.stringify(outs[k]).slice(0, 200)} was expected`);
		} else {
			// (Where the renderer moves drawings between blocks that read the same, "the block
			// that was clicked" stops meaning much: there, boards and blocks only have to agree.)
			const missing = [];
			let lacking = 0;
			if (!P.copies) {
				ids.forEach((id, k) => {
					const b = info.get(id);
					const body = now.bodies[k];
					const has = new Set(coordsOf(body));
					for (const pt of has) if (!b.allowed.has(pt)) problems.push(`${pt} is in block ${id}, where it was never put`);
					for (const t of tokensOf(body)) if (!b.tokens.has(t)) problems.push(`comment ${t} is in block ${id}, where it was never typed`);
					if (!b.touched && body !== b.first.replace(/\r/g, '')) problems.push(`block ${id} was not touched, but changed from ${JSON.stringify(b.first)} to ${JSON.stringify(body)}`);
					const lost = [...b.expected].filter((pt) => !has.has(pt)).concat([...b.typed].filter((t) => !body.includes(t)));
					for (const x of lost) missing.push(`${/^q/.test(x) ? 'comment ' : ''}${x} (block ${id})`);
					if (lost.length) lacking++;
					// Nobody changed this block by hand and nothing was undone on it: then whatever
					// happened to the rest of the note is no reason to refuse what was put on it.
					if (panes === 1 && !A.blindAll && !editorUndone && !b.hand && !b.undone) {
						const unfair = lost.filter((x) => !excused(id, x));
						if (unfair.length) problems.push(`lost from block ${id}, which nobody changed by hand: ${unfair.join(', ')} (${said.length} notice(s))`);
						gone['note rearranged in several places at once'] += lost.length - unfair.length;
					} else {
						gone[b.hand ? 'block changed by hand' : editorUndone || b.undone ? 'undone' : 'several panes, or boards without line numbers'] += lost.length;
					}
				});
			}
			// Nothing else was changing the blocks: every edit must be there. Otherwise a refusal
			// is fair, if it was announced: one notice for every block that lost something.
			const alone = panes === 1 && !handled && !undone && !A.blindAll;
			if (missing.length && !undone && (alone || said.length < lacking)) {
				problems.push(`not saved${alone ? '' : `, and ${said.length} notice(s) for ${lacking} block(s)`}: ${missing.join(', ')}`);
			}
			if (alone && !P.copies && said.length) problems.push(`a notice, with nothing to complain about: ${said[0]}`);
			// a space typed by hand into a caption stays (unless an undo in the editor took it out)
			if (!undone) {
				for (const tag of spaced) {
					const line = text.split('\n').find((l) => new RegExp(`caption:\\s*${tag}\\s*$`).test(l));
					if (line !== undefined && !line.includes(`caption:  ${tag}`)) problems.push(`the space typed by hand into "caption:  ${tag}" is gone: ${JSON.stringify(line)}`);
				}
			}
		}
		for (const b of await page.evaluate(() => window.M.audit())) {
			if (b.ord < 0 || b.ord >= ids.length) {
				problems.push(`board ${b.i} stands on no block`);
				continue;
			}
			const id = ids[b.ord];
			if (b.shows === null || b.reads === null) problems.push(`board ${b.i} (block ${id}) shows nothing`);
			else if (squash(b.shows) !== squash(b.reads)) {
				problems.push(`board ${b.i} (block ${id}) shows ${JSON.stringify(b.shows)} but its block reads ${JSON.stringify(b.reads)}`);
			}
			if (b.editing && !P.copies && !info.get(id).edit) problems.push(`board ${b.i} (block ${id}) is unlocked, and nobody unlocked it`);
		}
		for (const e of errors) problems.push('page error: ' + e.slice(0, 300));
		if (problems.length) verdict = { problems, said, text };
	} catch (e) {
		verdict = { problems: ['the monkey itself failed: ' + String(e.stack ?? e).slice(0, 600)], said: [], text: '' };
	}
	if (process.env.TRACE && verdict) verdict.problems.push('trace:\n      ' + (await page.evaluate(() => window.__trace)).join('\n      '));
	const name = `${arrangement} ${profile} ${seed} [${VARIANT}${OUTSIDE ? ', file changed from outside' : ''}]`;
	if (verdict) await page.screenshot({ path: `${out}/monkey-${name.replace(/[ \[\]]+/g, '-')}.png` }).catch(() => {});
	const saved = [...info.values()].reduce((a, b) => a + b.expected.size, 0);
	const said = verdict ? verdict.said : await notices(page);
	await page.context().close();
	const lostWhy = Object.entries(gone).filter(([, n]) => n).map(([why, n]) => `${n} lost (${why})`);
	return { name, verdict, log, saved, said, moves, lostWhy };
}

const browser = await chromium.launch();
const todo = [];
for (const a of arrangements) for (const p of profiles) for (const s of seeds) todo.push([a, p, s]);
let failed = 0;
const worker = async () => {
	for (;;) {
		const job = todo.shift();
		if (!job) return;
		const r = await run(browser, ...job);
		if (r.verdict) {
			failed++;
			console.log(`✖ ${r.name}\n    ${r.verdict.problems.slice(0, 8).join('\n    ')}\n    notices: ${JSON.stringify(r.verdict.said)}\n    what it did: ${r.log.join(' | ')}\n    the note: ${JSON.stringify(r.verdict.text)}`);
		} else {
			console.log(`✔ ${r.name} (${[`${r.saved} edits`, ...(r.moves ? [`${r.moves} moved`] : []), ...(r.said.length ? [`${r.said.length} notice(s)`] : []), ...r.lostWhy].join(', ')})`);
		}
	}
};
await Promise.all(Array.from({ length: JOBS }, worker));
await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall runs passed');
process.exit(failed ? 1 : 0);
