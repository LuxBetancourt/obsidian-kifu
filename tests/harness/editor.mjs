// Live Preview checks: the built plugin inside a real CodeMirror 6 editor (see cm-lp.ts).
// Where Obsidian's own behaviour around CodeMirror is not documented, a scenario is run
// with the stand-in's switch both ways.
import assert from 'node:assert/strict';
import {
	chromium, runner, pointXY, clickPoint, sleep, text, doc, notices, cap, stones, lockBtn, tool, boardCount, isEditing, active, toggleLock,
} from './lib.mjs';

const browser = await chromium.launch();
const { scenario, report } = runner(browser);

const cursor = (page, i = 0) => page.evaluate((i) => window.harness.views[i].editor.getCursor(), i);
const setCursor = (page, line, ch, i = 0) =>
	page.evaluate(([i, line, ch]) => { const v = window.harness.views[i]; v.editor.setCursor({ line, ch }); v.cm.focus(); }, [i, line, ch]);
/** What the stand-in's editor did on its own account since the last call (keys it handled, cursor moves into a block). */
const editorLog = (page) => page.evaluate(() => window.LP.log.splice(0));
const scrollNote = (page, top) => page.evaluate((top) => { const sc = document.querySelector('.cm-scroller'); sc.scrollTop = top < 0 ? sc.scrollHeight : top; }, top);
const blocks = (t) => [...t.matchAll(/```kifu\n([\s\S]*?)```/g)].map((m) => m[1].trim());
const filler = (n) => Array.from({ length: n }, (_, i) => `filler paragraph ${i + 1}`).join('\n\n');
/** A block's text without its white space (the game is wrapped at about 78 columns when it is written). */
const flat = (t) => t.replace(/\s+/g, '');
const each = (options) => options.map((o) => [Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') || 'defaults', o]);

/* ------------------------------------------------------------------------- */

const NEW = '# New\n\n```kifu\n```\n\nafter\n';
for (const [name, lp] of each([{}, { syncRender: false }, { syncUnload: false }, { syncRender: false, syncUnload: false }])) {
	await scenario(`edit a new board [${name}]`, { files: { 'N.md': NEW }, live: ['N.md'], autosave: 150, lp }, async (page) => {
		assert.equal(await boardCount(page), 1);
		const start = await cursor(page);
		await toggleLock(page);
		assert.deepEqual(await isEditing(page), [true]);
		await tool(page, 'Black stone').click();
		for (const pt of ['pd', 'qf', 'qc']) await clickPoint(page, 0, pt);
		assert.equal(await doc(page), NEW); // nothing is written while the clicks keep coming
		await sleep(700);
		const want = '# New\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[pd][qf][qc])\n```\n\nafter\n';
		assert.equal(await doc(page), want);
		assert.equal(await text(page, 'N.md'), want);
		// the block was drawn again from the new text, and the board carried on where it was
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await isEditing(page), [true]);
		assert.deepEqual(await stones(page), { black: 3, white: 0 });
		assert.equal(await active(page), 'DIV.kifu');
		assert.deepEqual(await cursor(page), start);
		await clickPoint(page, 0, 'dd');
		await toggleLock(page);
		await sleep(300);
		assert.equal(blocks(await doc(page))[0], '(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[pd][qf][qc][dd])');
		assert.deepEqual(await isEditing(page), [false]);
		assert.deepEqual(await editorLog(page), []);
		assert.deepEqual(await notices(page), []);
	});
}

/* An edit that has not been written yet when CodeMirror takes the board off the page. */
const LONG = '# N\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\n' + filler(400) + '\n';
for (const [how, act] of [
	['select all', (page) => page.evaluate(() => { const cm = window.harness.views[0].cm; cm.dispatch({ selection: { anchor: 0, head: cm.state.doc.length } }); })],
	['the block\'s "edit" button', (page) => page.locator('.edit-block-button').click({ force: true })],
	['scrolling far away', (page) => scrollNote(page, 12000)],
]) {
	for (const syncUnload of [true, false]) {
		const when = syncUnload ? 'inside' : 'after';
		await scenario(`unsaved edit, then ${how} [board unloaded ${when} the editor update]`, { files: { 'N.md': LONG }, live: ['N.md'], autosave: 150, lp: { syncUnload } }, async (page) => {
			await toggleLock(page);
			await tool(page, 'Black stone').click();
			await clickPoint(page, 0, 'ee');
			await sleep(700);
			await clickPoint(page, 0, 'gg'); // not written for another 400 ms...
			await act(page); // ...and the board goes away
			await sleep(900);
			assert.equal(await boardCount(page), 0);
			assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee][gg])');
			assert.equal(blocks(await text(page, 'N.md'))[0], '(;SZ[9]AB[cc][ee][gg])');
			// back to the board: it is as it was left
			await scrollNote(page, 0);
			await page.evaluate(() => window.harness.views[0].cm.dispatch({ selection: { anchor: 0 } }));
			await sleep(300);
			assert.deepEqual(await stones(page), { black: 3, white: 0 });
			assert.deepEqual(await isEditing(page), [true]);
			assert.deepEqual(await notices(page), []);
		});
	}
}

/* Keys pressed while a board has the keyboard are the board's: they must never edit the note. */
const TEXTY = '# Title\n\nSome text here.\n\n```kifu\n(;SZ[9]AB[cc]AW[gg]C[A caption.];B[dd];W[ee])\n```\n\nafter\n';
for (const ignoreEvents of [true, false]) {
	await scenario(`keys on a focused board [widget.ignoreEvent() = ${ignoreEvents}]`, { files: { 'N.md': TEXTY }, live: ['N.md'], autosave: 150, lp: { ignoreEvents } }, async (page) => {
		// the user was typing in the paragraph, then clicks the board (which plays the saved move)
		await setCursor(page, 2, 15);
		assert.deepEqual(await stones(page), { black: 1, white: 1 });
		await clickPoint(page, 0, 'dd');
		await sleep(500);
		assert.deepEqual(await stones(page), { black: 2, white: 2 });
		assert.equal(await active(page), 'DIV.kifu');
		assert.deepEqual(await cursor(page), { line: 2, ch: 15 });
		for (const key of ['Backspace', 'Delete', 'Enter', 'Control+a', 'Control+z', 'ArrowLeft', 'x', 'Tab']) {
			await page.keyboard.press(key);
			await sleep(40);
			assert.equal(await doc(page), TEXTY, `${key} changed the note`);
			assert.equal(await boardCount(page), 1, `${key} took the board away`);
		}
		assert.deepEqual(await editorLog(page), []);
		assert.deepEqual(await cursor(page), { line: 2, ch: 15 });
	});
}

/* Clicks on a board never put the editor's cursor into the block (which would show its source instead). */
for (const clickSelects of ['none', 'mousedown', 'click']) {
	for (const ignoreEvents of [true, false]) {
		await scenario(`clicks stay on the board [widget enters the block on an unclaimed ${clickSelects}; ignoreEvent() = ${ignoreEvents}]`, {
			files: { 'N.md': TEXTY }, live: ['N.md'], autosave: 150, lp: { clickSelects, ignoreEvents },
		}, async (page) => {
			const start = await cursor(page);
			const still = async (what) => {
				assert.equal(await boardCount(page), 1, `${what}: the board is gone`);
				assert.deepEqual(await cursor(page), start, `${what}: the cursor moved`);
				assert.deepEqual(await editorLog(page), [], what);
			};
			await page.locator('.kifu-cap').click();
			await still('click on the caption');
			await clickPoint(page, 0, 'dd');
			await sleep(450);
			await still('click on a point');
			const frame = await page.locator('.kifu-frame').boundingBox();
			await page.mouse.click(frame.x + 3, frame.y + frame.height / 2); // the paper margin
			await still('click on the margin');
			await toggleLock(page);
			await sleep(100);
			assert.deepEqual(await isEditing(page), [true]);
			await still('click on the lock');
			const bar = await page.locator('.kifu-tools').boundingBox();
			await page.mouse.click(bar.x + bar.width - 2, bar.y + bar.height / 2); // the toolbar, beside the buttons
			await tool(page, 'Letter or number').click();
			await page.locator('.kifu-label').click();
			await still('clicks in the toolbar');
			await page.mouse.dblclick(frame.x + frame.width / 2, frame.y + frame.height / 2);
			await sleep(500);
			await still('double click');
			assert.deepEqual(await notices(page), []);
		});
	}
}

/* Two blocks with the very same text: the edit goes to the board that was used, whatever the renderer can say about lines. */
const TWO = '# Twins\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n';
for (const [sectionInfo, shifted, buttonFirst] of [
	['live', false, false], ['live', true, false], ['stale', false, false], ['stale', true, false], ['null', false, false], ['null', true, false],
	// (where the board's element sits inside the editor's widget changes what the editor answers when asked for its place)
	['live', true, true], ['stale', true, true], ['null', false, true], ['null', true, true],
]) {
	{
		const where = `getSectionInfo: ${sectionInfo}${buttonFirst ? ', widget starts with its edit button' : ''}`;
		await scenario(`identical boards, edit the second${shifted ? ' after text was added between them' : ''} [${where}]`, {
			files: { 'T.md': TWO }, live: ['T.md'], autosave: 150, height: 1300, lp: { sectionInfo, buttonFirst },
		}, async (page) => {
			// (CodeMirror keeps both boards as they are when text is typed around them)
			if (shifted) await page.evaluate(() => window.harness.views[0].editor.replaceRange('one\ntwo\nthree\nfour\nfive\nsix\n', { line: 6, ch: 0 }));
			await sleep(80);
			await toggleLock(page, 1);
			assert.deepEqual(await isEditing(page), [false, true]);
			await tool(page, 'Black stone').click();
			await clickPoint(page, 1, 'ee');
			await sleep(700);
			assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc])', '(;SZ[9]AB[cc][ee])']);
			assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 1, white: 0 }, { black: 2, white: 0 }]);
			assert.deepEqual(await isEditing(page), [false, true]);
			// and the first is a board of its own
			await toggleLock(page, 0);
			await tool(page, 'White stone', 0).click();
			await clickPoint(page, 0, 'gg');
			await sleep(700);
			assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc]AW[gg])', '(;SZ[9]AB[cc][ee])']);
			assert.deepEqual(await notices(page), []);
		});
	}
}

for (const syncUnload of [true, false]) {
	const when = syncUnload ? 'inside' : 'after';
	await scenario(`identical boards far apart: edit one, scroll to the other at once [board unloaded ${when} the editor update]`, {
		files: { 'T.md': 'intro\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\n' + filler(300) + '\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n' }, live: ['T.md'], autosave: 150, lp: { syncUnload },
	}, async (page) => {
		assert.equal(await boardCount(page), 1); // the other one is far below
		await toggleLock(page);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await scrollNote(page, -1); // within the 400 ms before the edit is written
		await sleep(900);
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await stones(page), { black: 1, white: 0 }); // the twin, untouched and locked
		assert.deepEqual(await isEditing(page), [false]);
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc])']);
		assert.deepEqual(await notices(page), []);
	});
}

/* The same note in the editor and in a reading pane beside it. */
const EMPTIES = '# Twins\n\n```kifu\n```\n\nbetween\n\n```kifu\n```\n\nend\n';
for (const lagReading of [false, true]) {
	await scenario(`editor and reading pane side by side, edit made in the reading pane${lagReading ? ' [which follows only when the note is saved]' : ''}`, {
		files: { 'T.md': EMPTIES }, live: ['T.md'], autosave: lagReading ? 1800 : 150, lagReading, width: 1500, height: 1400,
	}, async (page) => {
		await page.evaluate(() => { const h = window.harness; h.views.push(h.app.workspace._open('T.md', 'preview')); });
		await sleep(100);
		assert.equal(await boardCount(page), 4); // boards 0 and 1 in the editor, 2 and 3 in the reading pane
		await toggleLock(page, 3);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 3, 'dd');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['', '(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd])']);
		assert.deepEqual(await isEditing(page), [false, true, false, true]);
		assert.deepEqual([await stones(page, 0), await stones(page, 1), await stones(page, 2), await stones(page, 3)].map((s) => s.black), [0, 1, 0, 1]);
		await clickPoint(page, 3, 'pp');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['', '(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd][pp])']);
		assert.deepEqual(await isEditing(page), [false, true, false, true]);
		await sleep(lagReading ? 2400 : 300);
		assert.deepEqual(blocks(await text(page, 'T.md')), ['', '(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd][pp])']);
		assert.deepEqual(await isEditing(page), [false, true, false, true]);
		assert.deepEqual([await stones(page, 0), await stones(page, 1), await stones(page, 2), await stones(page, 3)].map((s) => s.black), [0, 2, 0, 2]);
		await clickPoint(page, 3, 'dp');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['', '(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd][pp][dp])']);
		assert.deepEqual(await notices(page), []);
	});
}

/* The note's own undo takes back what a board wrote; the board follows the note. */
const PLAIN = '# N\n\ntext\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n';
await scenario('undo in the editor after a board wrote to the note', { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await sleep(100);
	assert.equal(await page.locator('.kifu-p-comment').isVisible(), true); // unlocking brought the panel forward
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(600);
	await clickPoint(page, 0, 'gg');
	await sleep(600);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee][gg])');
	// click into the text and undo: the note goes back one step, to a text the board wrote a second ago
	await setCursor(page, 2, 4);
	await page.keyboard.press('Control+z');
	await sleep(300);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee])');
	assert.deepEqual(await stones(page), { black: 2, white: 0 }); // the board shows what the note says
	assert.deepEqual(await isEditing(page), [false]);
	await sleep(600);
	assert.equal(await page.locator('.kifu-p-comment').isVisible(), false); // the panel let go of the board that is no more
	assert.equal(await page.locator('.kifu-p-empty').isVisible(), true);
	// carry on from there
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'aa');
	await sleep(600);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee][aa])');
	assert.deepEqual(await stones(page), { black: 3, white: 0 });
	assert.equal(await page.locator('.kifu-p-comment').isVisible(), true);
	assert.deepEqual(await notices(page), []);
});

await scenario('the block is edited by hand while its board is unlocked', { files: { 'N.md': '# N\n\n```kifu\n(;SZ[9]AB[cc];B[dd])\n```\n\nend\n' }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await sleep(100);
	assert.equal(await page.locator('.kifu-p-comment').isVisible(), true);
	await page.evaluate(() => window.harness.views[0].editor.replaceRange('scale: 80%\n', { line: 3, ch: 0 }));
	await sleep(100);
	// a different text is a different board: drawn afresh, locked
	assert.equal(await boardCount(page), 1);
	assert.deepEqual(await isEditing(page), [false]);
	assert.equal(await page.locator('.kifu-svg').getAttribute('width'), String(Math.round(24 * 0.8) * 6)); // 80 %, six lines wide
	await sleep(600);
	assert.equal(await page.locator('.kifu-p-empty').isVisible(), true);
	assert.equal(blocks(await doc(page))[0], 'scale: 80%\n(;SZ[9]AB[cc];B[dd])');
	assert.deepEqual(await notices(page), []);
});

/* The label box: its text field lives inside the editor's element, and a save rebuilds it under the user's fingers. */
for (const ignoreEvents of [true, false]) {
	await scenario(`typing in the label box across a save [widget.ignoreEvent() = ${ignoreEvents}]`, {
		files: { 'N.md': '# N\n\nSome text.\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n' }, live: ['N.md'], autosave: 150, lp: { ignoreEvents },
	}, async (page) => {
		await setCursor(page, 2, 10);
		await toggleLock(page);
		await tool(page, 'Letter or number').click();
		await clickPoint(page, 0, 'ee'); // places "a"; it is written 400 ms from now
		await page.locator('.kifu-label').click(); // meanwhile the user goes to change the next label
		assert.equal(await active(page), 'INPUT.kifu-label');
		await page.keyboard.type('1');
		assert.equal(await page.locator('.kifu-label').inputValue(), '1'); // (a click selects what was there)
		await sleep(600); // the save lands and the block is drawn again
		assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc]LB[ee:a])');
		assert.equal(await active(page), 'INPUT.kifu-label');
		await page.keyboard.type('2');
		assert.equal(await page.locator('.kifu-label').inputValue(), '12');
		const before = await doc(page);
		await page.keyboard.press('Backspace');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Delete');
		await page.keyboard.type('7');
		assert.equal(await page.locator('.kifu-label').inputValue(), '7');
		assert.equal(await doc(page), before);
		assert.deepEqual(await editorLog(page), []);
		await clickPoint(page, 0, 'gg');
		await sleep(600);
		assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc]LB[ee:a][gg:7])');
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await isEditing(page), [true]);
		assert.deepEqual(await cursor(page), { line: 2, ch: 10 });
		assert.deepEqual(await notices(page), []);
	});
}

const KILL = '(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb];B[ra];W[qa];B[sa])';
await scenario('crop by dragging, undo and Escape with the keyboard on the board', { files: { 'E.md': '# E\n\nSome text.\n\n```kifu\n' + KILL + '\n```\n\nend\n' }, live: ['E.md'], autosave: 150, height: 1100 }, async (page) => {
	await setCursor(page, 2, 5);
	await toggleLock(page);
	await tool(page, 'Choose the part').click();
	const a = await pointXY(page, 0, 'ka');
	const b = await pointXY(page, 0, 'sh');
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
	await page.mouse.move(b.x, b.y);
	await page.mouse.up();
	await sleep(600);
	assert.equal(blocks(await doc(page))[0], 'view: L12-T19\n' + KILL);
	assert.deepEqual(await cursor(page), { line: 2, ch: 5 });
	assert.deepEqual(await isEditing(page), [true]);
	assert.equal(await active(page), 'DIV.kifu');
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'dd');
	await sleep(600);
	assert.match(blocks(await doc(page))[0], /^view: L12-T19\n.*\[sc\]\[dd\]AW/);
	await page.keyboard.press('Control+z'); // the board's own undo, not the editor's
	await sleep(600);
	assert.equal(flat(blocks(await doc(page))[0]), 'view:L12-T19' + KILL);
	await page.keyboard.press('Control+Shift+z');
	await sleep(600);
	assert.match(blocks(await doc(page))[0], /\[sc\]\[dd\]AW/);
	await page.keyboard.press('Control+z');
	await page.keyboard.press('Escape');
	await sleep(300);
	assert.deepEqual(await isEditing(page), [false]);
	assert.equal(flat(blocks(await doc(page))[0]), 'view:L12-T19' + KILL);
	assert.equal(await page.locator('.kifu-svg').getAttribute('width'), String(24 * 9)); // L to T
	assert.deepEqual(await editorLog(page), []);
	assert.deepEqual(await notices(page), []);
});

await scenario('the page does not jump when a save redraws the board', {
	files: { 'N.md': filler(40) + '\n\n```kifu\n(;SZ[19]AB[dd])\n```\n\n' + filler(80) + '\n' }, live: ['N.md'], autosave: 150, height: 900,
}, async (page) => {
	await scrollNote(page, 1500);
	await sleep(200);
	const where = () => page.evaluate(() => ({ top: Math.round(document.querySelector('.kifu-svg')?.getBoundingClientRect().top ?? NaN), scroll: Math.round(document.querySelector('.cm-scroller').scrollTop) }));
	await toggleLock(page);
	await sleep(100);
	const before = await where();
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'pp');
	for (let i = 0; i < 14; i++) {
		await sleep(60);
		const now = await where();
		assert.ok(Math.abs(now.top - before.top) <= 1 && Math.abs(now.scroll - before.scroll) <= 1, `moved from ${JSON.stringify(before)} to ${JSON.stringify(now)}`);
	}
	assert.equal(blocks(await doc(page))[0], '(;SZ[19]AB[dd][pp])');
});

await scenario('a position that was played out is still there after scrolling away and back', {
	files: { 'N.md': 'intro\n\n```kifu\n(;SZ[9]AB[aa]AW[bb];B[cc];W[dd];B[ee])\n```\n\n' + filler(300) }, live: ['N.md'], autosave: 150,
}, async (page) => {
	await clickPoint(page, 0, 'cc');
	await sleep(500);
	assert.deepEqual(await stones(page), { black: 2, white: 2 });
	await scrollNote(page, 9000);
	await sleep(200);
	assert.equal(await boardCount(page), 0);
	await scrollNote(page, 0);
	await sleep(200);
	assert.deepEqual(await stones(page), { black: 2, white: 2 });
	assert.equal(await doc(page), 'intro\n\n```kifu\n(;SZ[9]AB[aa]AW[bb];B[cc];W[dd];B[ee])\n```\n\n' + filler(300));
});

for (const syncUnload of [true, false]) {
	const when = syncUnload ? 'inside' : 'after';
	await scenario(`a comment typed in the panel while the note is scrolled away from its board [board unloaded ${when} the editor update]`, {
		files: { 'N.md': 'intro\n\n```kifu\n(;SZ[9]AB[cc];B[dd])\n```\n\n' + filler(300) + '\n' }, live: ['N.md'], autosave: 150, lp: { syncUnload },
	}, async (page) => {
		await toggleLock(page);
		await sleep(150);
		const box = page.locator('.kifu-p-comment');
		await box.click();
		await page.keyboard.type('First sentence. ', { delay: 20 });
		await scrollNote(page, 9000); // the wheel is turned over the note mid-sentence
		await page.keyboard.type('Second sentence, typed while the board is out of sight. ', { delay: 20 });
		await sleep(800);
		assert.equal(await boardCount(page), 0);
		await page.keyboard.type('Third sentence.', { delay: 20 });
		await sleep(800);
		const all = 'First sentence. Second sentence, typed while the board is out of sight. Third sentence.';
		assert.equal(await box.inputValue(), all);
		// (the comment belongs to the move the board rests on; long lines are wrapped)
		assert.equal(blocks(await doc(page))[0].replace(/\n/g, ''), `(;SZ[9]AB[cc];B[dd]C[${all}])`);
		await scrollNote(page, 0);
		await sleep(300);
		assert.deepEqual(await isEditing(page), [true]);
		assert.equal(await cap(page), all);
		assert.equal(await box.isVisible(), true);
		assert.deepEqual(await notices(page), []);
	});
}

await scenario('the insert command, in the middle of a line and at the very end of a note', { files: { 'N.md': 'first line\nsecond line\n\nlast' }, live: ['N.md'], autosave: 150 }, async (page) => {
	const res = await page.evaluate(() => {
		const h = window.harness;
		const v = h.views[0];
		const ed = v.editor;
		const cmd = h.app._commands.find((c) => c.id === 'insert-board');
		const out = [];
		ed.setCursor({ line: 0, ch: 3 });
		cmd.editorCallback(ed, v);
		out.push([ed.getValue(), ed.getCursor()]);
		ed.setCursor({ line: ed.lineCount() - 1, ch: 2 });
		cmd.editorCallback(ed, v);
		out.push([ed.getValue(), ed.getCursor()]);
		return out;
	});
	assert.deepEqual(res[0], ['first line\n```kifu\n```\nsecond line\n\nlast', { line: 3, ch: 0 }]);
	assert.deepEqual(res[1], ['first line\n```kifu\n```\nsecond line\n\nlast\n```kifu\n```\n', { line: 8, ch: 0 }]);
	await sleep(100);
	assert.equal(await boardCount(page), 2); // the cursor is outside both blocks, so both are drawn
});

await scenario('the editor menu: a Kifu submenu, or plain items where submenus are missing', { files: { 'N.md': 'first line\n\nlast' }, live: ['N.md'], autosave: 150 }, async (page) => {
	const res = await page.evaluate(async () => {
		const h = window.harness;
		const { Menu } = window.__obsidian;
		const tick = () => new Promise((r) => setTimeout(r, 50));
		const v = h.views[0];
		const ed = v.editor;
		const show = (m) => m.items.map((i) => [i.title, i.section, i.submenu ? i.submenu.items.map((s) => s.title) : null]);
		const out = [];
		const menu = new Menu();
		h.app.workspace.trigger('editor-menu', menu, ed, v);
		out.push(show(menu));
		ed.setCursor({ line: 1, ch: 0 });
		menu.items[0].submenu.items[0].click(); // 19 x 19: the default size, so no size line
		await tick();
		out.push(ed.getValue());
		ed.setCursor({ line: 0, ch: 0 });
		menu.items[0].submenu.items[1].click(); // 13 x 13
		await tick();
		out.push(ed.getValue());
		menu.items[0].submenu.items[3].click(); // opens the file picker
		out.push(window.__obsidian.Modal.last?.isOpen ?? false);
		ed.setCursor({ line: 0, ch: 0 }); // (out of the new blocks, or the menu offers the problem switch for one)
		Menu.noSubmenu = true;
		const flat = new Menu();
		h.app.workspace.trigger('editor-menu', flat, ed, v);
		Menu.noSubmenu = false;
		out.push(show(flat));
		return out;
	});
	assert.deepEqual(res[0], [['Kifu', 'insert', ['Insert 19 × 19 board', 'Insert 13 × 13 board', 'Insert 9 × 9 board', 'Display SGF file…']]]);
	assert.equal(res[1], 'first line\n```kifu\n```\n\nlast');
	assert.equal(res[2], 'first line\n```kifu\nsize: 13\n```\n```kifu\n```\n\nlast');
	assert.equal(res[3], true);
	assert.deepEqual(res[4], [
		['Insert 19 × 19 Kifu board', 'insert', null],
		['Insert 13 × 13 Kifu board', 'insert', null],
		['Insert 9 × 9 Kifu board', 'insert', null],
		['Display SGF file with Kifu…', 'insert', null],
	]);
});

await scenario('the sizes in the menu follow the default size, even before the settings were read', { files: { 'N.md': 'no boards here\n' }, live: ['N.md'], data: { boardSize: 13 } }, async (page) => {
	const res = await page.evaluate(async () => {
		const h = window.harness;
		const v = h.views[0];
		const ed = v.editor;
		const ready = h.plugin.settingsReady;
		const pick = async (title) => {
			const m = new window.__obsidian.Menu();
			h.app.workspace.trigger('editor-menu', m, ed, v);
			ed.setCursor({ line: 0, ch: 0 });
			m.items[0].submenu.items.find((i) => i.title === title).click();
			await new Promise((r) => setTimeout(r, 50));
		};
		await pick('Insert 13 × 13 board'); // the default here: no size line
		await pick('Insert 19 × 19 board');
		return { ready, text: ed.getValue() };
	});
	assert.equal(res.ready, false); // (nothing had read the settings yet)
	assert.equal(res.text, 'no boards here\n```kifu\nsize: 19\n```\n```kifu\n```\n');
});

await scenario('the problem switch: in the menu for the block under the cursor or the board right-clicked, and under the lock while editing', { files: { 'N.md': 'intro\n\n```kifu\n(;SZ[9];B[cc];W[dd])\n```\n\nend' }, live: ['N.md'], autosave: 150 }, async (page) => {
	// opens the editor menu (after a right-click, if one was given) and finds the switch in the Kifu submenu
	const menu = (right) => page.evaluate(() => {
		const h = window.harness;
		const m = new window.__obsidian.Menu();
		h.app.workspace.trigger('editor-menu', m, h.views[0].editor, h.views[0]);
		const item = m.items[0].submenu.items.find((i) => i.title === 'Problem board');
		window.__problemItem = item;
		return item ? { checked: item.checked, disabled: !!item.disabled } : null;
	});
	const pick = () => page.evaluate(() => window.__problemItem.click());
	const setCursor = (line) => page.evaluate((line) => window.harness.views[0].editor.setCursor({ line, ch: 0 }), line);
	const problemBtn = page.locator('.kifu-ctl .kifu-btn[aria-label^="Problem"]');

	// the cursor in no block, no board right-clicked: the menu is about no board
	await setCursor(0);
	await sleep(100);
	assert.equal(await menu(), null);

	// the cursor in the block: its text is changed right there
	await setCursor(3);
	await sleep(100);
	assert.deepEqual(await menu(), { checked: false, disabled: false });
	await pick();
	assert.equal(await doc(page), 'intro\n\n```kifu\nproblem: yes\n(;SZ[9];B[cc];W[dd])\n```\n\nend');
	assert.deepEqual(await menu(), { checked: true, disabled: false });
	await pick();
	assert.equal(await doc(page), 'intro\n\n```kifu\n(;SZ[9];B[cc];W[dd])\n```\n\nend');

	// a right-click on the board: the switch is about that board, locked as it is
	await setCursor(0);
	await sleep(150);
	assert.equal(await boardCount(page), 1);
	assert.equal(await problemBtn.isVisible(), false); // (locked: no switch under the lock)
	const p = await pointXY(page, 0, 'ee');
	await page.mouse.click(p.x, p.y, { button: 'right' });
	assert.deepEqual(await menu(), { checked: false, disabled: false });
	await pick();
	await sleep(700);
	assert.match(await doc(page), /```kifu\nproblem: yes\n\(;SZ\[9\]/);
	assert.deepEqual(await isEditing(page), [false]);
	// the right-click is forgotten once its menu has been shown
	assert.equal(await menu(), null);

	// unlocked: the switch is under the lock, lit while the board is a problem
	await toggleLock(page);
	assert.equal(await problemBtn.isVisible(), true);
	assert.equal(await problemBtn.evaluate((b) => b.classList.contains('is-active')), true);
	await problemBtn.click();
	assert.equal(await problemBtn.evaluate((b) => b.classList.contains('is-active')), false);
	await toggleLock(page);
	await sleep(500);
	assert.equal(await problemBtn.isVisible(), false);
	assert.equal(await doc(page), 'intro\n\n```kifu\n(;SZ[9];B[cc];W[dd])\n```\n\nend');
	assert.deepEqual(await notices(page), []);
});

await scenario("Obsidian's edit button stays clear of the lock, even beside a board as wide as the note", { files: { 'W.md': 'top\n\n```kifu\nscale: 125%\nview: full\n(;SZ[19]AB[pd])\n```\n\nend' }, live: ['W.md'] }, async (page) => {
	const box = await page.locator('.kifu-svg').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await sleep(200);
	const edit = await page.locator('.edit-block-button').boundingBox();
	const lock = await lockBtn(page).boundingBox();
	assert.ok(edit && lock);
	const apart = edit.x >= lock.x + lock.width || edit.x + edit.width <= lock.x || edit.y >= lock.y + lock.height || edit.y + edit.height <= lock.y;
	assert.ok(apart, `edit button ${JSON.stringify(edit)} covers the lock ${JSON.stringify(lock)}`);
	// (it moved to the bottom of the block)
	assert.ok(edit.y > box.y + box.height / 2);
});

/* Writing redraws the block: an unlocked board writes only after a pause, so quick input is never swapped out from under the pointer. */
{
	const note = 'top\n\n```kifu\nsize: 9\n```\n\nend\n';
	const moves = ['aa', 'cc', 'ee', 'gg', 'ii', 'ac', 'ce', 'eg', 'gi', 'ca', 'ec', 'ge'];
	const human = async (page, pt) => {
		const p = await pointXY(page, 0, pt);
		await page.mouse.move(p.x, p.y);
		await page.mouse.down();
		await sleep(110); // (a person's click is held for a moment)
		await page.mouse.up();
	};
	const written = async (page) => ((await doc(page)).match(/;[BW]\[/g) ?? []).length;

	await scenario('quick moves on an unlocked board all land, and are written after a pause', { files: { 'N.md': note }, live: ['N.md'], autosave: 150, saveDelay: 3000 }, async (page) => {
		await toggleLock(page);
		const board = await page.evaluateHandle(() => document.querySelector('.kifu-svg'));
		for (const pt of moves) {
			await human(page, pt);
			await sleep(330);
		}
		assert.equal(await written(page), 0); // nothing written while at work...
		assert.equal(await page.evaluate((b) => b.isConnected, board), true); // ...so the board was never swapped
		await sleep(3300);
		assert.equal(await written(page), moves.length); // ...and all of it after the pause
		assert.deepEqual(await notices(page), []);
	});

	await scenario('locking, or the board going away, writes at once', { files: { 'N.md': note }, live: ['N.md'], autosave: 150, saveDelay: 3000 }, async (page) => {
		await toggleLock(page);
		await human(page, 'cc');
		await human(page, 'ee');
		await toggleLock(page); // lock
		await sleep(300);
		assert.equal(await written(page), 2);
		await toggleLock(page);
		await human(page, 'gg');
		await page.evaluate(() => window.harness.views[0].renderer?.set?.('') ?? window.harness.views[0].cm?.dom.remove());
		await page.evaluate(() => { const v = window.harness.views[0]; v.leaf?.detach?.(); });
		await sleep(400);
		assert.equal(((await page.evaluate(() => window.harness.text('N.md'))).match(/;[BW]\[/g) ?? []).length, 3);
	});

	await scenario('a write that falls due while a press is held waits for it', { files: { 'N.md': note }, live: ['N.md'], autosave: 150, saveDelay: 3000 }, async (page) => {
		await toggleLock(page);
		await human(page, 'cc');
		await sleep(500);
		// pressed beside the board (so letting go plays nothing), and held past the pause
		const box = await page.locator('.kifu').boundingBox();
		await page.mouse.move(box.x + 6, box.y + box.height / 2);
		await page.mouse.down();
		await sleep(3600);
		assert.equal(await written(page), 0); // the write fell due during the press, and waited
		await page.mouse.up();
		await sleep(600);
		assert.equal(await written(page), 1); // let go: written straight after
	});
}

await scenario('importing a problem from goproblems.com: prompt, note, solving, token and failures', { files: { 'N.md': 'intro\n\n\nend' }, live: ['N.md'], autosave: 150 }, async (page) => {
	// what the site answers (the requests never leave the page)
	await page.evaluate(() => {
		const sgf = '(;AB[aa]AB[ba]AW[ca]AW[cb]C[Black to live]SZ[9]PB[Black]PW[White](;B[ab];W[bb];B[ac]C[RIGHT])(;B[bb];W[ab]C[too slow]))';
		const { requestUrl } = window.__obsidian;
		requestUrl.answers['https://goproblems.com/api/v2/problems/5'] = { status: 200, json: { sgf, genre: 'life and death', rank: { value: 20, unit: 'kyu' }, author: { name: 'someone' } } };
		requestUrl.answers['https://goproblems.com/api/v2/problems/7'] = { status: 200, json: { sgf } };
		requestUrl.answers['https://goproblems.com/api/v2/problems/11'] = 'offline';
	});
	// runs the command and types into its prompt
	const importAs = (typed) => page.evaluate(async (typed) => {
		const h = window.harness;
		const v = h.views[0];
		v.editor.setCursor({ line: 2, ch: 0 });
		h.app._commands.find((c) => c.id === 'import-goproblems').editorCallback(v.editor, v);
		const modal = window.__obsidian.Modal.last;
		const input = modal.contentEl.querySelector('input');
		input.value = typed;
		input.dispatchEvent(new Event('input'));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		await new Promise((r) => setTimeout(r, 100));
		return { open: modal.isOpen, hint: modal.contentEl.querySelector('.kifu-import-hint')?.textContent ?? '' };
	}, typed);
	const requests = () => page.evaluate(() => window.__obsidian.requestUrl.log.splice(0));

	// not a number: the prompt stays, and says why
	let r = await importAs('a problem please');
	assert.equal(r.open, true);
	assert.match(r.hint, /not a problem number/);
	assert.deepEqual(await requests(), []);
	await page.evaluate(() => window.__obsidian.Modal.last.close());

	// a link to problem 5
	r = await importAs('https://www.goproblems.com/problems/5');
	assert.equal(r.open, false);
	const log = await requests();
	assert.deepEqual(log.map((q) => q.url), ['https://goproblems.com/api/v2/problems/5']);
	assert.equal(log[0].headers['X-Api-Key'], undefined); // no token chosen: none sent
	const text = await doc(page);
	assert.match(text, /\[goproblems\.com #5\]\(https:\/\/www\.goproblems\.com\/problems\/5\) · Life and death, 20 kyu, by someone\n\n```kifu\nproblem: yes\n\(;/);
	assert.match(text, /GN\[goproblems\.com #5\]/);
	assert.match(text, /SO\[https:\/\/www\.goproblems\.com\/problems\/5\]/);
	assert.match(text, /B\[ac\]TE\[1\]/); // "RIGHT" became a check mark
	assert.doesNotMatch(text, /RIGHT|PB\[|PW\[/);
	assert.match(text, /^intro\n/);
	assert.match(text, /\nend$/);

	// the board is there, and the problem plays: the right line ends correct
	await sleep(200);
	assert.equal(await boardCount(page), 1);
	assert.equal(await cap(page), 'Black to live');
	await clickPoint(page, 0, 'ab');
	await sleep(700);
	await clickPoint(page, 0, 'ac');
	await sleep(100);
	assert.match(await cap(page), /^Correct/);

	// with a token chosen, it is sent along (it lives in the secret storage, not in the settings)
	await page.evaluate(async () => {
		const h = window.harness;
		await h.plugin.settingsLoaded();
		h.app.secretStorage.setSecret('gp-token', 's3cret');
		h.plugin.settings.goproblemsKey = 'gp-token';
	});
	await importAs('#7');
	const withKey = await requests();
	assert.equal(withKey[0].headers['X-Api-Key'], 's3cret');

	// failures: said in a notice, and the note is left alone
	const before = await doc(page);
	await importAs('9');
	await importAs('11');
	await sleep(100);
	const said = await notices(page);
	assert.ok(said.some((n) => /goproblems\.com has no problem 9\./.test(n)), said.join(' | '));
	assert.ok(said.some((n) => /could not reach goproblems\.com/.test(n)), said.join(' | '));
	assert.equal(await doc(page), before);
});

/* A block that is copied right after its board wrote it reads exactly like what the board is waiting for. */
for (const which of ['original', 'copy']) {
	await scenario(`a block is pasted again a moment after its board wrote it; then the ${which} is edited`, { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150, height: 1300 }, async (page) => {
		await toggleLock(page);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(600);
		assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee])');
		await page.evaluate(() => {
			const ed = window.harness.views[0].editor;
			ed.replaceRange('\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n', { line: ed.lineCount(), ch: 0 });
		});
		await sleep(100);
		// the copy is a board of its own from the start
		assert.equal(await boardCount(page), 2);
		assert.deepEqual(await isEditing(page), [true, false]);
		const want = ['(;SZ[9]AB[cc][ee])', '(;SZ[9]AB[cc][ee])'];
		if (which === 'original') {
			await clickPoint(page, 0, 'gg');
			want[0] = '(;SZ[9]AB[cc][ee][gg])';
		} else {
			await toggleLock(page, 1);
			await tool(page, 'Black stone', 1).click();
			await clickPoint(page, 1, 'gg');
			want[1] = '(;SZ[9]AB[cc][ee][gg])';
		}
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), want);
		assert.deepEqual([await stones(page, 0), await stones(page, 1)].map((s) => s.black), which === 'original' ? [3, 2] : [2, 3]);
		assert.deepEqual(await isEditing(page), which === 'original' ? [true, false] : [true, true]);
		assert.deepEqual(await notices(page), []);
	});
}

/* ------------------------------------------------------- what a second review turned up */

/* A board's state belongs to its block. Another block that reads the same must never inherit it. */
const FAR = 'intro\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\n' + filler(300) + '\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n';
for (const how of ['unlocked', 'played on']) {
	await scenario(`identical boards far apart: one is ${how}, then the other is scrolled to`, { files: { 'T.md': FAR }, live: ['T.md'], autosave: 150 }, async (page) => {
		assert.equal(await boardCount(page), 1);
		if (how === 'unlocked') {
			await toggleLock(page);
		} else {
			// (the locked board shows the corner only, as far as E5)
			await clickPoint(page, 0, 'ee');
			await clickPoint(page, 0, 'dc');
			assert.deepEqual(await stones(page), { black: 2, white: 1 });
		}
		await sleep(300);
		await scrollNote(page, -1);
		await sleep(900);
		// the second board is its own: locked, at rest
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await isEditing(page), [false]);
		assert.deepEqual(await stones(page), { black: 1, white: 0 });
		// and the panel has let go of the board that is out of sight, rather than show it under this one
		if (how === 'unlocked') assert.equal(await page.locator('.kifu-p-comment').isVisible(), false);
		// what is done here is written here
		await toggleLock(page);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 0, 'ee');
		await sleep(700);
		assert.deepEqual(blocks(await doc(page)), ['(;SZ[9]AB[cc])', '(;SZ[9]AB[cc][ee])']);
		// back at the first (which no other block reads like any more): it is as it was left
		await scrollNote(page, 0);
		await sleep(600);
		assert.deepEqual(await isEditing(page), [how === 'unlocked']);
		assert.deepEqual(await stones(page), how === 'unlocked' ? { black: 1, white: 0 } : { black: 2, white: 1 });
		assert.deepEqual(await notices(page), []);
	});
}

for (const syncUnload of [true, false]) {
	const when = syncUnload ? 'inside' : 'after';
	await scenario(`three empty boards, the first unlocked, scrolled through [board unloaded ${when} the editor update]`, {
		files: { 'T.md': 'intro\n\n```kifu\n```\n\n' + filler(120) + '\n\n```kifu\n```\n\n' + filler(120) + '\n\n```kifu\n```\n\nend\n' }, live: ['T.md'], autosave: 150, lp: { syncUnload },
	}, async (page) => {
		await toggleLock(page);
		await sleep(200);
		assert.deepEqual(await isEditing(page), [true]);
		// scroll down in small steps: whatever board comes into view from now on is locked
		let seen = 0;
		for (let f = 0.1; f <= 1.0001; f += 0.02) {
			await page.evaluate((f) => { const sc = document.querySelector('.cm-scroller'); sc.scrollTop = f * sc.scrollHeight; }, f);
			await sleep(50);
			const now = await isEditing(page);
			seen += now.length;
			assert.equal(now.includes(true), false, `a board arrived unlocked at ${f.toFixed(2)}`);
		}
		assert.ok(seen > 0);
		assert.equal(await doc(page), 'intro\n\n```kifu\n```\n\n' + filler(120) + '\n\n```kifu\n```\n\n' + filler(120) + '\n\n```kifu\n```\n\nend\n');
		assert.deepEqual(await notices(page), []);
	});
}

await scenario('identical boards on one screen: the cursor passes through one while the other is unlocked', { files: { 'T.md': TWO }, live: ['T.md'], autosave: 150, height: 1300 }, async (page) => {
	const cursorTo = (line) => page.evaluate((line) => window.harness.views[0].editor.setCursor({ line, ch: 0 }), line);
	await toggleLock(page, 1);
	assert.deepEqual(await isEditing(page), [false, true]);
	await cursorTo(3); // into the first block: its source is shown, the second board is still there
	await sleep(100);
	assert.deepEqual(await isEditing(page), [true]);
	await cursorTo(9); // on into the second block: now only the first board is drawn
	await sleep(100);
	assert.deepEqual(await isEditing(page), [false]);
	await cursorTo(0);
	await sleep(100);
	// They read the same, but each is known by its place: the second is the one that was
	// unlocked, and it is again. The first never was.
	assert.deepEqual(await isEditing(page), [false, true]);
});

await scenario('a board that no other reads like keeps its state when the cursor passes through its block', { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(600);
	await page.evaluate(() => window.harness.views[0].editor.setCursor({ line: 5, ch: 0 }));
	await sleep(100);
	assert.equal(await boardCount(page), 0);
	// (text typed elsewhere meanwhile moves the block down; it is still the same block)
	await page.evaluate(() => { const ed = window.harness.views[0].editor; ed.setCursor({ line: 2, ch: 0 }); ed.replaceRange('more\n\n', { line: 2, ch: 0 }); });
	await sleep(100);
	assert.deepEqual(await isEditing(page), [true]);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	await clickPoint(page, 0, 'gg');
	await sleep(600);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][ee][gg])');
	assert.deepEqual(await notices(page), []);
});

/* The same block unlocked in two panes, a stone in each within the delay before either is written. */
await scenario('editor and reading pane, the same block edited in both at once: one edit is written, the other refused, no other block touched', {
	files: { 'T.md': TWO }, live: ['T.md'], autosave: 150, width: 1500, height: 1400,
}, async (page) => {
	await page.evaluate(() => { const h = window.harness; h.views.push(h.app.workspace._open('T.md', 'preview')); });
	await sleep(100);
	// boards 0 and 1: the editor; 2 and 3: the reading pane. The second block is unlocked in both.
	await toggleLock(page, 1);
	await toggleLock(page, 3);
	await tool(page, 'Black stone', 0).click();
	await tool(page, 'White stone', 1).click();
	await clickPoint(page, 3, 'gg');
	await sleep(120);
	await clickPoint(page, 1, 'ee');
	await sleep(1200);
	const now = blocks(await doc(page));
	assert.equal(now[0], '(;SZ[9]AB[cc])');
	assert.ok(now[1] === '(;SZ[9]AB[cc]AW[gg])' || now[1] === '(;SZ[9]AB[cc][ee])', now[1]);
	const said = await notices(page);
	assert.equal(said.length, 1);
	assert.match(said[0], /no longer certain|changed or removed/);
});

/* A reading pane that lags behind the editor knows its boards by lines that no longer hold. */
await scenario('identical boards, a reading pane that lags, and a block pasted above in the editor: nothing is written to the wrong one', {
	files: { 'T.md': '## Problem\n```kifu\n```\n## Problem\n```kifu\n```\nend\n' }, live: ['T.md'], autosave: 60000, lagReading: true, width: 1500, height: 1500,
}, async (page) => {
	await page.evaluate(() => { const h = window.harness; h.views.push(h.app.workspace._open('T.md', 'preview')); });
	await sleep(100);
	assert.equal(await boardCount(page), 4);
	await page.evaluate(() => window.harness.views[0].editor.replaceRange('## Problem\n```kifu\n```\n', { line: 0, ch: 0 }));
	await sleep(100);
	assert.equal(await boardCount(page), 5); // three in the editor; the reading pane still shows two
	await toggleLock(page, 4);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 4, 'dd');
	await sleep(700);
	assert.deepEqual(blocks(await doc(page)), ['', '', '']);
	assert.match((await notices(page))[0], /no longer certain/);
});

/* Undo and redo with the keyboard on a board or on the panel must not reach the note's own undo. */
for (const state of ['locked', 'unlocked, with nothing to undo', 'locked, in a reading pane beside the editor']) {
	await scenario(`undo and redo keys on a board that is ${state} leave the note alone`, { files: { 'N.md': TEXTY }, live: ['N.md'], autosave: 150, width: 1500 }, async (page) => {
		const beside = state.includes('reading pane');
		if (beside) {
			await page.evaluate(() => { const h = window.harness; h.views.push(h.app.workspace._open('N.md', 'preview')); });
			await sleep(100);
		}
		await setCursor(page, 2, 15);
		await page.keyboard.type(' Typed by hand.', { delay: 10 });
		await sleep(100);
		const before = await doc(page);
		assert.match(before, /Some text here\. Typed by hand\./);
		if (state.startsWith('unlocked')) await toggleLock(page, 0);
		await page.locator('.kifu-cap').nth(beside ? 1 : 0).click();
		assert.equal(await active(page), 'DIV.kifu');
		for (const key of ['Control+z', 'Control+z', 'Control+y', 'Control+Shift+z']) {
			await page.keyboard.press(key);
			await sleep(80);
			assert.equal(await doc(page), before, `${key} changed the note`);
			assert.equal(await active(page), 'DIV.kifu', `${key} moved the keyboard`);
		}
		// on a locked board they take back, and make again, a move of one's own
		if (state === 'locked') {
			await clickPoint(page, 0, 'aa');
			assert.deepEqual(await stones(page), { black: 2, white: 1 });
			await page.keyboard.press('Control+z');
			assert.deepEqual(await stones(page), { black: 1, white: 1 });
			await page.keyboard.press('Control+y');
			assert.deepEqual(await stones(page), { black: 2, white: 1 });
			assert.equal(await doc(page), before);
		}
	});
}

await scenario('undo, redo and Escape with the keyboard on the panel are the board\'s', { files: { 'N.md': TEXTY }, live: ['N.md'], autosave: 150 }, async (page) => {
	await setCursor(page, 2, 15);
	await page.keyboard.type(' Typed by hand.', { delay: 10 });
	await toggleLock(page);
	await sleep(150);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'aa');
	await sleep(700);
	assert.match(blocks(await doc(page))[0], /AB\[cc\]\[aa\]/);
	const box = await page.locator('.kifu-t').boundingBox();
	await page.mouse.click(box.x + 6 + 13, box.y + 6 + 13); // a click on the tree puts the keyboard on the panel
	assert.equal(await active(page), 'DIV.kifu-p-main');
	await page.keyboard.press('Control+z');
	await sleep(700);
	// the board's last edit is undone; the sentence typed into the note is still there
	assert.match(await doc(page), /Some text here\. Typed by hand\./);
	assert.doesNotMatch(blocks(await doc(page))[0], /\[aa\]/);
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	await page.keyboard.press('Control+y');
	await sleep(700);
	assert.match(blocks(await doc(page))[0], /AB\[cc\]\[aa\]/);
	await page.keyboard.press('Escape');
	await sleep(300);
	assert.deepEqual(await isEditing(page), [false]);
	assert.match(await doc(page), /Some text here\. Typed by hand\./);
});

/* Escape while a crop is being dragged out calls the drag off; it must not leave a crop behind on a locked board. */
await scenario('Escape in the middle of dragging a crop', { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Choose the part').click();
	const a = await pointXY(page, 0, 'aa');
	const b = await pointXY(page, 0, 'ee');
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
	await page.mouse.move(b.x, b.y);
	await page.keyboard.press('Escape');
	await sleep(50);
	assert.deepEqual(await isEditing(page), [true]); // the drag was called off, nothing else
	await page.mouse.up();
	await sleep(700);
	assert.equal(await doc(page), PLAIN);
	await page.keyboard.press('Escape'); // and now the board locks
	await sleep(300);
	assert.deepEqual(await isEditing(page), [false]);
	assert.equal(await doc(page), PLAIN);
	assert.deepEqual(await notices(page), []);
});

/* The same note in two editors. */
for (const mirror of ['sync', 'micro']) {
	await scenario(`two editors on one note with identical boards [the second follows the first: ${mirror}]`, {
		files: { 'T.md': TWO }, live: ['T.md', 'T.md'], autosave: 150, width: 1500, height: 1400, lp: { mirror },
	}, async (page) => {
		assert.equal(await boardCount(page), 4); // boards 0, 1 in the first editor; 2, 3 in the second
		const both = async () => [blocks(await doc(page, 0)), blocks(await doc(page, 1))];
		await toggleLock(page, 3);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 3, 'ee');
		await sleep(700);
		let want = ['(;SZ[9]AB[cc])', '(;SZ[9]AB[cc][ee])'];
		assert.deepEqual(await both(), [want, want]);
		assert.deepEqual(await isEditing(page), [false, true, false, true]);
		// the same block from the other editor
		await clickPoint(page, 1, 'aa');
		await sleep(700);
		want = ['(;SZ[9]AB[cc])', '(;SZ[9]AB[cc][ee][aa])'];
		assert.deepEqual(await both(), [want, want]);
		// the first block there, and at once the second block here
		await toggleLock(page, 0);
		await tool(page, 'White stone', 0).click();
		await clickPoint(page, 0, 'bb');
		await clickPoint(page, 3, 'dd');
		await sleep(900);
		want = ['(;SZ[9]AB[cc]AW[bb])', '(;SZ[9]AB[cc][ee][aa][dd])'];
		assert.deepEqual(await both(), [want, want]);
		assert.deepEqual(await notices(page), []);
	});
}

/* When nothing at all can tell identical boards apart, nothing is written and the user is told. */
await scenario('identical boards in a reading view that gives no line numbers', { files: { 'T.md': EMPTIES }, panes: [], autosave: 100, height: 1500 }, async (page) => {
	await page.evaluate(() => {
		const h = window.harness;
		const real = h.app._processors.get('kifu');
		h.app._processors.set('kifu', (src, el, ctx) => real(src, el, { ...ctx, addChild: ctx.addChild, getSectionInfo: () => null }));
		h.views = [h.app.workspace._open('T.md', 'preview')];
	});
	await sleep(60);
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'dd');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), EMPTIES);
	assert.match((await notices(page))[0], /several boards with the same text/);
	// The twin was never touched. And the board does not go on showing a stone that is in
	// no note: an edit that was refused is gone, not waiting for a chance.
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 0, white: 0 }, { black: 0, white: 0 }]);
	assert.deepEqual(await isEditing(page), [false, false]);
	// With a caption on the OTHER block the two differ, and the same edit goes through
	// (the board itself was not drawn again: nothing about its block changed).
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		return v.modify(v.getAbstractFileByPath('T.md'), v.files.get('T.md').data.replace('# Twins\n\n```kifu\n', '# Twins\n\n```kifu\ncaption: first\n'));
	});
	await sleep(200);
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'dd');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), EMPTIES.replace('# Twins\n\n```kifu\n', '# Twins\n\n```kifu\ncaption: first\n').replace('between\n\n```kifu\n', 'between\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd])\n'));
	assert.equal((await notices(page)).length, 1);
});

/* A board that comes back to the page picks up where it left off: but only its own board. */
const SIZES = '# Twins\n\n```kifu\nsize: 9\n```\n\nbetween\n\n```kifu\nsize: 9\n```\n\nend\n';
await scenario('look-alike boards: what was played out on one does not turn up on the other when that is drawn again', { files: { 'T.md': SIZES }, live: ['T.md'], autosave: 150, height: 1300 }, async (page) => {
	// two moves on the second board, locked: nothing is saved, the board remembers them
	await clickPoint(page, 1, 'cc');
	await clickPoint(page, 1, 'dd');
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 0, white: 0 }, { black: 1, white: 1 }]);
	// the second block gets a caption, typed by hand in its source
	await page.locator('.edit-block-button').nth(1).click({ force: true });
	await sleep(100);
	assert.equal(await boardCount(page), 1);
	await page.evaluate(() => {
		const v = window.harness.views[0];
		v.editor.replaceRange('caption: second\n', { line: v.editor.getValue().split('\n').lastIndexOf('size: 9'), ch: 0 });
	});
	await setCursor(page, 0, 0);
	await sleep(100);
	assert.equal(await boardCount(page), 2);
	// Now the first is the only block that reads "size: 9". It is drawn again (the cursor passes through it)...
	await page.locator('.edit-block-button').nth(0).click({ force: true });
	await sleep(100);
	await setCursor(page, 0, 0);
	await sleep(100);
	// ...and is the empty board it always was, not the second one's game
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 0, white: 0 }, { black: 0, white: 0 }]);
	assert.equal(await doc(page), SIZES.replace('between\n\n```kifu\n', 'between\n\n```kifu\ncaption: second\n'));
	assert.deepEqual(await notices(page), []);
});

await scenario('an edit that was refused after its board had gone does not come back with a later drawing', { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 150 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'dd');
	await sleep(700);
	const written = await doc(page);
	assert.match(written, /AB\[cc\]\[dd\]/);
	// the note's own undo takes the write back, and the board is drawn again from the old text
	await page.evaluate(() => window.harness.views[0].undo());
	assert.equal(await doc(page), PLAIN);
	// For a moment the panel still shows the board as it was. A comment typed there now has no block to go to.
	await page.locator('.kifu-p-comment').click();
	await page.keyboard.type('too late', { delay: 5 });
	await sleep(700);
	assert.equal(await doc(page), PLAIN);
	assert.match((await notices(page))[0], /changed or removed/);
	// The note comes to read what that board once wrote (the same change, made from outside this time)...
	await page.evaluate((t) => {
		const h = window.harness;
		return h.app.vault.modify(h.app.vault.getAbstractFileByPath('N.md'), t);
	}, written);
	await sleep(100);
	assert.equal(await doc(page), written);
	// ...and the board drawn for it is a board of that text: locked, and without the comment nobody saved
	assert.deepEqual(await isEditing(page), [false]);
	assert.doesNotMatch(await page.evaluate(() => document.querySelector('.kifu').textContent), /too late/);
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(blocks(await doc(page))[0], '(;SZ[9]AB[cc][dd][ee])');
});

await scenario('a reading pane that follows late, and a write the editor undoes before the pane has seen it', { files: { 'N.md': PLAIN }, live: ['N.md'], autosave: 1000, lagReading: true, width: 1500 }, async (page) => {
	await page.evaluate(() => { const h = window.harness; h.views.push(h.app.workspace._open('N.md', 'preview')); });
	await sleep(100);
	// in the reading pane: unlock, one stone. It is written through the editor and reaches the file.
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'dd');
	await sleep(1800);
	assert.match(await text(page, 'N.md'), /AB\[cc\]\[dd\]/);
	assert.deepEqual(await stones(page, 1), { black: 2, white: 0 });
	// A second stone: the editor has it, the file not yet. The editor's undo takes it back.
	await clickPoint(page, 1, 'ee');
	await sleep(600);
	assert.match(await doc(page), /\[dd\]\[ee\]/);
	await page.evaluate(() => window.harness.views[0].undo());
	assert.doesNotMatch(await doc(page), /\[ee\]/);
	await sleep(1500);
	// The pane never saw that stone in the note, so nothing told it to draw the board again.
	// The board must not go on showing a stone that is in no note.
	assert.deepEqual(await stones(page, 1), { black: 2, white: 0 });
	assert.doesNotMatch(await text(page, 'N.md'), /\[ee\]/);
});

await browser.close();
process.exit(report() ? 1 : 0);
