// Whose block is it? Scenarios about boards that read the same, panes that are behind,
// drawings a renderer moves about, and edits that could not be written: everything
// where an edit might land in another block than the one its board stands on, come
// back from the dead, or vanish without a word. (Most were found by an independent
// review; each one failed before the fix it stands for.)
import assert from 'node:assert/strict';
import {
	chromium, runner, clickPoint, sleep, text, doc, notices, cap, stones, tool, boardCount, isEditing, toggleLock,
} from './lib.mjs';

const browser = await chromium.launch();
const { scenario, report } = runner(browser);

const blocks = (t) => [...t.matchAll(/```kifu\n([\s\S]*?)```/g)].map((m) => m[1].trim());
const filler = (n) => Array.from({ length: n }, (_, i) => `filler paragraph ${i + 1}`).join('\n\n');
const note = (...bodies) => '# N\n\n' + bodies.map((b) => '```kifu\n' + b + '\n```').join('\n\nbetween\n\n') + '\n\nend\n';
const setCursor = (page, line, ch = 0) => page.evaluate(([line, ch]) => window.harness.views[0].editor.setCursor({ line, ch }), [line, ch]);
const scrollNote = (page, top) => page.evaluate((top) => { const sc = document.querySelector('.cm-scroller'); sc.scrollTop = top < 0 ? sc.scrollHeight : top; }, top);
const focusBoard = (page, i) => page.evaluate((i) => document.querySelectorAll('.kifu')[i].focus({ preventScroll: true }), i);
/** A tool of the nth board's own toolbar. */
const toolOn = (page, board, name) => page.locator('.kifu').nth(board).locator(`.kifu-tools .kifu-btn[aria-label^="${name}"]`);
const readingPane = (page, path, noLines = false) =>
	page.evaluate(([path, noLines]) => {
		const h = window.harness;
		h.app._noSectionInfo = noLines;
		h.views.push(h.app.workspace._open(path, 'preview'));
	}, [path, noLines]);
/** The first write to the note fails, as when a sync program has the file locked. */
const failOnce = (page) =>
	page.evaluate(() => {
		const v = window.harness.app.vault;
		const real = v.process.bind(v);
		let failed = false;
		v.process = async (...a) => {
			if (!failed) {
				failed = true;
				throw new Error('EBUSY: resource busy or locked');
			}
			return real(...a);
		};
	});

const X = '(;SZ[9]AB[cc])';
const Y = '(;SZ[9]AB[cc][dd])';

/* ------------------------------------------------- a board that is given a session by its text */

/* Twins far apart, so that only one is on the page. The first is edited and the edit taken back:
   it reads like its twin again, and has "just written" that text when the twin scrolls into view. */
const FAR = 'intro\n\n```kifu\n' + X + '\n```\n\n' + filler(300) + '\n\n```kifu\n' + X + '\n```\n\nend\n';
for (const then of ['nothing more', 'redo pressed on the twin', 'a comment typed in the panel']) {
	await scenario(`twins far apart: one is edited and the edit undone, the other scrolled to at once; then ${then}`, { files: { 'T.md': FAR }, live: ['T.md'], autosave: 150 }, async (page) => {
		await toggleLock(page);
		await sleep(150);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		await page.keyboard.press('Control+z'); // the board has the keyboard: its own undo
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), [X, X]);
		await scrollNote(page, -1);
		await sleep(400);
		assert.equal(await boardCount(page), 1); // the twin; the first board is far above
		// nobody unlocked the twin
		assert.deepEqual(await isEditing(page), [false]);
		if (then.startsWith('redo')) {
			await focusBoard(page, 0);
			await page.keyboard.press('Control+Shift+z');
			await sleep(700);
		} else if (then.startsWith('a comment')) {
			// The panel is the one the first board opened. If it still shows that board, what
			// is typed there is about the first board, and goes into the first block.
			const box = page.locator('.kifu-p-comment');
			if (await box.isVisible()) {
				await box.click();
				await page.keyboard.type('about the first board', { delay: 5 });
				await sleep(900);
				assert.match(blocks(await doc(page))[0], /about the first board/);
			}
		}
		assert.equal(blocks(await doc(page))[1], X);
		assert.deepEqual(await notices(page), []);
	});
}

/* An OLDER text of ours: the far block reads what the first board wrote one write ago. */
const FAR2 = 'intro\n\n```kifu\n' + X + '\n```\n\n' + filler(300) + '\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nend\n';
await scenario('a far block that reads what the first board wrote one write ago, scrolled to at once', { files: { 'T.md': FAR2 }, live: ['T.md'], autosave: 60000 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee][gg])', '(;SZ[9]AB[cc][ee])']);
	await scrollNote(page, -1);
	await sleep(1500);
	// its board shows its own two stones, not the first board's three, and is locked
	assert.deepEqual([await stones(page), await isEditing(page)], [{ black: 2, white: 0 }, [false]]);
});

/* A copy of a block, and the original then changed by hand: the session the original left behind
   knew it as "the only block" from before the copy existed. */
const PLAIN = '# N\n\ntext\n\n```kifu\n' + X + '\n```\n\nend\n';
for (const wait of [5600, 300]) {
	await scenario(`a copy of a block does not inherit the original's session when the original is changed by hand [${wait} ms after the board's last write]`, { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150, height: 1300 }, async (page) => {
		await toggleLock(page);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee])');
		await sleep(wait);
		// a copy of the block is pasted at the end of the note: a board of its own, locked
		await page.evaluate(() => {
			const ed = window.harness.views[0].editor;
			ed.replaceRange('\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n', { line: ed.lineCount(), ch: 0 });
		});
		await sleep(100);
		assert.deepEqual(await isEditing(page), [true, false]);
		// the original gets a caption, typed by hand: a different text, so a different (locked) board
		await page.evaluate(() => window.harness.views[0].editor.replaceRange('caption: the original\n', { line: 5, ch: 0 }));
		await sleep(100);
		assert.deepEqual(await isEditing(page), [false, false]);
		// the copy is drawn again (the cursor passes through its block)
		await setCursor(page, (await doc(page)).split('\n').lastIndexOf('(;SZ[9]AB[cc][ee])'), 0);
		await sleep(100);
		assert.equal(await boardCount(page), 1);
		await setCursor(page, 0, 0);
		await sleep(100);
		assert.deepEqual(await isEditing(page), [false, false]);
		// undo with the keyboard on the copy's board: nothing was ever done on that board
		await focusBoard(page, 1);
		await page.keyboard.press('Control+z');
		await sleep(700);
		assert.equal(blocks(await doc(page))[1], '(;SZ[9]AB[cc][ee])');
	});
}

/* A renderer that puts new sections on the page a little after it made them: the board that is
   asked where it stands must be asked again once it is there. */
await scenario('a reading view whose sections reach the page 30 ms late: a copy of a block that was just written', { files: { 'N.md': note(X) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, height: 1400 }, async (page) => {
	await page.evaluate(() => {
		const r = window.harness.views[0].renderer;
		const make = r.make.bind(r);
		r.make = (sec) => {
			const x = make(sec);
			if (sec.type !== 'code') return x;
			const real = x.el;
			x.el = document.createElement('div');
			setTimeout(() => x.el.appendChild(real), 30);
			return x;
		};
	});
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(blocks(await text(page, 'N.md'))[0], '(;SZ[9]AB[cc][ee])');
	assert.deepEqual(await isEditing(page), [true]);
	// a copy of the block arrives at the end of the note (another program; a paste would do the same)
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		return v.modify(v.getAbstractFileByPath('N.md'), v.files.get('N.md').data + '\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n');
	});
	await sleep(300);
	assert.deepEqual(await isEditing(page), [true, false]);
	await focusBoard(page, 1);
	await page.keyboard.press('Control+z');
	await sleep(700);
	assert.deepEqual(blocks(await text(page, 'N.md')), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc][ee])']);
});

/* ------------------------------------------------- a renderer that keeps drawings by their text */

/* Three boards that read the same. When the first is written, such a renderer gives every later
   twin the drawing of the twin before it: a drawing with an edit not yet written is moved on. */
const THREE = note(X, X, X);
for (const mode of ['preview', 'source']) {
	await scenario(`three identical boards (${mode}): a stone on the first, then one on the second before the first is written`, { files: { 'T.md': THREE }, panes: [{ path: 'T.md', mode }], autosave: 100, height: 1900 }, async (page) => {
		await toggleLock(page, 0);
		await toggleLock(page, 1);
		await tool(page, 'Black stone', 0).click();
		await tool(page, 'White stone', 1).click();
		await clickPoint(page, 0, 'ee'); // written 400 ms from now
		await sleep(150);
		await clickPoint(page, 1, 'gg'); // written 150 ms after that
		await sleep(1200);
		assert.deepEqual(blocks(await text(page, 'T.md')), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc]AW[gg])', X]);
		assert.deepEqual(await notices(page), []);
	});
}

await scenario('three identical boards: the second is unlocked, then the first is edited', { files: { 'T.md': THREE }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1900 }, async (page) => {
	await toggleLock(page, 1);
	assert.deepEqual(await isEditing(page), [false, true, false]);
	await toggleLock(page, 0);
	await tool(page, 'Black stone', 0).click();
	await clickPoint(page, 0, 'ee');
	await sleep(900);
	// (the second may or may not still be unlocked) the third must not have become so
	const editing = await isEditing(page);
	assert.deepEqual([editing[0], editing[2]], [true, false]);
});

/* ------------------------------------------------- a pane that is behind the editor */

const lagging = { live: ['T.md'], autosave: 60000, lagReading: true, width: 1700, height: 1500 };

/* The count of blocks reading a text is no witness: one block stops reading it, another starts to. */
for (const lines of ['with', 'WITHOUT']) {
	await scenario(`a pane that is behind, ${lines} line numbers: block 0 is edited, block 1 made to read what block 0 read, then the stale board of block 0 is used`, { files: { 'T.md': note(X, Y) }, ...lagging }, async (page) => {
		await readingPane(page, 'T.md', lines === 'WITHOUT');
		await sleep(100);
		assert.equal(await boardCount(page), 4); // 0, 1: the editor; 2, 3: the reading pane
		// editor, block 1: the stone at dd comes off, so that it reads X
		await toggleLock(page, 1);
		await tool(page, 'Eraser', 0).click();
		await clickPoint(page, 1, 'dd');
		await sleep(700);
		// editor, block 0: a stone at ee
		await toggleLock(page, 0);
		await tool(page, 'Black stone', 0).click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
		// the reading pane has seen none of this. Its board of block 0 (which shows X): unlock, a stone
		assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [1, 2]);
		await toggleLock(page, 2);
		await tool(page, 'Black stone', 2).click();
		await clickPoint(page, 2, 'gg');
		await sleep(900);
		// refused, and said so: block 1 is the one that reads X now, and it is not that board's block
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
		assert.equal((await notices(page)).length, 1);
	});
}

await scenario('a pane that is behind: twins; inside one lag block 0 is edited and block 1 goes back to what it read; then the stale board of block 0 is used', { files: { 'T.md': note(X, X) }, ...lagging }, async (page) => {
	await readingPane(page, 'T.md');
	await sleep(100);
	// editor, block 1: a stone at dd; then the note is saved and the reading pane catches up
	await toggleLock(page, 1);
	await tool(page, 'Black stone', 0).click();
	await clickPoint(page, 1, 'dd');
	await sleep(700);
	await page.evaluate(() => window.harness.views[0].save());
	await sleep(200);
	assert.deepEqual(blocks(await text(page, 'T.md')), [X, Y]);
	assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [1, 2]);
	// inside one lag: block 0 gets ee, and block 1's board undoes its stone
	await toggleLock(page, 0);
	await tool(page, 'Black stone', 0).click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	await focusBoard(page, 1);
	await page.keyboard.press('Control+z');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
	// the reading pane still shows block 0 as X: that board is used
	if (!(await isEditing(page))[2]) await toggleLock(page, 2);
	await tool(page, 'White stone', 2).click();
	await clickPoint(page, 2, 'gg');
	await sleep(900);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
	assert.equal((await notices(page)).length, 1);
});

/* The note gains a block while an edit is waiting: every place after it moves on by one. */
await scenario('a block is typed in above while a board has an edit waiting (live preview)', { files: { 'N.md': note(X, X) }, live: ['N.md'], autosave: 150, height: 1600 }, async (page) => {
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	// within the save delay, another block appears at the top of the note
	await page.evaluate(() => window.harness.views[0].editor.replaceRange('```kifu\nsize: 9\n```\n\n', { line: 0, ch: 0 }));
	await sleep(900);
	// the board is still on its block, and says so: the stone goes where it was put
	assert.deepEqual(blocks(await doc(page)), ['size: 9', X, '(;SZ[9]AB[cc][ee])']);
	assert.deepEqual(await notices(page), []);
});

await scenario('a pane that is behind: a block is added in the editor, and a board of the reading pane is edited before the pane has seen it', { files: { 'T.md': note(X, Y) }, ...lagging }, async (page) => {
	await readingPane(page, 'T.md');
	await sleep(100);
	await toggleLock(page, 3); // the reading pane's board of the second block
	await page.evaluate(() => {
		const ed = window.harness.views[0].editor;
		ed.replaceRange('```kifu\nsize: 9\n```\n\n', { line: 0, ch: 0 });
		ed.setCursor({ line: ed.lineCount() - 1, ch: 0 }); // (out of the new block, so that its board is drawn)
	});
	await sleep(150);
	assert.equal(await boardCount(page), 5); // three in the editor now, still two in the reading pane
	await tool(page, 'Black stone').click();
	await clickPoint(page, 4, 'gg');
	await sleep(900);
	// The pane counts two blocks, the note has three. But everything from the board's block
	// on reads as it did, so the block is the same one, one further down.
	assert.deepEqual(blocks(await doc(page)), ['size: 9', X, '(;SZ[9]AB[cc][dd][gg])']);
	assert.deepEqual(await notices(page), []);
});

/* An edit that was refused is over. It must not travel on with its drawing. */
await scenario("a stale board's edit is refused; the pane catches up and its drawing lands on the twin; one more stone there", { files: { 'T.md': note(X, X) }, ...lagging }, async (page) => {
	await readingPane(page, 'T.md');
	await sleep(100);
	// editor: the first block gets a stone
	await toggleLock(page, 0);
	await tool(page, 'Black stone', 0).click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
	// reading pane (which has seen none of it): a white stone on ITS board of the first block
	await toggleLock(page, 2);
	await tool(page, 'White stone', 1).click();
	await clickPoint(page, 2, 'gg');
	await sleep(700);
	assert.equal((await notices(page)).length, 1);
	assert.match((await notices(page))[0], /changed or removed|no longer certain/);
	// ...and the board stops showing it: it is back to what it was drawn from, and locked
	assert.deepEqual([await stones(page, 2), (await isEditing(page))[2]], [{ black: 1, white: 0 }, false]);
	// the note is saved; the reading pane follows
	await page.evaluate(() => window.harness.views[0].save());
	await sleep(300);
	assert.deepEqual([await stones(page, 2), await stones(page, 3)], [{ black: 2, white: 0 }, { black: 1, white: 0 }]);
	// the second board of the reading pane: one stone
	if (!(await isEditing(page))[3]) await toggleLock(page, 3);
	await tool(page, 'Black stone', (await isEditing(page)).slice(0, 3).filter(Boolean).length).click();
	await clickPoint(page, 3, 'aa');
	await sleep(900);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc][aa])']);
});

/* ------------------------------------------------- the note is rearranged while a board is in use */

const P = '(;SZ[9]AB[aa])';
const Q = '(;SZ[9]AB[ii])';
/** Cut the first block (with the text after it) and put a block at the end of the note: two edits, as a hand would make them. */
const firstToEnd = (page, body) =>
	page.evaluate((body) => {
		const ed = window.harness.views[0].editor;
		ed.replaceRange('', { line: 2, ch: 0 }, { line: 8, ch: 0 });
		ed.replaceRange('\n```kifu\n' + body + '\n```\n', { line: ed.lineCount(), ch: 0 });
	}, body);
const roomy = { live: ['N.md'], autosave: 60000, height: 2000 };

/* As many blocks as before, and every one in another place. In an editor the board moves with its block. */
await scenario('three different boards: the first is moved to the end while the second is unlocked, then a stone', { files: { 'N.md': note(P, X, Q) }, ...roomy }, async (page) => {
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), [P, '(;SZ[9]AB[cc][ee])', Q]);
	await firstToEnd(page, P);
	await sleep(200);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', Q, P]);
	// the board that was unlocked all along is the first on the page now: one more stone
	assert.deepEqual(await isEditing(page), [true, false, false]);
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee][gg])', Q, P]);
	assert.deepEqual([await isEditing(page), await notices(page)], [[true, false, false], []]);
});

await scenario('three different boards: an edit is waiting when a block moves from above the board to below it', { files: { 'N.md': note(P, X, Q) }, ...roomy }, async (page) => {
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee'); // written 400 ms from now
	await firstToEnd(page, P);
	await sleep(900);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', Q, P]);
	assert.deepEqual(await notices(page), []);
});

await scenario('three identical boards: a stone on the second is waiting when the first is cut and another added at the end', { files: { 'N.md': note(X, X, X) }, ...roomy }, async (page) => {
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee'); // written 400 ms from now
	await firstToEnd(page, X);
	await sleep(900);
	// the board that got the stone is the first now, and its block is where the stone goes
	assert.deepEqual([await stones(page, 0), await stones(page, 1), await stones(page, 2)].map((s) => s.black), [2, 1, 1]);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X, X]);
	assert.deepEqual(await notices(page), []);
});

await scenario('three identical boards: the second is unlocked with something to redo; the first is deleted and another added at the end', { files: { 'N.md': note(X, X, X) }, ...roomy }, async (page) => {
	// the second board: a stone, and its undo (so that it reads like the others again)
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	await sleep(700);
	await page.keyboard.press('Control+z');
	await sleep(6000); // (well past the time in which a text "was written a moment ago")
	assert.deepEqual(blocks(await doc(page)), [X, X, X]);
	await firstToEnd(page, X);
	await sleep(200);
	// the user goes on with the board they unlocked, now first on the page: it is still theirs
	await page.locator('.kifu').nth(0).click({ position: { x: 5, y: 5 } });
	await sleep(100);
	assert.deepEqual(await isEditing(page), [true, false, false]);
	// the next board down, which nobody touched, is drawn again (the cursor passes through its block)
	const lines = (await doc(page)).split('\n');
	await setCursor(page, lines.indexOf(X, lines.indexOf(X) + 1), 0);
	await sleep(100);
	await setCursor(page, 0, 0);
	await sleep(200);
	assert.deepEqual(await isEditing(page), [true, false, false]);
	// redo on that board: nothing was ever done on it
	await focusBoard(page, 1);
	await page.keyboard.press('Control+Shift+z');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), [X, X, X]);
	// ...while on the first it puts the stone back
	await focusBoard(page, 0);
	await page.keyboard.press('Control+Shift+z');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X, X]);
});

/* A block more or less elsewhere in the note is no reason to forget a board, or to refuse its edit. */
await scenario('a board is unlocked, another board is inserted below, and the cursor passes through the first block', { files: { 'N.md': note(X) }, live: ['N.md'], autosave: 60000, height: 1600 }, async (page) => {
	await toggleLock(page, 0);
	await page.evaluate(() => { const ed = window.harness.views[0].editor; ed.replaceRange('\n```kifu\n```\n', { line: ed.lineCount(), ch: 0 }); });
	await sleep(150);
	assert.equal(await boardCount(page), 2);
	await setCursor(page, 3, 0);
	await sleep(100);
	await setCursor(page, 0, 0);
	await sleep(200);
	assert.deepEqual(await isEditing(page), [true, false]);
});

await scenario('a comment is typed in the panel for a board out of sight while another program adds a board to the note', {
	files: { 'N.md': 'intro\n\n```kifu\n(;SZ[9]AB[cc];B[dd])\n```\n\n' + filler(300) + '\n\nend\n' }, live: ['N.md'], autosave: 150,
}, async (page) => {
	await toggleLock(page);
	await sleep(150);
	const box = page.locator('.kifu-p-comment');
	await box.click();
	await page.keyboard.type('First sentence. ', { delay: 10 });
	await scrollNote(page, 9000);
	await sleep(700);
	assert.equal(await boardCount(page), 0);
	await page.evaluate(() => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('N.md'), window.harness.views[0].data + '\n```kifu\n```\n'); });
	await sleep(300);
	await page.keyboard.type('Second sentence.', { delay: 10 });
	await sleep(900);
	assert.match(blocks(await doc(page))[0], /C\[First sentence\. Second sentence\.\]/);
	assert.deepEqual([await notices(page), await box.isVisible()], [[], true]);
});

for (const reuse of ['ends', 'pool']) {
	await scenario(`no line numbers, a board with text of its own: a block is added elsewhere after the board's first write [renderer keeps drawings: ${reuse}]`, { files: { 'T.md': note(X, P) }, panes: [], autosave: 100, height: 1700, reuse }, async (page) => {
		await page.evaluate(() => { const h = window.harness; h.app._noSectionInfo = true; h.views = [h.app.workspace._open('T.md', 'preview')]; });
		await sleep(60);
		await toggleLock(page, 0);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		assert.equal(blocks(await text(page, 'T.md'))[0], '(;SZ[9]AB[cc][ee])');
		// another program appends a third board to the note; the first two blocks are as they were
		await page.evaluate(() => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('T.md'), v.files.get('T.md').data + '\n```kifu\n(;SZ[9]AB[ii])\n```\n'); });
		await sleep(300);
		for (const pt of ['gg', 'hh']) {
			if (!(await isEditing(page))[0]) await toggleLock(page, 0);
			await tool(page, 'Black stone').click();
			await clickPoint(page, 0, pt);
			await sleep(900);
		}
		assert.deepEqual(blocks(await text(page, 'T.md')), ['(;SZ[9]AB[cc][ee][gg][hh])', P, Q]);
		assert.deepEqual(await notices(page), []);
	});
}

/* A sync delivers the note with its identical blocks in another order while a write is being
   tried again. Which block is "the same one" is not a question the text can answer; what has to
   hold is that the stone ends up in the block whose board shows it, and in no other. */
await scenario('three identical boards: a write is waiting to be tried again when the note comes back rearranged', { files: { 'T.md': note(X, X, X) }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1900, allowErrors: /writing the note failed|EBUSY/ }, async (page) => {
	await failOnce(page);
	await toggleLock(page, 1);
	await tool(page, 'White stone').click();
	await clickPoint(page, 1, 'gg');
	await sleep(700);
	assert.match((await notices(page))[0], /could not be written/);
	await page.evaluate((t) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('T.md'), t); },
		'# N\n\n```kifu\n' + X + '\n```\n\nbetween\n\n```kifu\n' + X + '\n```\n\nend\n\n```kifu\n' + X + '\n```\n');
	await sleep(200);
	const showing = [await stones(page, 0), await stones(page, 1), await stones(page, 2)].map((s) => s.white);
	assert.equal(showing.reduce((a, b) => a + b), 1);
	await sleep(3300);
	assert.deepEqual(blocks(await text(page, 'T.md')).map((b) => (/AW\[gg\]/.test(b) ? 1 : 0)), showing);
	assert.equal((await notices(page)).length, 1);
});

/* A pane that says nothing about lines, and keeps drawings by their text. Our block is rewritten
   while another block reads what ours read until now: the pane draws ours afresh, and hands our
   old drawing to the other block. Nothing tells that drawing where it stands; it must still stop
   showing our block's state. */
for (const lag of [false, true]) {
	await scenario(`no line numbers, drawings kept by their text: the old drawing of a block that was rewritten lands on a block that reads what it read [the pane follows ${lag ? 'when the file is written' : 'at once'}]`, {
		files: { 'T.md': note(X, P) }, live: ['T.md'], autosave: 60000, lagReading: lag, width: 1700, height: 1500,
	}, async (page) => {
		const follow = async () => { if (lag) { await page.evaluate(() => window.harness.views[0].save()); await sleep(200); } };
		await readingPane(page, 'T.md', true);
		await sleep(100);
		assert.equal(await boardCount(page), 4); // 0, 1: the editor; 2, 3: the reading pane
		// the first block gets a stone, in the editor
		await toggleLock(page, 0);
		await toolOn(page, 0, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		await follow();
		assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [2, 1]);
		// the second block is made to read the same, by hand
		await page.evaluate(() => {
			const ed = window.harness.views[0].editor;
			const line = ed.getValue().split('\n').indexOf('(;SZ[9]AB[aa])');
			ed.replaceRange('(;SZ[9]AB[cc][ee])', { line, ch: 0 }, { line, ch: '(;SZ[9]AB[aa])'.length });
		});
		await sleep(300);
		await follow();
		assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [2, 2]);
		// one more stone on the first block, in the editor
		if (!(await isEditing(page))[0]) await toggleLock(page, 0);
		await toolOn(page, 0, 'Black stone').click();
		await clickPoint(page, 0, 'gg');
		await sleep(700);
		await follow();
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee][gg])', '(;SZ[9]AB[cc][ee])']);
		// the reading pane: each board shows its own block
		assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [3, 2]);
		assert.deepEqual(await notices(page), []);
	});
}

/* The same where the pane does not draw the rewritten block at all (it is far off the screen, say),
   so that nothing on the page shows the pane has moved on. Time has to tell. */
await scenario('no line numbers, drawings kept by their text: the old drawing lands on another block and the rewritten block is not drawn in that pane', {
	files: { 'T.md': note(X, P) }, live: ['T.md'], autosave: 60000, width: 1700, height: 1500,
}, async (page) => {
	await readingPane(page, 'T.md', true);
	await sleep(100);
	await toggleLock(page, 0);
	await toolOn(page, 0, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	await page.evaluate(() => {
		const ed = window.harness.views[0].editor;
		const line = ed.getValue().split('\n').indexOf('(;SZ[9]AB[aa])');
		ed.replaceRange('(;SZ[9]AB[cc][ee])', { line, ch: 0 }, { line, ch: '(;SZ[9]AB[aa])'.length });
	});
	await sleep(300);
	assert.deepEqual([await stones(page, 2), await stones(page, 3)].map((s) => s.black), [2, 2]);
	// from now on the reading pane leaves out any block that has a stone at gg
	await page.evaluate(() => {
		const r = window.harness.views[1].renderer;
		const make = r.make.bind(r);
		r.make = (sec) => make(sec.type === 'code' && sec.source.includes('[gg]') ? { ...sec, type: 'text' } : sec);
	});
	if (!(await isEditing(page))[0]) await toggleLock(page, 0);
	await toolOn(page, 0, 'Black stone').click();
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee][gg])', '(;SZ[9]AB[cc][ee])']);
	assert.equal(await boardCount(page), 3); // two in the editor, and the reading pane's board of the second block
	// That one is the drawing the first block left behind. Once the pane has had ample time
	// to replace it, it is taken for what it was drawn from, which is what its block reads.
	await sleep(5500);
	assert.equal((await stones(page, 2)).black, 2);
	// What it can not do is say which block it stands on: an edit there is refused rather than guessed at.
	if (!(await isEditing(page))[2]) await toggleLock(page, 2);
	await toolOn(page, 2, 'White stone').click();
	await clickPoint(page, 2, 'aa');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee][gg])', '(;SZ[9]AB[cc][ee])']);
	assert.match((await notices(page))[0], /no longer certain/);
});

/* ------------------------------------------------- a board's place is carried along with the note */

/* Three writes go into the note before the reading pane draws anything again. What its boards say
   about where they stand comes from the pane's copy, which is three changes old by the third. */
await scenario('a pane that is behind: its boards above and below a third are edited, then the one between them', { files: { 'T.md': note(P, X, Q) }, ...lagging }, async (page) => {
	await readingPane(page, 'T.md');
	await sleep(100);
	assert.equal(await boardCount(page), 6); // 0 to 2: the editor; 3 to 5: the reading pane
	for (const [board, pt] of [[3, 'ee'], [5, 'ff'], [4, 'gg']]) {
		await toggleLock(page, board);
		await toolOn(page, board, 'Black stone').click();
		await clickPoint(page, board, pt);
		await sleep(800);
	}
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[aa][ee])', '(;SZ[9]AB[cc][gg])', '(;SZ[9]AB[ii][ff])']);
	assert.deepEqual(await notices(page), []);
});

/* Typing here and there in the note is no reason for a board that was out of sight meanwhile to
   forget that it was unlocked. With the editor's change events it is known where the block has got
   to after each change; without them, a note that has changed both above and below the block is
   one where the board would rather start afresh than guess. */
const TALL = 'intro\n\n```kifu\n' + X + '\n```\n\n' + filler(300) + '\n\nend\n';
for (const events of ['all', 'own', 'none']) {
	await scenario(`a board is unlocked and scrolled out of sight; text is typed above it, then below; it is scrolled back to [the editor's change events: ${events}]`, { files: { 'N.md': TALL }, live: ['N.md'], lp: { editorChange: events }, autosave: 60000 }, async (page) => {
		await toggleLock(page);
		await sleep(100);
		await scrollNote(page, -1);
		await sleep(300);
		assert.equal(await boardCount(page), 0);
		await page.evaluate(() => window.harness.views[0].editor.replaceRange('typed above\n', { line: 0, ch: 0 }));
		await sleep(350);
		await page.evaluate(() => { const ed = window.harness.views[0].editor; ed.replaceRange('typed below\n', { line: ed.lineCount() - 1, ch: 0 }); });
		await sleep(350);
		await scrollNote(page, 0);
		await sleep(400);
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await isEditing(page), [events !== 'none']);
		// either way it is a board of its block: a stone goes where it should
		if (events === 'none') await toggleLock(page);
		await toolOn(page, 0, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])']);
		assert.match(await doc(page), /^typed above\nintro\n[\s\S]*\ntyped below\n$/);
		assert.deepEqual(await notices(page), []);
	});
}

/* The same with a twin further down: what was typed must not make the twin's board the unlocked one. */
await scenario('twins far apart: one is unlocked and scrolled out of sight, text is typed above it, the other comes into view', { files: { 'T.md': FAR }, live: ['T.md'], autosave: 60000 }, async (page) => {
	await toggleLock(page);
	await sleep(100);
	await page.evaluate(() => window.harness.views[0].editor.replaceRange('typed above\n', { line: 0, ch: 0 }));
	await sleep(350);
	await scrollNote(page, -1);
	await sleep(400);
	assert.equal(await boardCount(page), 1); // the twin
	assert.deepEqual(await isEditing(page), [false]);
	await scrollNote(page, 0);
	await sleep(400);
	assert.equal(await boardCount(page), 1); // the first again
	if (!(await isEditing(page))[0]) await toggleLock(page);
	await toolOn(page, 0, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', X]);
	assert.deepEqual(await notices(page), []);
});

/* Carrying a place along goes by the lines of the note, and lines can not tell twins apart: drag
   one twin below the other and the text reads as if only the paragraphs between them had traded
   places. So what was carried is never enough, among twins, to hand a board another board's state. */
const DRAG = 'intro\n\n```kifu\n' + X + '\n```\n\none\n\n```kifu\n' + X + '\n```\n\ntwo\n\nend\n';
await scenario('twins: the unlocked one is dragged below the other in one go; then the other board is drawn again', { files: { 'N.md': DRAG }, live: ['N.md'], autosave: 60000, height: 1700 }, async (page) => {
	await toggleLock(page, 0);
	await sleep(100);
	assert.deepEqual(await isEditing(page), [true, false]);
	// one change of the editor's: the first block and its paragraph go from above the second block to below it
	await page.evaluate(() => {
		const cm = window.harness.views[0].cm;
		const doc = cm.state.doc;
		const [from, to, at] = [doc.line(3).from, doc.line(9).from, doc.line(15).from];
		cm.dispatch({ changes: [{ from, to }, { from: at, insert: doc.sliceString(from, to) }] });
	});
	await sleep(400);
	assert.equal(await doc(page), 'intro\n\n```kifu\n' + X + '\n```\n\ntwo\n\n```kifu\n' + X + '\n```\n\none\n\nend\n');
	// the board that was never unlocked is first on the page now
	assert.equal((await isEditing(page))[0], false);
	// it is drawn again (the cursor passes through its block): still nobody has unlocked it
	await setCursor(page, 3, 0);
	await sleep(100);
	assert.equal(await boardCount(page), 1);
	await setCursor(page, 0, 0);
	await sleep(300);
	assert.equal((await isEditing(page))[0], false);
	// and whatever is done on the two boards from here goes into the block each stands on
	for (const [board, pt] of [[0, 'ee'], [1, 'gg']]) {
		if (!(await isEditing(page))[board]) await toggleLock(page, board);
		await toolOn(page, board, 'Black stone').click();
		await clickPoint(page, board, pt);
		await sleep(700);
	}
	assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc][gg])']);
	assert.deepEqual(await notices(page), []);
});

/* No editor anywhere: the note's file is what changes, and each writing of it is one change to follow. */
await scenario('a note is closed with a board left unlocked; another program adds a line above the board, then one below; the note is opened again', { files: { 'N.md': note(P, X, Q) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, height: 1900 }, async (page) => {
	await toggleLock(page, 1);
	await sleep(100);
	await page.evaluate(() => {
		const h = window.harness;
		h.app.workspace._leaves.find((l) => l.view === h.views[0]).detach();
		h.views = [];
	});
	await sleep(100);
	assert.equal(await boardCount(page), 0);
	const change = (fn) => page.evaluate((fn) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('N.md'), new Function('t', 'return ' + fn)(v.files.get('N.md').data)); }, fn);
	await change("'a new first line\\n' + t");
	await sleep(150);
	await change("t + 'a new last line\\n'");
	await sleep(150);
	await page.evaluate(() => { const h = window.harness; h.views = [h.app.workspace._open('N.md', 'preview')]; });
	await sleep(300);
	assert.deepEqual(await isEditing(page), [false, true, false]);
	await toolOn(page, 1, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	await sleep(700);
	assert.deepEqual(blocks(await text(page, 'N.md')), [P, '(;SZ[9]AB[cc][ee])', Q]);
	assert.deepEqual(await notices(page), []);
});

/* ------------------------------------------------- changes by hand that only touch white space */

const SPACE = '# N\n\ntext\n\n```kifu\n(;SZ[9]AB[cc]C[Whiteplays here])\n```\n\nend\n';
await scenario('a space typed by hand into the comment of an unlocked board (live preview)', { files: { 'N.md': SPACE }, live: ['N.md'], autosave: 150 }, async (page) => {
	assert.equal(await cap(page), 'Whiteplays here');
	await toggleLock(page);
	await sleep(100);
	await setCursor(page, 5, 0); // into the block: its source is shown
	await sleep(100);
	assert.equal(await boardCount(page), 0);
	await page.evaluate(() => window.harness.views[0].editor.replaceRange(' ', { line: 5, ch: '(;SZ[9]AB[cc]C[White'.length }));
	await setCursor(page, 0, 0);
	await sleep(150);
	assert.equal(await doc(page), SPACE.replace('Whiteplays', 'White plays'));
	// the board that comes back is a board of the text as it is now
	assert.equal(await cap(page), 'White plays here');
	if (!(await isEditing(page))[0]) await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee]C[White plays here])');
});

const CAPTION = '# N\n\ntext\n\n```kifu\ncaption: Blackto play\n(;SZ[9]AB[cc]AW[dd])\n```\n\nend\n';
await scenario('a space typed by hand into the caption line of an unlocked board, then the figure switch', { files: { 'N.md': CAPTION }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await sleep(100);
	await setCursor(page, 5, 0);
	await sleep(100);
	await page.evaluate(() => window.harness.views[0].editor.replaceRange(' ', { line: 5, ch: 'caption: Black'.length }));
	await setCursor(page, 0, 0);
	await sleep(150);
	assert.equal(await doc(page), CAPTION.replace('Blackto', 'Black to'));
	if (!(await isEditing(page))[0]) await toggleLock(page);
	await tool(page, 'When locked, show the moves').click();
	await sleep(700);
	assert.match(blocks(await doc(page))[0], /^caption: Black to play\n/);
});

await scenario('the file is changed from outside in white space only, under an unlocked board (reading view)', { files: { 'N.md': SPACE }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100 }, async (page) => {
	await toggleLock(page);
	await sleep(100);
	const fixed = SPACE.replace('Whiteplays', 'White plays');
	await page.evaluate((t) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('N.md'), t); }, fixed);
	await sleep(200);
	assert.equal(await cap(page), 'White plays here');
	if (!(await isEditing(page))[0]) await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.match(blocks(await text(page, 'N.md'))[0], /White plays here/);
});

await scenario('a pane that is behind: a space typed by hand in the editor, then the stale board in the reading pane is edited', { files: { 'N.md': SPACE }, live: ['N.md'], autosave: 60000, lagReading: true, width: 1600 }, async (page) => {
	await readingPane(page, 'N.md');
	await sleep(100);
	// (the hand edit is made without the cursor going into the block: find and replace, say)
	await page.evaluate(() => window.harness.views[0].editor.replaceRange(' ', { line: 5, ch: '(;SZ[9]AB[cc]C[White'.length }));
	await sleep(150);
	assert.equal(await boardCount(page), 2);
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	await sleep(700);
	// refused, and said so: the block is not what that board shows any more
	assert.equal(await doc(page), SPACE.replace('Whiteplays', 'White plays'));
	assert.match((await notices(page))[0], /changed or removed|no longer certain/);
});

/* ------------------------------------------------- writes that fail, and edits that are refused */

await scenario('a write fails; then the first of three identical boards is edited, and the drawings move on', { files: { 'T.md': THREE }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1900, allowErrors: /writing the note failed|EBUSY/ }, async (page) => {
	await failOnce(page);
	await toggleLock(page, 1);
	await tool(page, 'White stone', 0).click();
	await clickPoint(page, 1, 'gg');
	await sleep(700);
	assert.match((await notices(page))[0], /could not be written.*still on the board.*tried again/);
	// The first board is edited and written; a renderer that keeps drawings by their text hands
	// every later twin the drawing before it. The stone that is waiting belongs to the second block.
	await toggleLock(page, 0);
	await tool(page, 'Black stone', 0).click();
	await clickPoint(page, 0, 'ee');
	await sleep(3000); // (the write that failed is tried again by itself)
	assert.deepEqual(blocks(await text(page, 'T.md')), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc]AW[gg])', X]);
	assert.equal((await notices(page)).length, 1);
});

await scenario('switching the plugin off after a write that failed: the edit is written all the same', { files: { 'N.md': note(X) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, allowErrors: /writing the note failed|EBUSY/ }, async (page) => {
	await failOnce(page);
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.match((await notices(page))[0], /could not be written/);
	await page.evaluate(() => window.harness.plugin.unload());
	await sleep(500);
	assert.match(await text(page, 'N.md'), /AB\[cc\]\[ee\]/);
});

await scenario('Obsidian quits inside the save delay: the edit is written first', { files: { 'N.md': note(X) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	// (no waiting: the write is still 400 ms away) Obsidian asks everybody for last things to do, and waits for them
	await page.evaluate(async () => {
		const todo = [];
		window.harness.app.workspace.trigger('quit', { add: (fn) => todo.push(fn()), addPromise: (p) => todo.push(p), isEmpty: () => !todo.length, promise: () => Promise.all(todo) });
		await Promise.all(todo);
	});
	assert.match(await text(page, 'N.md'), /AB\[cc\]\[ee\]/);
});

await scenario('a write fails after its board has left the page: it is tried again, and the board that comes back shows the edit', { files: { 'N.md': note(X) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, allowErrors: /writing the note failed|EBUSY/ }, async (page) => {
	await failOnce(page);
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await page.evaluate(() => { const r = window.harness.views[0].renderer; window.__t = r.text; r.set(''); }); // every block leaves the page
	await sleep(800);
	assert.match((await notices(page))[0], /could not be written, so an edit is not saved yet. Saving will be tried again/);
	// the board comes back before the next try: it shows the stone that is still waiting
	await page.evaluate(() => window.harness.views[0].renderer.set(window.__t));
	await sleep(200);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	await sleep(2500);
	assert.match(await text(page, 'N.md'), /AB\[cc\]\[ee\]/);
	assert.equal((await notices(page)).length, 1);
});

/* The vault takes the write and is never heard of again (a network drive that has gone away). */
await scenario('a write that never comes back: after a while that is said, and the edit is written once the vault answers again', { files: { 'N.md': note(X) }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, allowErrors: /writing the note failed|no answer after/ }, async (page) => {
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		const real = v.process.bind(v);
		let hung = false;
		window.__late = null;
		v.process = (f, fn) => {
			if (hung) return real(f, fn);
			hung = true;
			// (no answer; but the request can still be let through later)
			return new Promise(() => { window.__late = () => real(f, fn); });
		};
	});
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(2000);
	// nothing yet: the write may just be slow. The stone is on the board.
	assert.deepEqual([await notices(page), await stones(page)], [[], { black: 2, white: 0 }]);
	await sleep(14000);
	assert.match((await notices(page))[0], /could not be written.*still on the board.*tried again/);
	// The request that got stuck goes through after all, now that nobody is waiting for it. It must
	// not write anything: the edit is the retry's to write, and may have grown since.
	await page.evaluate(() => window.__late());
	await sleep(100);
	assert.equal(await page.evaluate(() => window.harness.app.vault.writes.length), 0);
	await sleep(3000);
	assert.match(await text(page, 'N.md'), /AB\[cc\]\[ee\]/);
	assert.equal(await page.evaluate(() => window.harness.app.vault.writes.length), 1);
	assert.equal((await notices(page)).length, 1);
});

await scenario('two different boards lose an edit within five seconds: each says so', { files: { 'N.md': note(X, '(;SZ[9]AB[dd])') }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, height: 1400 }, async (page) => {
	const start = await text(page, 'N.md');
	await toggleLock(page, 0);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	// the first block is replaced from outside while that edit waits
	await page.evaluate((t) => { window.harness.app.vault.files.get('N.md').data = t; }, start.replace('AB[cc]', 'AB[aa]'));
	await sleep(1500);
	assert.equal((await notices(page)).length, 1);
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'gg');
	// ...and then the same happens to the second block
	await page.evaluate((t) => { window.harness.app.vault.files.get('N.md').data = t; }, start.replace('AB[cc]', 'AB[aa]').replace('AB[dd]', 'AB[bb]'));
	await sleep(1500);
	assert.equal((await notices(page)).length, 2);
	assert.doesNotMatch(await text(page, 'N.md'), /\[ee\]|\[gg\]/);
});

/* A board inside an embed belongs to the embedded note. If the app should name the embedding note
   as the board's source instead, the block must not be looked for (and found!) there. */
await scenario('a board shown through an embed whose source is said to be the embedding note is not edited', {
	files: { 'Host.md': note(X), 'Inner.md': note(X) }, panes: [{ path: 'Host.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	// (what such an embed would look like: the board sits in an element that names the other note)
	await page.evaluate(() => {
		const block = document.querySelector('.kifu').parentElement;
		const embed = document.createElement('div');
		embed.className = 'internal-embed markdown-embed';
		embed.setAttribute('src', 'Inner#a heading');
		block.parentElement.insertBefore(embed, block);
		embed.appendChild(block);
	});
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [false]);
	assert.match((await notices(page))[0], /shown through an embed of another note/);
	await clickPoint(page, 0, 'ee'); // playing is still fine
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	await sleep(600);
	assert.equal(await text(page, 'Host.md'), note(X));
	assert.equal(await text(page, 'Inner.md'), note(X));
});

/* Identical boards where nothing says which is which (an embedded note, say). The notice tells the
   user to give one of them a caption; whichever they pick, the next edit has to go through. */
const noLines = (page, path) =>
	page.evaluate((path) => {
		const h = window.harness;
		h.app._noSectionInfo = true;
		h.views = [h.app.workspace._open(path, 'preview')];
	}, path);
for (const reuse of ['pool', 'ends']) {
	for (const which of ['the board that was edited', 'the other board']) {
		await scenario(`identical boards and no line numbers: the edit is refused, then ${which} gets a caption [renderer keeps drawings: ${reuse}]`, { files: { 'T.md': note(X, X) }, panes: [], autosave: 100, height: 1500, reuse }, async (page) => {
			const SAME = note(X, X);
			await noLines(page, 'T.md');
			await sleep(60);
			await toggleLock(page, 1);
			await tool(page, 'Black stone').click();
			await clickPoint(page, 1, 'ee'); // on the second board
			await sleep(700);
			assert.equal(await text(page, 'T.md'), SAME);
			assert.match((await notices(page))[0], /several boards with the same text/);
			// the board is back to what its block says: the stone was not saved, and is not shown
			assert.deepEqual([await stones(page, 1), await isEditing(page)], [{ black: 1, white: 0 }, [false, false]]);
			// the user does what the notice says, in the note's text
			const next = which === 'the board that was edited'
				? SAME.replace('between\n\n```kifu\n', 'between\n\n```kifu\ncaption: second\n')
				: SAME.replace('# N\n\n```kifu\n', '# N\n\n```kifu\ncaption: first\n');
			await page.evaluate((t) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('T.md'), t); }, next);
			await sleep(900);
			// (the stone that was refused is not slipped into either block behind the user's back)
			assert.equal(await text(page, 'T.md'), next);
			// making the edit again, now that the two differ, works
			await toggleLock(page, 1);
			await tool(page, 'White stone').click();
			await clickPoint(page, 1, 'gg');
			await sleep(700);
			const now = blocks(await text(page, 'T.md'));
			assert.equal(now[0], which === 'the other board' ? 'caption: first\n' + X : X);
			assert.equal(now[1], (which === 'the other board' ? '' : 'caption: second\n') + '(;SZ[9]AB[cc]AW[gg])');
			assert.equal((await notices(page)).length, 1);
		});
	}
}

await browser.close();
process.exit(report() ? 1 : 0);
