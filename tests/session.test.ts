import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Host, nodeMark } from '../src/session';
import { DEFAULT_SETTINGS, KifuSettings } from '../src/config';
import { getMove, getText, parseSgf, serializeSgf, xy2pt, SgfNode } from '../src/sgf';

function host(over: Partial<KifuSettings> = {}): Host & { saves: number } {
	const h = {
		settings: { ...DEFAULT_SETTINGS, replyDelay: 0, ...over },
		saves: 0,
		requestSave() {
			h.saves++;
		},
		later(fn: () => void, ms: number) {
			const id = setTimeout(fn, ms);
			return () => clearTimeout(id);
		},
	};
	return h;
}
const make = (body: string, over: Partial<KifuSettings> = {}) => new Session(host(over), 'note.md', body);
const at = (pt: string): [number, number] => [pt.charCodeAt(0) - 97, pt.charCodeAt(1) - 97];
const click = (s: Session, pt: string) => s.click(...at(pt));
const moveOf = (n: SgfNode) => { const m = getMove(n)!; return (m.color === 1 ? 'B' : 'W') + xy2pt(m.x, m.y); };
const stone = (s: Session, pt: string) => { const [x, y] = at(pt); return s.model().grid[y * s.w + x]; };
const label = (s: Session, pt: string) => { const [x, y] = at(pt); return s.model().labels.get(y * s.w + x); };

// A corner problem: black to play. Main line is the answer; one marked wrong line; one unmarked side line.
const PROBLEM = '(;GM[1]SZ[19]AB[pb][qc][rc]AW[oc][pd][qd][rd]' +
	'(;B[sb];W[sc];B[ra]C[Black lives.])' +
	'(;B[ra]BM[1];W[sb]C[Dead.])' +
	'(;B[sc];W[sb]))';

test('new empty board', () => {
	const s = make('');
	assert.equal(s.error, '');
	assert.equal(s.w, 19);
	assert.equal(s.blockBody(), ''); // nothing is written until something is drawn
	assert.equal(s.problem, false);
	const m = s.model();
	assert.deepEqual(m.view, { x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.equal(m.hint, '');
	assert.equal(make('size: 13x9').h, 9);
	assert.equal(make('', { boardSize: 9 }).w, 9);
	assert.match(make('game: 4\n(;SZ[9])').error, /holds 1 game; there is no game 4/);
});

test('whatever else is written in a block survives an edit', () => {
	// a second game, a remark in parentheses, notes and a stray option line below the SGF
	const body = 'caption: mine\n(Black to play and live)\n(;SZ[9];B[aa])\n(;SZ[9];B[bb]C[second game])\ntrailing notes\nview: full';
	const s = make(body);
	assert.equal(s.error, '');
	assert.equal(s.blockBody(), body); // untouched, it is exactly what was written
	s.setEdit(true);
	s.first();
	s.setTool('black');
	click(s, 'ee');
	assert.equal(
		s.blockBody(),
		'caption: mine\n(Black to play and live)\n(;SZ[9]AB[ee];B[aa])\n(;SZ[9];B[bb]C[second game])\ntrailing notes\nview: full',
	);
	// after the write, the next edit lands in the same place
	s.wrote(s.blockBody());
	click(s, 'ff');
	assert.ok(s.blockBody().includes('\n(;SZ[9]AB[ee][ff];B[aa])\n(;SZ[9];B[bb]C[second game])\n'));
	// "game: 2" edits the second game and leaves the first alone
	const t = make('game: 2\n(;SZ[9];B[aa])\n(;SZ[13];B[bb])');
	assert.equal(t.w, 13);
	t.setEdit(true);
	t.first();
	t.setComment('x');
	assert.equal(t.blockBody(), 'game: 2\n(;SZ[9];B[aa])\n(;SZ[13]C[x];B[bb])');
	// text in parentheses that is not a game is not mistaken for one
	const u = make('(not sgf\nat all)');
	assert.equal(u.error, '');
	u.setEdit(true);
	u.setTool('black');
	click(u, 'dd');
	assert.equal(u.blockBody(), '(not sgf\nat all)\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd])');
	u.wrote(u.blockBody());
	click(u, 'pp');
	assert.equal(u.blockBody(), '(not sgf\nat all)\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd][pp])');
	// a line that merely looks like "file: ..." is not a reference to an SGF file
	const f = make('File: Kisei final\n(;SZ[9]AB[cc])');
	assert.equal(f.fileRef, null);
	assert.equal(f.ready, true);
	// a board on a file keeps any inline text it was given, untouched
	const g = make('sgf: [[x.sgf]]\n(;SZ[9]AB[cc];B[dd])\nnotes');
	g.load('(;SZ[9])');
	g.setEdit(true);
	g.setFigure(true);
	assert.equal(g.blockBody(), 'sgf: [[x.sgf]]\nnumbers: on\n(;SZ[9]AB[cc];B[dd])\nnotes');
});

test('problem: following the answer plays the saved replies and ends correct', () => {
	const s = make(PROBLEM);
	assert.equal(s.problem, true);
	let m = s.model();
	assert.equal(m.hint, 'Black to play');
	assert.deepEqual(m.view, { x0: 12, y0: 0, x1: 18, y1: 5 });
	assert.equal(m.status, null);
	click(s, 'sb');
	assert.equal(moveOf(s.cur), 'Wsc'); // the reply was played for us
	assert.equal(s.status(), null); // line not finished
	assert.equal(label(s, 'sb'), '1');
	assert.equal(label(s, 'sc'), '2');
	click(s, 'ra');
	m = s.model();
	assert.equal(m.status, 'correct');
	assert.equal(m.text, 'Black lives.');
	assert.equal(m.hint, '');
	assert.equal(s.moved, true);
	// carrying on after the end keeps the verdict, and none of it is saved
	click(s, 'aa');
	assert.equal(s.cur.temp, true);
	assert.equal(s.status(), 'correct');
	assert.equal(serializeSgf(s.root).replace(/\n/g, ''), PROBLEM);
	s.reset();
	assert.equal(s.cur, s.home);
	assert.equal(s.moved, false);
	assert.equal((s.host as any).saves, 0);
});

test('problem: wrong lines, unmarked side lines and moves outside the tree', () => {
	const s = make(PROBLEM);
	click(s, 'ra');
	assert.equal(moveOf(s.cur), 'Wsb');
	assert.equal(s.status(), 'incorrect'); // explicitly marked
	assert.equal(s.model().text, 'Dead.');
	s.reset();
	click(s, 'sc');
	assert.equal(s.status(), 'incorrect'); // unmarked line that is not the main line
	s.reset();
	click(s, 'ab'); // not a saved move at all
	assert.equal(s.cur.temp, true);
	assert.equal(s.status(), 'incorrect');
	// playing the same scratch move again follows it instead of duplicating it
	s.goto(s.home);
	const before = s.home.children.length;
	click(s, 'ab');
	assert.equal(s.home.children.length, before);
	s.reset();
	assert.equal(s.home.children.length, 3);
	// illegal clicks do nothing: occupied point
	click(s, 'pb');
	assert.equal(s.cur, s.home);
});

test('problem: explicit correct marks change the default', () => {
	// once some line is marked correct, unmarked lines (even the main line) are wrong
	const s = make('(;SZ[9]AB[aa]AW[bb](;B[cc])(;B[dd]TE[1])(;B[ee]C[Correct!])(;B[ff]C[Right side is big]))');
	click(s, 'cc');
	assert.equal(s.status(), 'incorrect');
	s.reset();
	click(s, 'dd');
	assert.equal(s.status(), 'correct');
	s.reset();
	click(s, 'ee');
	assert.equal(s.status(), 'correct');
	s.reset();
	click(s, 'ff');
	assert.equal(s.status(), 'incorrect');
	assert.equal(nodeMark(parseSgf('(;B[aa]C[RIGHT])')[0]), 'correct');
	assert.equal(nodeMark(parseSgf('(;B[aa]C[Black lives. RIGHT])')[0]), 'correct');
	assert.equal(nodeMark(parseSgf('(;W[aa]C[Wrong. White lives])')[0]), 'incorrect');
	assert.equal(nodeMark(parseSgf('(;B[aa]C[This is wrong])')[0]), null);
	// words in passing are not verdicts, and neither is anything said before the first move
	assert.equal(nodeMark(parseSgf('(;B[aa]C[Play on the RIGHT side first])')[0]), null);
	assert.equal(nodeMark(parseSgf('(;B[aa]C[Find the CORRECT move.])')[0]), null);
	assert.equal(nodeMark(parseSgf('(;C[Correct.])')[0]), null);
	const intro = make('(;SZ[9]AB[aa]AW[bb]C[Black to play. Find the CORRECT move. RIGHT];B[cc];W[dd];B[ee])');
	click(intro, 'cc');
	click(intro, 'ee');
	assert.equal(intro.status(), 'correct');
	// a deeper mark overrides a shallower one
	const d = make('(;SZ[9]AB[aa]AW[bb];B[cc]TE[1];W[dd](;B[ee])(;B[ff]BM[1]))');
	click(d, 'cc');
	click(d, 'ee');
	assert.equal(d.status(), 'correct');
	d.reset();
	click(d, 'cc');
	click(d, 'ff');
	assert.equal(d.status(), 'incorrect');
	assert.equal(d.verdict(d.cur), 'incorrect');
	assert.equal(d.verdict(d.cur.parent!), null);
});

test('problem: whichever saved reply the other side gives, the solver is still on the main line', () => {
	const body = '(;SZ[9]AB[aa]AW[bb];B[cc](;W[dd];B[ee])(;W[ff](;B[gg])(;B[hh])))';
	const real = Math.random;
	Math.random = () => 0.99; // "random" picks the last reply
	try {
		const s = make(body, { reply: 'random' });
		click(s, 'cc');
		assert.equal(moveOf(s.cur), 'Wff');
		click(s, 'gg');
		assert.equal(s.status(), 'correct'); // answered the second reply as saved
		s.reset();
		click(s, 'cc');
		click(s, 'hh'); // the solver's own second choice is still off the main line
		assert.equal(s.status(), 'incorrect');
	} finally {
		Math.random = real;
	}
});

test('plain positions and game records are not judged', () => {
	const s = make('(;SZ[9];B[ee];W[cc];B[gg])');
	assert.equal(s.problem, false);
	s.first();
	assert.equal(s.cur, s.root);
	click(s, 'ee'); // matches the game: followed, reply played
	assert.equal(moveOf(s.cur), 'Wcc');
	click(s, 'aa'); // differs: just a scratch move
	assert.equal(s.cur.temp, true);
	assert.equal(s.status(), null);
	assert.equal(make('problem: yes\n(;SZ[9];B[ee];W[cc];B[gg])').problem, true);
	assert.equal(make('problem: no\n' + PROBLEM).problem, false);
	// handicap: white moves first
	assert.equal(make('(;SZ[9]AB[cc][gg])').toPlay(), 2);
	assert.equal(make('(;SZ[9]AB[cc]AW[gg])').toPlay(), 1);
	assert.equal(make('(;SZ[9]AB[cc]AW[gg]PL[W])').toPlay(), 2);
	assert.equal(make('(;SZ[9]AB[cc]AW[gg];W[aa])').toPlay(), 2);
});

test('home: a record of moves rests on its last position, a position on its first', () => {
	// moves from an empty board, nothing to solve: the picture is where they lead
	let s = make('(;GM[1]SZ[9];B[ee];W[cc];B[gg])');
	assert.equal(moveOf(s.home), 'Bgg');
	assert.equal(s.cur, s.home);
	assert.equal(s.start, s.root);
	let m = s.model();
	assert.equal(Array.from(m.grid).filter(Boolean).length, 3);
	assert.equal(m.labels.size, 0); // a position, not a numbered figure
	assert.equal(m.last, -1);
	assert.equal(m.hint, '');
	assert.equal(s.moved, false);
	// playing on from there is numbered from 1
	click(s, 'aa');
	assert.equal(label(s, 'aa'), '1');
	s.reset();
	assert.equal(s.cur, s.home);
	// only the main line counts
	s = make('(;SZ[9];B[ee](;W[cc];B[gg])(;W[dd];B[ff];W[aa]))');
	assert.equal(moveOf(s.home), 'Bgg');
	// "move: 0" asks for the empty board all the same
	s = make('move: 0\n(;SZ[9];B[ee];W[cc];B[gg])');
	assert.equal(s.home, s.root);
	// the same for moves played on stones that were set up first (a handicap game, say)
	s = make('(;SZ[9]AB[cc][gg];W[ee];B[ec])');
	assert.equal(s.problem, false);
	assert.equal(moveOf(s.home), 'Bec');
	s = make('problem: no\n(;SZ[9]AB[cc]AW[gg];B[dd];W[ee])');
	assert.equal(moveOf(s.home), 'Wee');
	// something to solve rests on its first position, however it was built
	s = make('(;SZ[9]AB[cc]AW[gg];B[dd];W[ee])');
	assert.equal(s.problem, true);
	assert.equal(s.home, s.root);
	s = make('problem: yes\n(;SZ[9];B[ee];W[cc])');
	assert.equal(s.home, s.root);
	// marks on moves do not make a problem by themselves: a reviewed game has them too
	s = make('(;SZ[9];B[ee](;W[cc]TE[1];B[gg]BM[1]C[Wrong. Too slow.])(;W[dd]))');
	assert.equal(s.problem, false);
	assert.equal(moveOf(s.home), 'Bgg');
	assert.equal(s.model().hint, '');
	assert.equal(s.concealed, false);
	s = make('problem: yes\n(;SZ[9];B[ee](;W[cc]TE[1])(;W[dd]))');
	assert.equal(s.problem, true);
	assert.equal(s.home, s.root);
	// a position node after a root that only holds game info is where things start
	s = make('(;GM[1]SZ[9];AB[cc]AW[gg];B[ee])');
	assert.equal(s.start, s.root.children[0]);
	assert.equal(s.home, s.start);
	// a new board, and what one sees after drawing on it with the play tool and locking
	s = make('size: 9');
	assert.equal(s.home, s.root);
	s.setEdit(true);
	click(s, 'ee');
	click(s, 'cc');
	s.prev();
	s.setEdit(false);
	assert.equal(moveOf(s.cur), 'Wcc');
	assert.equal(s.cur, s.home);
	m = s.model();
	assert.equal(Array.from(m.grid).filter(Boolean).length, 2);
	// undoing the moves brings the resting position back with them
	s.setEdit(true);
	s.undo();
	s.undo();
	s.setEdit(false);
	assert.equal(s.cur, s.root);
});

test('home: move and numbers options pick the resting position', () => {
	const game = '(;GM[1]SZ[9];B[aa];W[bb];B[cc];W[dd];B[ee];W[ff])';
	let s = make('move: 3\n' + game);
	assert.equal(moveOf(s.home), 'Bcc');
	assert.equal(s.numbering()!.from, 4); // playing on is numbered from 1
	assert.equal(make('move: last\n' + game).home.children.length, 0);
	assert.equal(make('move: 99\n' + game).home.children.length, 0);
	s = make('numbers: 2-4\n' + game);
	assert.equal(moveOf(s.home), 'Wdd');
	assert.equal(label(s, 'aa'), undefined);
	assert.equal(label(s, 'bb'), '2');
	assert.equal(label(s, 'dd'), '4');
	s = make('numbers: 2-4 from 1\n' + game);
	assert.equal(label(s, 'bb'), '1');
	assert.equal(label(s, 'dd'), '3');
	s = make('numbers: on\n' + game);
	assert.equal(s.home.children.length, 0);
	assert.equal(label(s, 'ff'), '6');
	s = make('numbers: off\n' + game);
	assert.equal(s.home.children.length, 0);
	s.first();
	click(s, 'aa');
	assert.equal(label(s, 'aa'), undefined);
	assert.equal(s.model().last, 1 * 9 + 1); // the reply at bb is flagged instead
	// "number moves as you play" switched off in the settings
	s = make(game, { numberPlayed: false });
	s.first();
	click(s, 'aa');
	assert.equal(s.model().labels.size, 0);
	// a root that only holds game info: the position node is the start
	s = make('(;GM[1]SZ[9];AB[aa]AW[bb];B[cc])');
	assert.equal(s.home, s.root.children[0]);
	assert.equal(s.problem, true);
	// a diagram built from setup steps only starts at its first step, not its last
	s = make('(;SZ[9]AB[aa];AB[bb];AW[cc])');
	assert.equal(s.home, s.root);
	s.last();
	s.first();
	assert.equal(s.cur, s.root);
	// a move played above the resting position has no number, so it gets the dot
	s = make('move: 3\n(;SZ[9];B[aa];W[bb];B[cc];W[dd])');
	s.prev();
	s.prev();
	click(s, 'hh');
	assert.equal(s.model().labels.size, 0);
	assert.equal(s.model().last, 7 * 9 + 7);
});

test('figure at rest, live position once you move', () => {
	const ko = 'numbers: on\n(;SZ[5]AB[ba][ab][bc]AW[ca][bb][db][cc];B[cb];W[ee];B[ed];W[bb])';
	const s = make(ko);
	let m = s.model();
	assert.equal(stone(s, 'cb'), 1); // captured stone still shown in the figure
	assert.deepEqual(m.notes, [{ label: '4', color: 2, at: 'B4', atColor: 0 }]);
	s.prev();
	m = s.model();
	assert.equal(m.notes.length, 0);
	assert.equal(stone(s, 'bb'), 0); // real position: the ko stone is off the board
	s.next();
	assert.equal(stone(s, 'cb'), 1); // back at rest: figure again
	s.setEdit(true);
	assert.equal(stone(s, 'cb'), 0); // editing always shows the real position
	// a numbered figure is an illustration: no "to play" line, no verdicts
	assert.equal(make(ko).problem, false);
	assert.equal(make(ko).model().hint, '');
	assert.equal(make(ko.replace('numbers: on', 'numbers: off')).problem, true);
	assert.equal(make('problem: yes\n' + ko).problem, true);
});

test('navigation remembers the branch you came from', () => {
	const s = make(PROBLEM);
	s.goto(s.home.children[1]);
	s.next();
	assert.equal(moveOf(s.cur), 'Wsb');
	s.prev();
	s.prev();
	s.next();
	assert.equal(moveOf(s.cur), 'Bra');
	s.sibling(1);
	assert.equal(moveOf(s.cur), 'Bsc');
	s.sibling(-1);
	s.sibling(-1);
	assert.equal(moveOf(s.cur), 'Bsb');
	s.last();
	assert.equal(moveOf(s.cur), 'Bra');
	s.first();
	assert.equal(s.cur, s.root);
});

test('edit: stones, play, marks, labels, undo', () => {
	const h = host();
	const s = new Session(h, 'note.md', 'view: auto');
	s.setEdit(true);
	assert.deepEqual(s.model().view, { x0: 0, y0: 0, x1: 18, y1: 18 });
	s.setTool('black');
	click(s, 'pd');
	click(s, 'qd');
	click(s, 'qd'); // same colour again removes it
	s.setTool('white');
	click(s, 'pe');
	click(s, 'pd'); // other colour replaces
	assert.deepEqual(s.root.props.AW, ['pe', 'pd']);
	assert.equal(s.root.props.AB, undefined);
	s.undo();
	assert.deepEqual(s.root.props.AB, ['pd']);
	assert.equal(h.saves, 6);
	assert.equal(s.blockBody(), 'view: auto\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[pd]AW[pe])');
	// play tool builds lines and re-uses existing moves
	s.setTool('play');
	click(s, 'qe');
	assert.equal(moveOf(s.cur), 'Bqe');
	click(s, 'qf');
	assert.equal(moveOf(s.cur), 'Wqf');
	s.prev();
	click(s, 'pf');
	s.prev();
	click(s, 'qf');
	assert.equal(s.cur.parent!.children.length, 2);
	assert.equal(s.cur, s.cur.parent!.children[0]);
	// marks toggle and replace each other; labels count up
	s.goto(s.root);
	s.setTool('TR');
	click(s, 'pd');
	s.setTool('SQ');
	click(s, 'pd');
	assert.equal(s.root.props.TR, undefined);
	assert.deepEqual(s.root.props.SQ, ['pd']);
	assert.equal(s.model().marks.get(3 * 19 + 15), 'SQ');
	s.setTool('label');
	assert.equal(s.nextLabel, 'a');
	click(s, 'aa');
	click(s, 'bb');
	assert.deepEqual(s.root.props.LB, ['aa:a', 'bb:b']);
	s.nextLabel = '51';
	click(s, 'cc');
	click(s, 'dd');
	assert.equal(label(s, 'dd'), '52');
	click(s, 'cc'); // clicking a label removes it
	assert.deepEqual(s.root.props.LB, ['aa:a', 'bb:b', 'dd:52']);
	s.setTool('erase');
	click(s, 'pd'); // first the mark...
	assert.equal(s.root.props.SQ, undefined);
	assert.equal(stone(s, 'pd'), 1);
	click(s, 'pd'); // ...then the stone
	assert.equal(stone(s, 'pd'), 0);
	const n = h.saves;
	click(s, 'ss'); // nothing there: nothing happens
	assert.equal(h.saves, n);
	// an empty label box writes nothing and records nothing
	s.setTool('label');
	s.nextLabel = '';
	const before = h.saves;
	click(s, 'kk');
	assert.equal(h.saves, before);
	// undo walks all the way back, to a block with no SGF in it at all
	let guard = 0;
	while (s.canUndo && guard++ < 100) s.undo();
	assert.equal(serializeSgf(s.root), '(;GM[1]FF[4]CA[UTF-8]SZ[19])');
	assert.equal(s.blockBody(), 'view: auto');
	// ...and redo walks forward again
	while (s.canRedo && guard++ < 300) s.redo();
	assert.equal(stone(s, 'pd'), 0);
	assert.deepEqual(s.root.props.LB, ['aa:a', 'bb:b', 'dd:52']);
	assert.ok(s.blockBody().startsWith('view: auto\n(;GM[1]FF[4]CA[UTF-8]SZ[19]'));
});

test('undo: comments are steps of their own, and nothing typed later is lost with an earlier step', () => {
	const s = make('(;SZ[9]AB[cc]AW[dd];B[ee])');
	s.setEdit(true);
	s.setTool('black');
	click(s, 'gg');
	s.setComment('A long');
	s.setComment('A long, carefully typed comment.'); // the same burst of typing
	s.undo();
	assert.equal(getText(s.root, 'C'), ''); // the comment goes first...
	assert.deepEqual(s.root.props.AB, ['cc', 'gg']); // ...the stone is still there
	s.redo();
	assert.equal(getText(s.root, 'C'), 'A long, carefully typed comment.');
	s.undo();
	s.undo();
	assert.deepEqual(s.root.props.AB, ['cc']);
	assert.equal(s.canUndo, false);
	// a new edit clears what could be redone
	click(s, 'hh');
	assert.equal(s.canRedo, false);
	// moving away and back starts a new step
	s.setComment('one');
	s.next();
	s.prev();
	s.setComment('one two');
	s.undo();
	assert.equal(getText(s.root, 'C'), 'one');
	// the pile is bounded
	for (let i = 0; i < 300; i++) s.mark(i % 2 ? 'correct' : 'incorrect');
	s.goto(s.root.children[0]);
	for (let i = 0; i < 300; i++) s.mark(i % 2 ? 'correct' : 'incorrect');
	let steps = 0;
	while (s.canUndo && steps < 1000) {
		s.undo();
		steps++;
	}
	assert.equal(steps, 100);
});

test('edit: setup stones on a later node use AE and stay minimal', () => {
	const s = make('(;SZ[9]AB[cc];W[dd])');
	s.setEdit(true);
	s.goto(s.root.children[0]);
	s.setTool('black');
	click(s, 'cc'); // remove a stone that comes from the root
	assert.deepEqual(s.cur.props.AE, ['cc']);
	click(s, 'cc'); // put it back: no setup needed at all
	assert.equal(s.cur.props.AE, undefined);
	assert.equal(s.cur.props.AB, undefined);
	s.setTool('white');
	click(s, 'dd'); // remove the stone this node's own move placed
	assert.deepEqual(s.cur.props.AE, ['dd']);
	assert.equal(stone(s, 'dd'), 0);
	// compressed lists are expanded when edited
	const c = make('(;SZ[9]AB[aa:ba])');
	c.setEdit(true);
	c.setTool('black');
	click(c, 'aa');
	assert.deepEqual(c.root.props.AB, ['ba']);
});

test('edit: marking lines, deleting, promoting, comments, who plays', () => {
	const s = make(PROBLEM);
	s.setEdit(true);
	const side = s.home.children[2]; // B sc
	s.goto(side);
	assert.equal(s.ownMark(), null);
	s.mark('correct');
	assert.deepEqual(side.props.TE, ['1']);
	s.mark('incorrect');
	assert.equal(side.props.TE, undefined);
	assert.deepEqual(side.props.BM, ['1']);
	s.mark('incorrect'); // again: cleared
	assert.equal(side.props.BM, undefined);
	s.goto(side.children[0]);
	assert.equal(s.canPromote, true);
	s.promote();
	assert.equal(s.home.children[1], side);
	s.promote();
	assert.equal(s.home.children[0], side);
	assert.equal(s.canPromote, false);
	s.setComment('first line\nsecond ] line');
	assert.equal(getText(s.cur, 'C'), 'first line\nsecond ] line');
	s.deleteNode();
	assert.equal(s.cur, side);
	assert.equal(side.children.length, 0);
	s.goto(s.root);
	s.deleteNode(); // the root can not be deleted
	assert.equal(s.root.children.length, 3);
	// white to play first
	const w = make('(;SZ[9]AB[cc]AW[dd])');
	w.setEdit(true);
	w.togglePlayer();
	click(w, 'ee');
	assert.equal(moveOf(w.cur), 'Wee');
	assert.equal(serializeSgf(w.root), '(;SZ[9]AB[cc]AW[dd]PL[W];W[ee])');
});

test('edit: unlocking keeps the line on the board, locking saves at once', () => {
	const h = host();
	const s = new Session(h, 'note.md', PROBLEM);
	click(s, 'aa');
	s.goto(s.home);
	click(s, 'bb');
	click(s, 'cc');
	assert.equal(s.cur.temp, true);
	s.setEdit(true);
	assert.equal(s.cur.temp, undefined);
	assert.equal(moveOf(s.cur), 'Wcc');
	assert.equal(s.home.children.length, 4); // bb line kept, aa line dropped
	assert.equal(s.dirtyTree, true);
	assert.ok(serializeSgf(s.root).includes(';B[bb];W[cc]'));
	s.undo(); // and it can be taken back
	assert.equal(s.home.children.length, 3);
	const before = h.saves;
	s.setEdit(false);
	assert.equal(h.saves, before + 1);
});

test('crop and the resting view', () => {
	const s = make('scale: 0.8\n' + PROBLEM);
	s.setEdit(true);
	let m = s.model();
	assert.deepEqual(m.view, { x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(m.crop, { x0: 12, y0: 0, x1: 18, y1: 5 });
	s.setCrop({ x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.deepEqual(s.header, ['scale: 0.8', 'view: K10-T19']);
	assert.equal(s.dirtyHeader, true);
	assert.deepEqual(s.model().crop, { x0: 9, y0: 0, x1: 18, y1: 9 });
	assert.ok(s.blockBody().startsWith('scale: 0.8\nview: K10-T19\n(;GM[1]'));
	s.setCrop({ x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(s.header, ['scale: 0.8', 'view: full']);
	assert.equal(s.model().crop, null);
	s.setCrop(null);
	assert.deepEqual(s.header, ['scale: 0.8']);
	s.setEdit(false);
	m = s.model();
	assert.deepEqual(m.view, { x0: 12, y0: 0, x1: 18, y1: 5 });
	assert.equal(m.crop, null);
	// VW in the SGF is honoured, the option line wins over it, the setting is the fallback
	assert.deepEqual(make('(;SZ[19]VW[aa:jj]AB[cc])').model().view, { x0: 0, y0: 0, x1: 9, y1: 9 });
	assert.deepEqual(make('view: full\n(;SZ[19]VW[aa:jj]AB[cc])').model().view, { x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(make('(;SZ[19]AB[cc])', { view: 'full' }).model().view, { x0: 0, y0: 0, x1: 18, y1: 18 });
	assert.deepEqual(make('(;SZ[19]AB[cc])').model().view, { x0: 0, y0: 0, x1: 4, y1: 4 });
	// a visible area that is not on this board is ignored: the board is cropped as if it were not there
	assert.deepEqual(make('(;SZ[9]VW[zz]AB[cc])').model().view, { x0: 0, y0: 0, x1: 4, y1: 4 });
	assert.deepEqual(make('(;SZ[9]VW[zz]AB[cc])', { view: 'full' }).model().view, { x0: 0, y0: 0, x1: 8, y1: 8 });
});

test('figure switch: the locked board shows the numbered main line instead of the start', () => {
	const s = make('scale: 0.8\n(;SZ[9]AB[cc]AW[gg];B[dd];W[ee];B[ff])');
	assert.equal(s.problem, true);
	assert.equal(s.home, s.root);
	s.setEdit(true);
	assert.equal(s.figure, false);
	s.setFigure(true);
	assert.deepEqual(s.header, ['scale: 0.8', 'numbers: on']);
	assert.equal(s.figure, true);
	assert.equal(s.dirtyHeader, true);
	s.setEdit(false); // locking goes to the resting position, which is now the end of the line
	assert.equal(s.cur, s.home);
	assert.equal(moveOf(s.home), 'Bff');
	assert.equal(label(s, 'dd'), '1');
	assert.equal(label(s, 'ff'), '3');
	assert.equal(s.model().hint, '');
	assert.ok(s.blockBody().startsWith('scale: 0.8\nnumbers: on\n(;SZ[9]'));
	s.setEdit(true);
	s.undo();
	assert.deepEqual(s.header, ['scale: 0.8']);
	s.setFigure(true);
	s.setFigure(false);
	assert.deepEqual(s.header, ['scale: 0.8']);
	assert.equal(s.home, s.root);
	// a range written by hand comes back when the figure is switched on again
	const r = make('numbers: 2-3 from 1\n(;SZ[9];B[dd];W[ee];B[ff])');
	r.setEdit(true);
	r.setFigure(false);
	assert.deepEqual(r.header, []);
	r.setFigure(true);
	assert.deepEqual(r.header, ['numbers: 2-3 from 1']);
});

test('the start switch chooses the position the board opens at', () => {
	const s = make('scale: 0.8\n(;SZ[9];B[dd];W[ee](;B[ff];W[gg])(;B[cc]))');
	assert.equal(moveOf(s.home), 'Wgg'); // a game record opens at its last move
	s.setEdit(true);
	assert.equal(s.hasStart, false);
	s.first();
	s.next();
	s.next();
	assert.equal(s.canSetStart, true);
	s.toggleStart();
	assert.deepEqual(s.header, ['scale: 0.8', 'move: 2']);
	assert.equal(s.dirtyHeader, true);
	assert.equal(s.home, s.cur);
	assert.equal(s.hasStart, true);
	assert.equal(s.blockBody(), 'scale: 0.8\nmove: 2\n(;SZ[9];B[dd];W[ee](;B[ff];W[gg])(;B[cc]))'); // the game itself is left alone
	s.last();
	s.setEdit(false); // locking goes to the chosen position
	assert.equal(moveOf(s.cur), 'Wee');
	assert.equal(s.model().grid[5 * 9 + 5], 0); // move 3 is not on the board
	// the opening position itself is "move: 0"
	s.setEdit(true);
	s.first();
	s.toggleStart();
	assert.deepEqual(s.header, ['scale: 0.8', 'move: 0']);
	assert.equal(s.home, s.root);
	// pressed again on the chosen position, the choice is taken back
	s.toggleStart();
	assert.deepEqual(s.header, ['scale: 0.8']);
	assert.equal(s.hasStart, false);
	assert.equal(moveOf(s.home), 'Wgg');
	// undo puts the line back
	s.undo();
	assert.deepEqual(s.header, ['scale: 0.8', 'move: 0']);
	// a variation cannot be reached by a move number
	s.first();
	s.next();
	s.next();
	s.next();
	s.sibling(1);
	assert.equal(moveOf(s.cur), 'Bcc');
	assert.equal(s.canSetStart, false);
	s.toggleStart();
	assert.deepEqual(s.header, ['scale: 0.8', 'move: 0']);
	// nor can a setup step after a move: "move: 1" leads to the move itself
	const t = make('(;SZ[9];B[dd];AW[ee];W[ff])');
	t.setEdit(true);
	t.first();
	t.next();
	assert.equal(t.canSetStart, true);
	t.next();
	assert.equal(t.canSetStart, false);
	// a root that only carries game info counts as the start
	const g = make('(;GM[1]SZ[9]PB[x];AB[cc]AW[dd];B[ee])');
	g.setEdit(true);
	g.first();
	g.toggleStart();
	assert.deepEqual(g.header, ['move: 0']);
});

test('a problem with a chosen start is solved from there', () => {
	const s = make(PROBLEM);
	s.setEdit(true);
	s.first();
	s.next(); // B[sb], main line
	s.next(); // W[sc]
	s.toggleStart();
	assert.deepEqual(s.header, ['move: 2']);
	s.setEdit(false);
	assert.equal(moveOf(s.cur), 'Wsc');
	assert.equal(s.model().hint, 'Black to play');
	click(s, 'ra');
	assert.equal(s.status(), 'correct');
});

test('boards that live in a file load later and never inline their SGF', () => {
	const s = make('sgf: [[games/x.sgf]]\nmove: 2');
	assert.equal(s.ready, false);
	assert.equal(s.fileRef, '[[games/x.sgf]]');
	s.load('(;SZ[9];B[aa];W[bb];B[cc])');
	assert.equal(s.ready, true);
	assert.equal(moveOf(s.home), 'Wbb');
	s.setEdit(true);
	s.setComment('hello');
	assert.equal(s.blockBody(), 'sgf: [[games/x.sgf]]\nmove: 2');
	assert.equal(s.gameText(), '(;SZ[9];B[aa];W[bb]C[hello];B[cc])');
	// reloading after an outside change keeps our place
	s.reload('(;SZ[9];B[aa];W[bb]C[changed];B[cc];W[dd])');
	assert.equal(moveOf(s.cur), 'Wbb');
	assert.equal(getText(s.cur, 'C'), 'changed');
	assert.equal(s.edit, true);
});

test('what a change dirties: comments do not redraw the tree, header undo does not touch the game', () => {
	const s = make('sgf: x.sgf');
	s.load('(;SZ[9]AB[cc]AW[dd];B[ee])');
	s.setEdit(true);
	s.next();
	let rev = s.treeRev;
	s.setComment('a');
	assert.equal(s.treeRev, rev + 1); // a comment appeared
	rev = s.treeRev;
	s.setComment('ab');
	s.setComment('abc');
	assert.equal(s.treeRev, rev);
	s.setComment('Wrong.'); // ...unless it changes a verdict
	assert.equal(s.treeRev, rev + 1);
	assert.equal(s.dirtyTree, true);
	s.dirtyTree = false;
	s.setCrop({ x0: 0, y0: 0, x1: 4, y1: 4 });
	assert.equal(s.dirtyTree, false);
	assert.equal(s.dirtyHeader, true);
	s.dirtyHeader = false;
	s.setComment('typed after the crop');
	s.dirtyTree = false; // (as if it had been saved to the file)
	s.undo(); // takes the comment back
	s.undo(); // takes the crop back: the game is not touched...
	assert.equal(s.dirtyHeader, true);
	assert.equal(s.opts.view, undefined);
	s.redo();
	s.redo(); // ...so nothing typed since is lost
	assert.equal(getText(s.cur, 'C'), 'typed after the crop');
	assert.equal(s.opts.view, 'A5-E9');
});

test('captions and comments', () => {
	const s = make('caption: Problem 1\n(;SZ[9]AB[aa]AW[bb]C[root comment];B[cc]C[after])');
	assert.equal(s.model().text, 'Problem 1');
	s.next();
	assert.equal(s.model().text, 'after');
	const q = make('(;SZ[9]AB[aa]AW[bb]C[root comment];B[cc]C[after])', { showComments: false });
	assert.equal(q.model().text, '');
	const r = make('comments: on\n(;SZ[9]AB[aa]AW[bb]C[root comment])', { showComments: false });
	assert.equal(r.model().text, 'root comment');
	const t = make('comments: off\n(;SZ[9]AB[aa]AW[bb]C[root comment])');
	assert.equal(t.model().text, '');
});

test('change notifications fire once per action', () => {
	const s = make(PROBLEM);
	let n = 0;
	const fn = () => n++;
	s.on(fn);
	click(s, 'sb'); // move + immediate reply
	assert.equal(n, 2);
	s.reset();
	assert.equal(n, 3);
	s.off(fn);
	s.next();
	assert.equal(n, 3);
});

test('a session remembers what it wrote lately, so a block drawn from it can be handed back', () => {
	const s = make('(;SZ[9]AB[cc])');
	assert.equal(s.lastWrite, 0);
	assert.equal(s.wroteAt('(;SZ[9]AB[cc])', 0), 0); // text it was made from is not text it wrote
	const first = s.expecting('(;SZ[9]\n AB[cc][dd])\n', 1000);
	s.expecting('(;SZ[9]AB[cc][dd][ee])', 2000);
	assert.equal(s.lastWrite, 2000);
	// white space does not matter, time does
	assert.equal(s.wroteAt('(;SZ[9]AB[cc][dd])', 500), 1000);
	assert.equal(s.wroteAt('(;SZ[9]AB[cc][dd])', 1500), 0);
	assert.equal(s.wroteAt('(;SZ[9]AB[cc][dd][ee])', 1500), 2000);
	// the same text written again later counts from the later time
	s.expecting('(;SZ[9]AB[cc][dd])', 3000);
	assert.equal(s.wroteAt('(;SZ[9]AB[cc][dd])', 1500), 3000);
	// a write that failed is taken back
	s.written.splice(s.written.indexOf(first), 1);
	assert.equal(s.wroteAt('(;SZ[9]AB[cc][dd])', 500), 3000);
	// the record stays short
	for (let i = 0; i < 40; i++) s.expecting('x' + i, 4000 + i);
	assert.ok(s.written.length <= 12);
	assert.equal(s.lastWrite, 4039);
});

test('changing only an option leaves the game text exactly as it was written', () => {
	// odd spacing, a long line, lower-case letters in a property name: all legal, none of it ours to tidy
	const game = '( ;SiZe[9]  AB[cc]\n\n   AW[gg] C[' + 'long '.repeat(30) + '] ;B[dd] )';
	const s = make('scale: 0.8\n' + game);
	assert.equal(s.error, '');
	assert.equal(s.w, 9);
	s.setEdit(true);
	s.setCrop({ x0: 0, y0: 0, x1: 8, y1: 4 });
	assert.equal(s.blockBody(), 'scale: 0.8\nview: A5-J9\n' + game);
	s.wrote(s.blockBody());
	s.dirtyHeader = false;
	s.setFigure(true);
	assert.equal(s.blockBody(), 'scale: 0.8\nview: A5-J9\nnumbers: on\n' + game);
	s.wrote(s.blockBody());
	s.dirtyHeader = false;
	// undoing an option change does not touch it either
	s.undo();
	assert.equal(s.dirtyTree, false);
	assert.equal(s.blockBody(), 'scale: 0.8\nview: A5-J9\n' + game);
	s.wrote(s.blockBody());
	s.dirtyHeader = false;
	// once the game itself changes it is written out afresh
	s.setTool('black');
	click(s, 'ee');
	assert.equal(s.dirtyTree, true);
	const out = s.blockBody();
	assert.ok(out.startsWith('scale: 0.8\nview: A5-J9\n(;SZ[9]AB[cc][ee]AW[gg]C[long long'), out);
	assert.equal(parseSgf(out.slice(out.indexOf('(')))[0].children.length, 1);
});

test('numbers while editing: every move shows its place; locked, only what is played from the resting position', () => {
	// a record: at rest no numbers, in edit mode 1, 2, 3
	const s = make('(;SZ[9];B[ee];W[cc];B[gg])');
	assert.equal(s.model().labels.size, 0);
	s.setEdit(true);
	assert.equal(label(s, 'ee'), '1');
	assert.equal(label(s, 'gg'), '3');
	click(s, 'aa');
	assert.equal(label(s, 'aa'), '4');
	s.setEdit(false);
	assert.equal(s.model().labels.size, 0);
	// a position with a line saved from it: the same either way
	const p = make('(;SZ[9]AB[cc]AW[gg];B[dd];W[ee])');
	p.setEdit(true);
	p.last();
	assert.equal(label(p, 'dd'), '1');
	assert.equal(label(p, 'ee'), '2');
	p.setEdit(false);
	click(p, 'dd');
	assert.equal(label(p, 'dd'), '1');
	// "move: 2" rests after move 2: playing on counts from 1, editing shows the real numbers
	const m = make('move: 2\n(;SZ[9];B[aa];W[bb];B[cc])');
	assert.equal(m.model().labels.size, 0);
	m.next();
	assert.equal(label(m, 'cc'), '1');
	m.setEdit(true);
	assert.equal(label(m, 'cc'), '3');
	assert.equal(label(m, 'aa'), '1');
	// switched off in the settings: no numbers in either state
	const off = make('(;SZ[9];B[ee];W[cc])', { numberPlayed: false });
	off.setEdit(true);
	assert.equal(off.model().labels.size, 0);
	// an explicit figure keeps its own numbering while editing
	const f = make('numbers: 2-3 from 7\n(;SZ[9];B[aa];W[bb];B[cc])');
	f.setEdit(true);
	assert.equal(label(f, 'aa'), undefined);
	assert.equal(label(f, 'bb'), '7');
});

test('a problem keeps its saved lines out of sight until asked, or until it is being edited', () => {
	const s = make(PROBLEM);
	let n = 0;
	s.on(() => n++);
	assert.equal(s.concealed, true);
	click(s, 'sb');
	assert.equal(s.concealed, true); // playing does not change that, nor does finishing the line
	click(s, 'ra');
	assert.equal(s.status(), 'correct');
	assert.equal(s.concealed, true);
	n = 0;
	s.setReveal(true);
	assert.equal(n, 1);
	assert.equal(s.concealed, false);
	s.setReveal(true);
	assert.equal(n, 1);
	// a fresh try hides them again
	s.reset();
	assert.equal(s.concealed, true);
	// editing shows everything; locking starts over
	s.setEdit(true);
	assert.equal(s.concealed, false);
	s.setReveal(true);
	s.setEdit(false);
	assert.equal(s.concealed, true);
	// nothing to hide on a board that is not a problem, or when the setting says so
	assert.equal(make('(;SZ[9];B[ee];W[cc])').concealed, false);
	assert.equal(make('problem: no\n' + PROBLEM).concealed, false);
	assert.equal(make(PROBLEM, { hideAnswers: false }).concealed, false);
});

test('blocks the plugin will not edit, or not show: no game where one is asked for, a game cut short', () => {
	// "game: 2" in a block that holds no game at all: nothing to show, and nothing gets appended
	let s = make('game: 2');
	assert.match(s.error, /holds no game yet/);
	s = make('game: 3\n(;SZ[9]AB[cc])');
	assert.match(s.error, /holds 1 game; there is no game 3/);
	// a remark with a parenthesis that is never closed does not hide the game after it
	s = make('(note: see below\n(;SZ[9]AB[cc])');
	assert.equal(s.error, '');
	assert.equal(s.w, 9);
	s.setEdit(true);
	s.setTool('black');
	click(s, 'ee');
	assert.equal(s.blockBody(), '(note: see below\n(;SZ[9]AB[cc][ee])');
	s.wrote(s.blockBody());
	s.dirtyTree = false;
	click(s, 'gg');
	assert.equal(s.blockBody(), '(note: see below\n(;SZ[9]AB[cc][ee][gg])'); // (not appended a second time)
	// a game that is never closed can be looked at, but what follows it is not ours to swallow
	s = make('(;SZ[9]AB[cc]\nsome notes kept below');
	assert.equal(s.error, '');
	assert.equal(stone(s, 'cc'), 1);
	assert.match(s.cantEdit, /no closing parenthesis/);
	s.setEdit(true);
	assert.equal(s.edit, false);
	// a reason that comes from where the board is shown is not wiped out by what its file says
	s = make('(;SZ[9]AB[cc])');
	s.fixed = 'not here';
	s.readOnly = '';
	assert.equal(s.cantEdit, 'not here');
	s.setEdit(true);
	assert.equal(s.edit, false);
});

test('figure switch: what the numbers line said before comes back', () => {
	const s = make('numbers: off\n(;SZ[9];B[aa];W[bb])');
	s.setEdit(true);
	s.setFigure(true);
	assert.deepEqual(s.header, ['numbers: on']);
	s.setFigure(false);
	assert.deepEqual(s.header, ['numbers: off']);
	// a range written by hand comes back when the figure is switched on again
	const r = make('numbers: 2-2 from 5\n(;SZ[9];B[aa];W[bb])');
	r.setEdit(true);
	r.setFigure(false);
	assert.deepEqual(r.header, []);
	r.setFigure(true);
	assert.deepEqual(r.header, ['numbers: 2-2 from 5']);
});

test('undo and redo keys on a locked board only take back, and make again, what was done on it', () => {
	const s = make(PROBLEM);
	s.stepBack(); // nothing done yet: nothing happens
	assert.equal(s.cur, s.home);
	s.stepForth(); // (and it does not walk into the saved answer)
	assert.equal(s.cur, s.home);
	click(s, 'aa'); // a move of one's own
	assert.equal(s.cur.temp, true);
	s.stepBack();
	assert.equal(s.cur, s.home);
	s.stepForth();
	assert.equal(s.cur.temp, true);
	s.stepBack();
	s.stepBack(); // back at the start, with the scratch move still in the tree: one more step is possible, and harmless
	s.reset();
	assert.equal(s.cur, s.home);
	assert.equal(s.moved, false);
});
