// Drives the built plugin in Chromium against the Obsidian stand-in and checks behaviour.
import assert from 'node:assert/strict';
import {
	chromium, runner, out, pointXY, clickPoint, sleep, text, notices, cap, capHidden, stones, labels, lockBtn, tool, boardCount, isEditing, active, toggleLock,
} from './lib.mjs';

const KILL = `(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.]
(;B[ra]C[The middle of three is the vital point.];W[qa];B[sa]C[White has no eyes.])
(;B[qa];W[ra]C[White captures and has two eyes.])
(;B[sa];W[ra]C[White captures and has two eyes.]))`;

const problemNote = ['# Problems', '', 'Intro text.', '', '```kifu', KILL, '```', '', 'Text after the board.', ''].join('\n');

const browser = await chromium.launch();
const { scenario, report } = runner(browser);

/* ------------------------------------------------------------------------- */

for (const mode of ['preview', 'source']) {
	await scenario(`play a problem (${mode})`, { files: { 'P.md': problemNote }, panes: [{ path: 'P.md', mode }] }, async (page) => {
		assert.equal(await boardCount(page), 1);
		assert.equal(await cap(page), 'Black to play and kill.');
		assert.deepEqual(await stones(page), { black: 7, white: 5 });
		// cropped to the corner: 7 columns wide
		const w = await page.evaluate(() => document.querySelector('.kifu-svg').getAttribute('width'));
		assert.equal(w, String(7 * 24));

		// hovering shows a faint stone, but not on an occupied point
		let p = await pointXY(page, 0, 'ra');
		await page.mouse.move(p.x, p.y);
		assert.equal(await page.evaluate(() => document.querySelector('.kifu-ghost').getAttribute('display')), null);
		p = await pointXY(page, 0, 'pa');
		await page.mouse.move(p.x, p.y);
		assert.equal(await page.evaluate(() => document.querySelector('.kifu-ghost').getAttribute('display')), 'none');

		// the lock only shows while the mouse is over the block
		await sleep(250);
		assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kifu-ctl')).opacity), '1');
		await page.mouse.move(5, 5);
		await sleep(250);
		assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kifu-ctl')).opacity), '0');

		// right answer: the saved reply comes back after a pause
		await clickPoint(page, 0, 'ra');
		assert.deepEqual(await stones(page), { black: 8, white: 5 });
		assert.equal(await labels(page), '1');
		assert.equal(await cap(page), 'The middle of three is the vital point.');
		await sleep(500);
		assert.deepEqual(await stones(page), { black: 8, white: 6 });
		assert.equal(await labels(page), '1,2');
		await clickPoint(page, 0, 'sa');
		assert.deepEqual(await stones(page), { black: 9, white: 0 }); // the whole group is captured
		assert.equal(await cap(page), 'CorrectWhite has no eyes.');
		assert.equal(await page.locator('.kifu-verdict.is-correct').count(), 1);

		// reset button appears once something was played
		const reset = page.locator('.kifu-ctl .kifu-btn[aria-label^="Back"]');
		await page.mouse.move(p.x, p.y);
		assert.equal(await reset.isVisible(), true);
		await reset.click();
		assert.deepEqual(await stones(page), { black: 7, white: 5 });
		assert.equal(await reset.isVisible(), false);

		// wrong answer
		await clickPoint(page, 0, 'qa');
		await sleep(500);
		assert.equal(await cap(page), 'IncorrectWhite captures and has two eyes.');
		assert.deepEqual(await stones(page), { black: 7, white: 6 });
		// keyboard: Escape resets, arrows walk the saved lines
		await page.keyboard.press('Escape');
		assert.deepEqual(await stones(page), { black: 7, white: 5 });
		await page.keyboard.press('ArrowRight');
		assert.equal(await labels(page), '1');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowRight');
		assert.equal(await cap(page), 'IncorrectWhite captures and has two eyes.');
		await page.keyboard.press('Home');
		assert.deepEqual(await stones(page), { black: 7, white: 5 });

		// a move that is in no saved line: wrong at once, and nothing is ever written
		await clickPoint(page, 0, 'pe');
		assert.equal(await cap(page), 'Incorrect');
		assert.equal(await text(page, 'P.md'), problemNote);
		assert.equal(await page.evaluate(() => window.harness.app.vault.writes.length), 0);
		if (mode === 'preview') await page.screenshot({ path: `${out}/play-incorrect.png`, clip: { x: 250, y: 20, width: 780, height: 330 } });
	});
}

for (const [label, opts] of [
	['reading view', { mode: 'preview' }],
	['live preview', { mode: 'source' }],
	['live preview, deferred re-render', { mode: 'source', asyncRender: true }],
]) {
	await scenario(`edit a new board (${label})`, { files: { 'N.md': '# New\n\n```kifu\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: opts.mode }], asyncRender: !!opts.asyncRender, autosave: 150 }, async (page) => {
		assert.equal(await page.evaluate(() => document.querySelector('.kifu-svg').getAttribute('width')), String(19 * 24));
		assert.equal(await capHidden(page), true);
		const p = await pointXY(page, 0, 'jj');
		await page.mouse.move(p.x, p.y);
		await lockBtn(page).click();
		assert.equal(await page.locator('.kifu.is-editing').count(), 1);
		assert.equal(await page.locator('.kifu-tools').count(), 1);
		// the panel was brought forward
		assert.deepEqual(await page.evaluate(() => window.harness.app.workspace.revealed), ['kifu-tree']);

		await tool(page, 'Black stone').click();
		for (const pt of ['pd', 'qf', 'qc']) await clickPoint(page, 0, pt);
		await tool(page, 'White stone').click();
		for (const pt of ['nc', 'pb']) await clickPoint(page, 0, pt);
		assert.deepEqual(await stones(page), { black: 3, white: 2 });
		// nothing written yet (edits are batched) ...
		assert.equal(await text(page, 'N.md'), '# New\n\n```kifu\n```\n\nafter\n');
		await sleep(700);
		// ... and then the note holds the position
		const want = '# New\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[pd][qf][qc]AW[nc][pb])\n```\n\nafter\n';
		assert.equal(await text(page, 'N.md'), want);
		// the block was re-rendered from the new text, and we are still editing it
		assert.equal(await boardCount(page), 1);
		assert.equal(await page.locator('.kifu.is-editing').count(), 1);
		assert.equal(await page.locator('.kifu-tools .kifu-btn.is-active[aria-label^="White stone"]').count(), 1);
		assert.deepEqual(await stones(page), { black: 3, white: 2 });
		assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('kifu')), true, 'board kept the keyboard');

		// play tool: a line with a variation, marked wrong
		await tool(page, 'Play moves').click();
		await clickPoint(page, 0, 'kc');
		assert.equal(await labels(page), '1');
		await tool(page, 'Previous move').click();
		await clickPoint(page, 0, 'jc');
		await tool(page, 'Mark this line as incorrect').click();
		assert.equal(await page.locator('.kifu-tools .kifu-btn.is-active[aria-label^="Mark this line as incorrect"]').count(), 1);
		// undo with the keyboard takes the mark back, again removes the move
		await page.keyboard.press('Control+z');
		assert.equal(await page.locator('.kifu-tools .kifu-btn.is-active[aria-label^="Mark this line as incorrect"]').count(), 0);
		await tool(page, 'Mark this line as incorrect').click();

		// marks and labels on the root
		await page.keyboard.press('Home');
		await tool(page, 'Triangle').click();
		await clickPoint(page, 0, 'pd');
		await tool(page, 'Letter or number').click();
		assert.equal(await page.locator('.kifu-label').inputValue(), 'a');
		await clickPoint(page, 0, 'dd');
		await clickPoint(page, 0, 'dp');
		await page.locator('.kifu-label').fill('7');
		await clickPoint(page, 0, 'pp');
		assert.equal(await page.locator('.kifu-label').inputValue(), '8');
		assert.equal(await labels(page), '7,a,b');

		// lock: written at once, cropped to the stones again
		await lockBtn(page).click();
		await sleep(250);
		assert.equal(await page.locator('.kifu.is-editing').count(), 0);
		assert.equal(await page.locator('.kifu-tools').count(), 0);
		const saved = await text(page, 'N.md');
		assert.equal(saved, '# New\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[pd][qf][qc]AW[nc][pb]TR[pd]LB[dd:a][dp:b][pp:7]\n(;B[kc])\n(;B[jc]BM[1]))\n```\n\nafter\n');
		assert.equal(await boardCount(page), 1);
		assert.deepEqual(await page.evaluate(() => window.harness.notices()), []);
		if (opts.mode === 'source') {
			// in an editor the change goes through the editor (so undo works there), then to disk
			assert.equal(await page.evaluate(() => window.harness.views[0].data), saved);
		}
	});
}

await scenario('editing tools, crop and toolbar looks', { files: { 'E.md': problemNote }, panes: [{ path: 'E.md', mode: 'source' }], autosave: 100 }, async (page) => {
	let p = await pointXY(page, 0, 'pc');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	// editing shows the whole board, with the hidden part faded
	assert.equal(await page.evaluate(() => document.querySelector('.kifu-svg').getAttribute('width')), String(19 * 24));
	assert.notEqual(await page.evaluate(() => document.querySelector('.kifu-dim').getAttribute('d')), '');
	await page.screenshot({ path: `${out}/edit-mode.png` });
	// crop by dragging
	await tool(page, 'Choose the part').click();
	const a = await pointXY(page, 0, 'ka');
	const b = await pointXY(page, 0, 'sh');
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
	await page.mouse.move(b.x, b.y);
	await page.mouse.up();
	await sleep(600);
	assert.match(await text(page, 'E.md'), /```kifu\nview: L12-T19\n\(;GM\[1\]/);
	assert.equal(await page.locator('.kifu.is-editing').count(), 1, 'still editing after the block was rewritten');
	// eraser: remove a stone that was set up at the root
	await tool(page, 'Eraser').click();
	await clickPoint(page, 0, 'oa');
	assert.deepEqual(await stones(page), { black: 6, white: 5 });
	// who plays first
	await tool(page, 'Play moves').click();
	await tool(page, 'Play moves').click();
	await lockBtn(page).click();
	await sleep(300);
	const t = await text(page, 'E.md');
	assert.match(t, /AB\[ob\]\[oc\]\[pc\]\[qc\]\[rc\]\[sc\]/);
	assert.match(t, /PL\[W\]/);
	assert.equal(await page.evaluate(() => document.querySelector('.kifu-svg').getAttribute('width')), String(9 * 24));
	// double-click with the crop tool goes back to the automatic view
	await lockBtn(page).click();
	await tool(page, 'Choose the part').click();
	p = await pointXY(page, 0, 'dd');
	await page.mouse.dblclick(p.x, p.y);
	await lockBtn(page).click();
	await sleep(300);
	assert.doesNotMatch(await text(page, 'E.md'), /view:/);
});

const TWINS = '# Twins\n\n```kifu\n```\n\nbetween\n\n```kifu\n```\n\nend\n';

await scenario('same note in two panes, and twin blocks', {
	files: { 'T.md': TWINS },
	panes: [{ path: 'T.md', mode: 'source' }, { path: 'T.md', mode: 'preview' }],
	width: 1500,
	height: 1500,
	autosave: 100,
}, async (page) => {
	assert.equal(await boardCount(page), 4); // two blocks, each shown in both panes
	// unlock the SECOND block in the reading pane (boards 2 and 3 are the reading pane's)
	const p = await pointXY(page, 3, 'jj');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 3).click();
	// only that one board is unlocked: not its twin, and not yet its other self next door
	assert.deepEqual(await isEditing(page), [false, false, false, true]);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 3, 'dd');
	assert.deepEqual(await stones(page, 3), { black: 1, white: 0 });
	for (const i of [0, 1, 2]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	await sleep(700);
	// the edit went into the second block; the same block in the other pane has followed
	assert.equal(await text(page, 'T.md'), '# Twins\n\n```kifu\n```\n\nbetween\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd])\n```\n\nend\n');
	assert.equal(await boardCount(page), 4);
	assert.deepEqual(await isEditing(page), [false, true, false, true]);
	assert.deepEqual(await stones(page, 1), { black: 1, white: 0 });
	for (const i of [0, 2]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	// carry on in the reading pane after the re-render: both panes show the block as it changes
	await clickPoint(page, 3, 'pp');
	assert.deepEqual(await stones(page, 3), { black: 2, white: 0 });
	assert.deepEqual(await stones(page, 1), { black: 2, white: 0 });
	await sleep(700);
	assert.match(await text(page, 'T.md'), /```kifu\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\)/);
	// ...and from the other pane
	await clickPoint(page, 1, 'dp');
	assert.deepEqual(await stones(page, 3), { black: 3, white: 0 });
	await sleep(700);
	assert.match(await text(page, 'T.md'), /```kifu\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\[dp\]\)/);
	// now the first twin, in the editor pane: it is a board of its own
	const q = await pointXY(page, 0, 'jj');
	await page.mouse.move(q.x, q.y);
	await lockBtn(page, 0).click();
	await tool(page, 'White stone', 0).click();
	await clickPoint(page, 0, 'qd');
	await sleep(700);
	assert.match(await text(page, 'T.md'), /```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AW\[qd\]\)\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\[dp\]\)/);
	assert.deepEqual(await stones(page, 0), { black: 0, white: 1 });
	assert.deepEqual(await stones(page, 2), { black: 0, white: 1 });
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
	assert.deepEqual(await page.evaluate(() => window.harness.notices()), []);
});

await scenario('two panes where the reading pane only follows the editor once the note is saved', {
	files: { 'T.md': TWINS },
	panes: [{ path: 'T.md', mode: 'source' }, { path: 'T.md', mode: 'preview' }],
	width: 1500,
	height: 1500,
	autosave: 2200,
	lagReading: true,
}, async (page) => {
	const mark = () => page.evaluate(() => document.querySelectorAll('.kifu').forEach((k, i) => k.setAttribute('data-was', String(i))));
	const marks = () => page.evaluate(() => [...document.querySelectorAll('.kifu')].map((k) => k.getAttribute('data-was')));
	await mark();
	// work on the second block in the READING pane; every write goes through the editor next door
	const p = await pointXY(page, 3, 'jj');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 3).click();
	await tool(page, 'Black stone').click();
	await clickPoint(page, 3, 'dd');
	await sleep(700);
	// the editor has the stone; the reading pane has not been drawn again, yet its board carries on
	assert.match(await page.evaluate(() => window.harness.views[0].data), /between\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\)\n```/);
	assert.equal(await text(page, 'T.md'), TWINS);
	assert.deepEqual(await marks(), ['0', null, '2', '3']);
	assert.deepEqual(await isEditing(page), [false, true, false, true]);
	assert.deepEqual(await stones(page, 3), { black: 1, white: 0 });
	assert.deepEqual(await stones(page, 1), { black: 1, white: 0 });
	// a second and third edit on the board that is still the old drawing, well apart
	await clickPoint(page, 3, 'pp');
	await sleep(1700);
	assert.deepEqual(await isEditing(page), [false, true, false, true]);
	assert.deepEqual(await stones(page, 3), { black: 2, white: 0 });
	await clickPoint(page, 3, 'dp');
	assert.deepEqual(await stones(page, 3), { black: 3, white: 0 });
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
	// let the note be saved: the reading pane is drawn again and the board is still being edited
	await sleep(3200);
	assert.match(await text(page, 'T.md'), /```kifu\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\[dp\]\)\n```/);
	assert.deepEqual(await marks(), ['0', null, '2', null]);
	assert.deepEqual(await isEditing(page), [false, true, false, true]);
	assert.deepEqual(await stones(page, 3), { black: 3, white: 0 });
	for (const i of [0, 2]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	// and it still takes edits
	await clickPoint(page, 3, 'pd');
	await sleep(700);
	assert.match(await page.evaluate(() => window.harness.views[0].data), /AB\[dd\]\[pp\]\[dp\]\[pd\]/);
	assert.deepEqual(await page.evaluate(() => window.harness.notices()), []);
});

await scenario('move tree panel', { files: { 'P.md': problemNote }, panes: [{ path: 'P.md', mode: 'preview' }], autosave: 100 }, async (page) => {
	// the command creates the panel; it starts empty
	await page.evaluate(() => window.harness.app._commands.find((c) => c.id === 'show-tree').callback());
	await sleep(50);
	assert.equal(await page.locator('.kifu-p-empty').isVisible(), true);
	// using a board fills it
	await clickPoint(page, 0, 'ra');
	await sleep(500);
	assert.equal(await page.locator('.kifu-p-empty').isVisible(), false);
	assert.equal(await page.locator('.kifu-p-pos').textContent(), 'Move 2');
	assert.equal(await page.locator('.kifu-p-move').textContent(), 'White 2 · R19');
	assert.equal(await page.locator('.kifu-p-text').textContent(), '');
	const nodes = () =>
		page.evaluate(() => {
			const n = (sel) => (document.querySelector(sel)?.getAttribute('d').match(/M/g) ?? []).length;
			return [n('.kifu-t-b:not(.is-temp)'), n('.kifu-t-w:not(.is-temp)'), n('.kifu-t-other'), document.querySelectorAll('.kifu-t-badge').length];
		});
	// a problem that is being solved: only the moves on the board, and no word on how they will turn out
	assert.deepEqual(await nodes(), [1, 1, 1, 0]);
	assert.equal(await page.locator('.kifu-p-info .kifu-verdict').count(), 0);
	// the eye shows the rest. 8 nodes: root + 3 + 2 + 2
	const eye = page.locator('.kifu-p-nav .kifu-btn[aria-label$="saved lines"], .kifu-p-nav .kifu-btn[aria-label$="lines again"]');
	await eye.click();
	assert.deepEqual(await nodes(), [4, 3, 1, 3]); // 4 black, 3 white, the root, and a verdict on each of the three lines
	assert.equal(await eye.getAttribute('aria-label'), 'Hide the saved lines again');
	await eye.click();
	assert.deepEqual(await nodes(), [1, 1, 1, 0]);
	// starting over hides them again as well
	await eye.click();
	await page.keyboard.press('Escape');
	assert.deepEqual(await nodes(), [0, 0, 1, 0]);
	await clickPoint(page, 0, 'ra');
	await sleep(500);
	await eye.click();
	assert.deepEqual(await nodes(), [4, 3, 1, 3]);
	// navigate with the panel's buttons
	await page.locator('.kifu-p-nav .kifu-btn[aria-label="Next move"]').click();
	assert.equal(await cap(page), 'CorrectWhite has no eyes.');
	assert.equal(await page.locator('.kifu-p-text').textContent(), 'White has no eyes.');
	await page.locator('.kifu-p-nav .kifu-btn[aria-label="First position"]').click();
	assert.deepEqual(await stones(page), { black: 7, white: 5 });
	// click a node in the tree: the second line's reply (column 1, row 2)
	const box = await page.locator('.kifu-t').boundingBox();
	await page.mouse.click(box.x + 6 + 26 * 1 + 13, box.y + 6 + 26 * 2 + 13);
	assert.equal(await page.locator('.kifu-p-move').textContent(), 'White 2 · S19');
	assert.equal(await cap(page), 'IncorrectWhite captures and has two eyes.');
	await page.screenshot({ path: `${out}/panel.png` });
	// arrow keys work in the panel too
	await page.keyboard.press('ArrowLeft');
	assert.equal(await page.locator('.kifu-p-move').textContent(), 'Black 1 · R19');
	// a scratch move shows up dashed and "not saved"
	await clickPoint(page, 0, 'pe');
	assert.equal(await page.locator('.kifu-p-temp').textContent(), 'not saved');
	assert.equal(await page.locator('.kifu-t-w.is-temp').count(), 1);

	// editing a comment from the panel
	await page.locator('.kifu-p-nav .kifu-btn[aria-label="Unlock to edit"]').click();
	assert.equal(await page.locator('.kifu.is-editing').count(), 1);
	assert.equal(await eye.isVisible(), false); // nothing is hidden from the one who edits
	const ta = page.locator('.kifu-p-comment');
	assert.equal(await ta.isVisible(), true);
	await ta.fill('A try at pe.\nSecond line with a ] bracket.');
	await sleep(700);
	const t = await text(page, 'P.md');
	assert.match(t, /;W\[pe\]C\[A try at pe\.\nSecond line with a \\\] bracket\.\]/);
	// typing was not disturbed by the save
	assert.equal(await ta.inputValue(), 'A try at pe.\nSecond line with a ] bracket.');
	assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.kifu-p-comment')), true);
	assert.equal(await page.locator('.kifu.is-editing').count(), 1);
});

await scenario('boards that live in SGF files', {
	files: {
		'games/kill.sgf': KILL,
		'games/pack.sgf': '(;GM[1]SZ[9]AB[cc]AW[dd])\n\n(;GM[1]SZ[9]AB[ee][ff]AW[gg];B[aa])\r\n(;GM[1]SZ[13])',
		'F.md': '# Files\n\n```kifu\nsgf: [[kill.sgf]]\n```\n\nmid\n\n```kifu\nsgf: games/kill.sgf\nview: full\nscale: 50%\n```\n\n```kifu\nsgf: [[pack.sgf]]\ngame: 2\n```\n\n```kifu\nsgf: nowhere.sgf\n```\n\n```kifu\nsgf: [[pack.sgf]]\ngame: 7\n```\n',
	},
	panes: [{ path: 'F.md', mode: 'preview' }],
	autosave: 100,
}, async (page) => {
	await sleep(100);
	assert.equal(await boardCount(page), 5);
	assert.deepEqual(await stones(page, 0), { black: 7, white: 5 });
	assert.deepEqual(await stones(page, 1), { black: 7, white: 5 });
	assert.equal(await page.evaluate(() => document.querySelectorAll('.kifu-svg')[1].getAttribute('width')), String(19 * 12));
	assert.deepEqual(await stones(page, 2), { black: 2, white: 1 });
	const msgs = await page.evaluate(() => [...document.querySelectorAll('.kifu-msg')].map((m) => (m.hidden ? '' : m.textContent)));
	assert.equal(msgs[3], `Kifu: can't find the SGF file "nowhere.sgf".`);
	assert.equal(msgs[4], 'Kifu: "games/pack.sgf" holds 3 games; there is no game 7.');

	// edit the first board: the change goes to the file, and the other board on the same file follows
	const p = await pointXY(page, 0, 'pc');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 0).click();
	await tool(page, 'White stone').click();
	await clickPoint(page, 0, 'dd');
	await sleep(700);
	assert.match(await text(page, 'games/kill.sgf'), /AW\[pa\]\[pb\]\[qb\]\[rb\]\[sb\]\[dd\]/);
	assert.equal(await text(page, 'F.md').then((t) => t.includes('AW[')), false, 'the note keeps pointing at the file');
	assert.deepEqual(await stones(page, 1), { black: 7, white: 6 });
	await lockBtn(page, 0).click();

	// edit game 2 of the collection: only that game changes, byte for byte
	const q = await pointXY(page, 2, 'ee');
	await page.mouse.move(q.x, q.y);
	await lockBtn(page, 2).click();
	await tool(page, 'Triangle').click();
	await clickPoint(page, 2, 'ee');
	await lockBtn(page, 2).click();
	await sleep(300);
	assert.equal(await text(page, 'games/pack.sgf'), '(;GM[1]SZ[9]AB[cc]AW[dd])\n\n(;GM[1]SZ[9]AB[ee][ff]AW[gg]TR[ee];B[aa])\r\n(;GM[1]SZ[13])');

	// the file changes underneath us (sync, another program): open boards reload
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		return v.modify(v.getAbstractFileByPath('games/kill.sgf'), '(;GM[1]SZ[19]AB[dd][de]AW[ee])');
	});
	await sleep(100);
	assert.deepEqual(await stones(page, 0), { black: 2, white: 1 });
	assert.deepEqual(await stones(page, 1), { black: 2, white: 1 });
	assert.deepEqual(await page.evaluate(() => window.harness.notices()), []);
});

await scenario('a file that is not UTF-8 is shown but not edited', {
	files: { 'O.md': '```kifu\nsgf: old.sgf\n```\n', 'old.sgf': '(;GM[1]SZ[9]CA[gb2312]PB[��]AB[ee])' },
	panes: [{ path: 'O.md', mode: 'preview' }],
}, async (page) => {
	// the real bytes: GB2312 for a two-character name
	await page.evaluate(() => {
		const bytes = new Uint8Array([...'(;GM[1]SZ[9]CA[gb2312]PB['].map((c) => c.charCodeAt(0)).concat([0xc0, 0xee, 0xb2, 0xfd], [...']AB[ee])'].map((c) => c.charCodeAt(0))));
		window.harness.app.vault.binary.set('old.sgf', bytes.buffer);
	});
	await page.evaluate(() => window.harness.views[0].renderer.set(''));
	await page.evaluate(() => window.harness.views[0].renderer.set('```kifu\nsgf: old.sgf\n```\n'));
	await sleep(100);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 0 });
	const p = await pointXY(page, 0, 'ee');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 0).click();
	assert.equal(await page.locator('.kifu.is-editing').count(), 0);
	assert.match((await page.evaluate(() => window.harness.notices()))[0], /not saved as UTF-8/);
	// the player's name was decoded for the panel
	await page.evaluate(() => window.harness.app._commands.find((c) => c.id === 'show-tree').callback());
	await clickPoint(page, 0, 'aa');
	await sleep(50);
	assert.equal(await page.locator('.kifu-p-game').textContent(), '李昌');
});

await scenario('blocks in callouts, and saving when the note changed meanwhile', {
	files: { 'C.md': '# Callout\n\n> [!note] A problem\n> ```kifu\n> (;SZ[9]AB[cc])\n> ```\n> closing words\n\nplain\n' },
	panes: [{ path: 'C.md', mode: 'preview' }],
	autosave: 100,
}, async (page) => {
	const p = await pointXY(page, 0, 'cc');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	await tool(page, 'White stone').click();
	await clickPoint(page, 0, 'gg');
	// meanwhile lines are added above the block by something else
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		const f = v.getAbstractFileByPath('C.md');
		// (bypass the open view so its section info is stale, as after an outside edit)
		v.files.get('C.md').data = 'new first line\n\nand another\n\n' + v.files.get('C.md').data;
	});
	await sleep(700);
	assert.equal(await text(page, 'C.md'), 'new first line\n\nand another\n\n# Callout\n\n> [!note] A problem\n> ```kifu\n> (;SZ[9]AB[cc]AW[gg])\n> ```\n> closing words\n\nplain\n');
	// if the block itself is gone, nothing is written and the user is told
	await clickPoint(page, 0, 'hh');
	await page.evaluate(() => { window.harness.app.vault.files.get('C.md').data = 'everything was replaced\n'; });
	await sleep(700);
	assert.equal(await text(page, 'C.md'), 'everything was replaced\n');
	assert.match((await page.evaluate(() => window.harness.notices()))[0], /changed or removed/);
});

await scenario('figures: numbers option, move option, scale and captions', {
	files: { 'G.md': [
		'```kifu', 'numbers: 3-6 from 1', 'caption: Dia. 2', '(;GM[1]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])', '```', '',
		'```kifu', 'move: 2', 'scale: 150%', 'coords: on', 'align: left', 'style: theme', '(;GM[1]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])', '```', '',
		'```kifu', 'numbers: on', '(;SZ[5]AB[ba][ab][bc]AW[ca][bb][db][cc];B[cb];W[ee];B[ed];W[bb])', '```', '',
	].join('\n') },
	panes: [{ path: 'G.md', mode: 'preview' }],
}, async (page) => {
	assert.equal(await labels(page, 0), '1,2,3,4');
	assert.equal(await cap(page, 0), 'Dia. 2');
	assert.deepEqual(await stones(page, 0), { black: 3, white: 3 });
	assert.deepEqual(await stones(page, 1), { black: 1, white: 1 });
	assert.equal(await labels(page, 1), '');
	const cls = await page.evaluate(() => document.querySelectorAll('.kifu')[1].className);
	assert.equal(cls, 'kifu kifu-theme kifu-left');
	// 150 %: 36 px cells, plus the band for coordinates
	const w = await page.evaluate(() => Number(document.querySelectorAll('.kifu-svg')[1].getAttribute('width')));
	const cols = await page.evaluate(() => Number(document.querySelectorAll('.kifu-svg')[1].getAttribute('viewBox').split(' ')[2]));
	assert.equal(w, Math.round((cols * 36) / 100));
	// playing on from "move: 2" numbers the new moves from 1 and follows the game
	await clickPoint(page, 1, 'qf');
	await sleep(500);
	assert.equal(await labels(page, 1), '1,2');
	// the ko figure keeps the captured stone and explains the retake
	assert.equal(await cap(page, 2), '4at B4');
	assert.deepEqual(await stones(page, 2), { black: 5, white: 5 });
	await page.screenshot({ path: `${out}/figures.png` });
});

await scenario('settings page and commands', { files: { 'S.md': '# S\n\n```kifu\n(;SZ[9]AB[cc]AW[dd];B[ee])\n```\n\nline\n' }, panes: [{ path: 'S.md', mode: 'source' }] }, async (page) => {
	const tab = await page.evaluate(() => {
		const t = window.harness.app._settingTabs[0];
		document.getElementById('main').appendChild(t.containerEl);
		t.display();
		return true;
	});
	assert.ok(tab);
	await sleep(50);
	assert.equal(await page.locator('.setting-item').count(), 14); // 12 settings under 2 headings
	assert.equal(await page.locator('.kifu-sample .kifu-svg').count(), 1);
	const before = await page.evaluate(() => document.querySelector('.cm-content .kifu-svg').getAttribute('width'));
	assert.equal(before, String(9 * 24));
	// drag the scale slider to 150 %
	await page.evaluate(() => {
		const range = document.querySelector('.setting-item input[type=range]');
		range.value = '150';
		range.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await sleep(50);
	assert.equal(await page.evaluate(() => document.querySelector('.cm-content .kifu-svg').getAttribute('width')), String(9 * 36));
	assert.equal(await page.evaluate(() => JSON.parse(window.harness.plugin._data).scale), 1.5);
	// coordinates on, theme colours
	await page.evaluate(() => {
		const box = document.querySelectorAll('.setting-item input[type=checkbox]')[0];
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		const sel = document.querySelectorAll('.setting-item select')[0];
		sel.value = 'theme';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await sleep(50);
	assert.equal(await page.evaluate(() => document.querySelector('.cm-content .kifu').className), 'kifu kifu-theme kifu-center');
	assert.ok(await page.evaluate(() => document.querySelectorAll('.cm-content .kifu-coord').length) > 0);
	await page.screenshot({ path: `${out}/settings.png`, fullPage: true });

	// commands: insert a board on an empty line and after a line of text
	const res = await page.evaluate(() => {
		const h = window.harness;
		const ed = h.views[0].editor;
		const cmd = (id) => h.app._commands.find((c) => c.id === id);
		ed.setCursor({ line: 7, ch: 0 });
		cmd('insert-board').editorCallback(ed, h.views[0]);
		const one = ed.getValue();
		ed.setCursor({ line: 0, ch: 2 });
		cmd('insert-board').editorCallback(ed, h.views[0]);
		return { one, two: ed.getValue(), cursor: ed.getCursor() };
	});
	assert.equal(res.one, '# S\n\n```kifu\n(;SZ[9]AB[cc]AW[dd];B[ee])\n```\n\nline\n```kifu\n```\n');
	assert.ok(res.two.startsWith('# S\n```kifu\n```\n\n```kifu\n(;SZ[9]'));
	assert.deepEqual(res.cursor, { line: 3, ch: 0 });
});

await scenario('insert a board from an SGF file', { files: { 'I.md': 'text\n', 'games/a.sgf': '(;SZ[9]AB[ee])', 'b.SGF': '(;SZ[9])', 'c.txt': 'no' }, panes: [{ path: 'I.md', mode: 'source' }] }, async (page) => {
	const res = await page.evaluate(() => {
		const h = window.harness;
		const ed = h.views[0].editor;
		ed.setCursor({ line: 1, ch: 0 });
		h.app._commands.find((c) => c.id === 'insert-sgf').editorCallback(ed, h.views[0]);
		const modal = h.O.Modal.last;
		const items = modal.getItems().map((f) => modal.getItemText(f));
		modal.onChooseItem(modal.getItems()[0]);
		return { items, text: ed.getValue(), open: modal.isOpen };
	});
	assert.deepEqual(res.items, ['games/a.sgf', 'b.SGF']);
	assert.equal(res.open, true);
	assert.equal(res.text, 'text\n```kifu\nsgf: [[a.sgf]]\n```\n');
	await sleep(100);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 0 });
});

await scenario('first enable adds the panel quietly; scrolling a board away keeps its state', { files: { 'P.md': problemNote }, panes: [{ path: 'P.md', mode: 'source' }] }, async (page) => {
	await page.evaluate(() => window.harness.plugin.onUserEnable());
	await sleep(50);
	assert.equal(await page.evaluate(() => window.harness.app.workspace.getLeavesOfType('kifu-tree').length), 1);
	assert.deepEqual(await page.evaluate(() => window.harness.app.workspace.revealed), []);
	await clickPoint(page, 0, 'ra');
	await sleep(500);
	await clickPoint(page, 0, 'sa');
	assert.equal(await cap(page), 'CorrectWhite has no eyes.');
	// the editor drops the widget (scrolled out of view) and builds it again later
	await page.evaluate(() => { const r = window.harness.views[0].renderer; const t = r.text; r.set(''); window.__t = t; });
	assert.equal(await boardCount(page), 0);
	await page.evaluate(() => window.harness.views[0].renderer.set(window.__t));
	assert.equal(await cap(page), 'CorrectWhite has no eyes.');
	assert.deepEqual(await stones(page), { black: 9, white: 0 });
	// a board nobody touched is simply forgotten
	const kept = await page.evaluate(async () => {
		const h = window.harness;
		const before = h.O.Notice.log.length;
		return before;
	});
	assert.equal(kept, 0);
});

await scenario('figure switch, try-again button, and edits that are still pending when the board goes away', {
	files: { 'X.md': '# X\n\n```kifu\n(;SZ[9]AB[cc]AW[gg];B[dd];W[ee];B[ff])\n```\n\nend\n' },
	panes: [{ path: 'X.md', mode: 'source' }],
	autosave: 100,
}, async (page) => {
	// as a problem: follow the line to its end, then "try again" from the caption
	await clickPoint(page, 0, 'dd');
	await sleep(500);
	await clickPoint(page, 0, 'ff');
	assert.equal(await cap(page), 'Correct');
	await page.locator('.kifu-cap .kifu-btn[aria-label="Try again"]').click();
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	assert.equal(await cap(page), 'Black to play');

	// switch it to a numbered figure
	const p = await pointXY(page, 0, 'ee');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	await tool(page, 'When locked, show the moves').click();
	assert.equal(await page.locator('.kifu-tools .kifu-btn.is-active[aria-label^="When locked"]').count(), 1);
	await lockBtn(page).click();
	await sleep(300);
	assert.match(await text(page, 'X.md'), /```kifu\nnumbers: on\n\(;SZ\[9\]/);
	assert.deepEqual(await stones(page), { black: 3, white: 2 });
	assert.equal(await labels(page), '1,2,3');
	assert.equal(await capHidden(page), true);

	// an edit followed at once by the note being closed is still written
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	await tool(page, 'Triangle').click();
	await clickPoint(page, 0, 'cc');
	await page.evaluate(() => {
		const leaf = window.harness.app.workspace._leaves.find((l) => l.view === window.harness.views[0]);
		window.harness.views[0].renderer.set(''); // every block leaves the screen
	});
	await sleep(300);
	// (the mark went on the position the figure shows: its last move)
	assert.match(await text(page, 'X.md'), /;B\[ff\]TR\[cc\]\)/);
});

await scenario('the start switch writes a move line, and the locked board opens there', {
	files: { 'S.md': '# S\n\n```kifu\n(;SZ[9];B[dd];W[ee];B[ff])\n```\n' },
	panes: [{ path: 'S.md', mode: 'preview' }],
}, async (page) => {
	assert.deepEqual(await stones(page), { black: 2, white: 1 }); // a game record rests at its end
	const p = await pointXY(page, 0, 'ee');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	const start = '.kifu-tools .kifu-btn[aria-label^="Open the board at this position"]';
	assert.equal(await page.locator(start + '.is-active').count(), 0);
	await tool(page, 'Previous move').click();
	await tool(page, 'Open the board at this position').click();
	assert.equal(await page.locator(start + '.is-active').count(), 1);
	await tool(page, 'Next move').click();
	assert.equal(await page.locator(start + '.is-active').count(), 0);
	await lockBtn(page).click();
	await sleep(300);
	assert.match(await text(page, 'S.md'), /```kifu\nmove: 2\n\(;SZ\[9\];B\[dd\];W\[ee\];B\[ff\]\)\n```/);
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
});

await scenario('an SGF file that changes while an edit is pending wins', {
	files: { 'games/g.sgf': '(;GM[1]SZ[9]AB[cc])', 'Y.md': '```kifu\nsgf: [[g.sgf]]\n```\n' },
	panes: [{ path: 'Y.md', mode: 'preview' }],
}, async (page) => {
	await sleep(100);
	const p = await pointXY(page, 0, 'cc');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page).click();
	await tool(page, 'White stone').click();
	await clickPoint(page, 0, 'ee');
	// before our write goes out, the file is replaced by something else
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		v.files.get('games/g.sgf').data = '(;GM[1]SZ[9]AB[dd][de])';
	});
	await sleep(700);
	assert.equal(await text(page, 'games/g.sgf'), '(;GM[1]SZ[9]AB[dd][de])');
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	assert.match((await page.evaluate(() => window.harness.notices()))[0], /SGF file was changed/);
	// and editing carries on from the new version
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'games/g.sgf'), '(;GM[1]SZ[9]AB[dd][de]AW[ee])');
});

/* ------------------------------------------------------------ things going wrong */

const ONE = '# N\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n';
const failOnce = (page, method) =>
	page.evaluate((method) => {
		const v = window.harness.app.vault;
		const real = v[method].bind(v);
		let failed = false;
		v[method] = async (...a) => {
			if (!failed) {
				failed = true;
				throw new Error('EBUSY: resource busy or locked');
			}
			return real(...a);
		};
	}, method);

await scenario('a note that can not be written: the edit stays on the board and is written later', {
	files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, allowErrors: /writing the note failed|EBUSY/,
}, async (page) => {
	await failOnce(page, 'process');
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'N.md'), ONE);
	assert.match((await notices(page))[0], /could not be written.*still on the board/);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	assert.deepEqual(await isEditing(page), [true]);
	// locking writes at once, and this time it works
	await toggleLock(page);
	await sleep(400);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc][ee]'));
	assert.deepEqual(await isEditing(page), [false]);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	// and editing carries on normally
	await toggleLock(page);
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc][ee][gg]'));
	assert.equal((await notices(page)).length, 1);
});

await scenario('an SGF file that can not be written: the same', {
	files: { 'g.sgf': '(;GM[1]SZ[9]AB[cc])', 'Y.md': '```kifu\nsgf: [[g.sgf]]\n```\n' }, panes: [{ path: 'Y.md', mode: 'preview' }], autosave: 100,
	allowErrors: /writing the SGF file failed|EBUSY/,
}, async (page) => {
	await sleep(100);
	await failOnce(page, 'process');
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9]AB[cc])');
	assert.match((await notices(page))[0], /SGF file could not be written.*still on the board/);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	await toggleLock(page);
	await sleep(400);
	assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9]AB[cc][ee])');
	await toggleLock(page);
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9]AB[cc][ee][gg])');
	assert.equal(await text(page, 'Y.md'), '```kifu\nsgf: [[g.sgf]]\n```\n');
	assert.equal((await notices(page)).length, 1);
});

await scenario('a note and an SGF file with the same name: the board is the SGF file, and only it is written', {
	files: {
		'Game notes.md': '# Game notes\n\nPlayed online (blitz; 10 min each).\n',
		'Game notes.sgf': '(;GM[1]SZ[9]AB[cc]AW[gg];B[dd])',
		'N.md': '```kifu\nsgf: [[Game notes]]\n```\n',
	},
	panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	await sleep(100);
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'Game notes.md'), '# Game notes\n\nPlayed online (blitz; 10 min each).\n');
	assert.equal(await text(page, 'Game notes.sgf'), '(;GM[1]SZ[9]AB[cc][ee]AW[gg];B[dd])');
	assert.deepEqual(await notices(page), []);
});

await scenario('an SGF file that is saved in another encoding while its board is open', {
	files: { 'g.sgf': '(;GM[1]SZ[9]CA[gb2312]PB[Li]AB[cc])', 'Y.md': '```kifu\nsgf: g.sgf\n```\n' }, panes: [{ path: 'Y.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	await sleep(100);
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [true]);
	// another program rewrites the file in GB2312; plugins are handed U+FFFD for the bytes that are not UTF-8
	const broken = '(;GM[1]SZ[9]CA[gb2312]PB[����]AB[cc][dd])';
	await page.evaluate((t) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('g.sgf'), t); }, broken);
	await sleep(150);
	// the board shows the new game and has locked itself; it can not be unlocked again
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	assert.deepEqual(await isEditing(page), [false]);
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [false]);
	assert.match((await notices(page))[0], /not saved as UTF-8/);
	await sleep(600);
	assert.equal(await text(page, 'g.sgf'), broken);
	assert.equal(await page.evaluate(() => window.harness.app.vault.writes.length), 1); // the other program's, none of ours
});

await scenario('the label box keeps the keyboard when a save redraws the board (reading view)', { files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Letter or number').click();
	await clickPoint(page, 0, 'ee');
	await page.locator('.kifu-label').click();
	await page.keyboard.type('1');
	await sleep(600);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc]LB[ee:a]'));
	assert.equal(await active(page), 'INPUT.kifu-label');
	await page.keyboard.type('2');
	assert.equal(await page.locator('.kifu-label').inputValue(), '12');
	await clickPoint(page, 0, 'gg');
	await sleep(600);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc]LB[ee:a][gg:12]'));
	assert.equal(await active(page), 'DIV.kifu');
});

await scenario('switching the plugin off: what was pending is written, and the boards left on the page do nothing', {
	files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await page.evaluate(() => window.harness.plugin.unload()); // inside the 400 ms before the edit is written
	await sleep(300);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc][ee]'));
	// (without the plugin the block is drawn as plain code from now on; a board that is still there is a picture)
	const left = await boardCount(page);
	if (left) {
		await clickPoint(page, 0, 'gg');
		await sleep(600);
	}
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc][ee]'));
	assert.equal(await page.locator('.kifu-tools').count(), 0);
	assert.deepEqual(await notices(page), []);
});

await scenario('identical boards in a reading view that keeps only one of them on the page at a time', {
	files: { 'T.md': '# Twins\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n' }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1400,
}, async (page) => {
	// a reading view takes sections that are far off screen out of the page without unloading them
	await page.evaluate(() => {
		const r = window.harness.views[0].renderer;
		const set = r.set.bind(r);
		const hidden = new Set();
		r.set = (t) => {
			set(t);
			r.rendered.filter((x) => x.sec.type === 'code').forEach((x, i) => { if (hidden.has(i)) x.el.remove(); });
		};
		window.showOnly = (keep) => {
			hidden.clear();
			hidden.add(1 - keep);
			r.set(r.text);
		};
	});
	await page.evaluate(() => window.showOnly(0));
	assert.equal(await boardCount(page), 1);
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.match(await text(page, 'T.md'), /AB\[cc\]\[ee\]\)\n```\n\nbetween\n\n```kifu\n\(;SZ\[9\]AB\[cc\]\)\n/);
	// scroll: the first leaves the page, the second comes back as it was
	await page.evaluate(() => window.showOnly(1));
	assert.equal(await boardCount(page), 1);
	assert.deepEqual(await isEditing(page), [false]);
	assert.deepEqual(await stones(page), { black: 1, white: 0 });
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.match(await text(page, 'T.md'), /AB\[cc\]\[ee\]\)\n```\n\nbetween\n\n```kifu\n\(;SZ\[9\]AB\[cc\]\[gg\]\)\n/);
	assert.deepEqual(await notices(page), []);
});

const SAME = '# Twins\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n';
await scenario('identical boards: the renderer may re-use the drawing of the one that was edited for its twin', {
	files: { 'T.md': SAME }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1400,
}, async (page) => {
	// (this stand-in matches old drawings to new sections by their text, first come first served:
	// after the first board is edited, its old drawing is what the second block gets)
	await page.evaluate(() => document.querySelectorAll('.kifu')[0].setAttribute('data-was', 'first'));
	await toggleLock(page, 0);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), SAME.replace('AB[cc]', 'AB[cc][ee]'));
	assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.kifu')].map((k) => k.getAttribute('data-was'))), [null, 'first']);
	// each board shows its own block all the same
	assert.deepEqual(await isEditing(page), [true, false]);
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 2, white: 0 }, { black: 1, white: 0 }]);
	// and the second is a board of its own
	await toggleLock(page, 1);
	await tool(page, 'White stone', 1).click();
	await clickPoint(page, 1, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), '# Twins\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc]AW[gg])\n```\n\nend\n');
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 2, white: 0 }, { black: 1, white: 1 }]);
	assert.deepEqual(await notices(page), []);
});

await scenario('a reading pane that draws a text the board has already moved on from', {
	files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'source' }, { path: 'N.md', mode: 'preview' }], width: 1500, autosave: 60000, lagReading: true,
}, async (page) => {
	// work in the reading pane; the editor next door takes the writes, the reading pane sees none of them
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	await sleep(600);
	const first = await page.evaluate(() => window.harness.views[0].data);
	assert.equal(first, ONE.replace('AB[cc]', 'AB[cc][ee]'));
	await clickPoint(page, 1, 'gg');
	await sleep(600);
	assert.equal(await page.evaluate(() => window.harness.views[0].data), ONE.replace('AB[cc]', 'AB[cc][ee][gg]'));
	// now the reading pane catches up half way: it draws the text of the first write
	await page.evaluate((t) => window.harness.views[1].renderer.set(t), first);
	await sleep(50);
	// its new drawing is still that board: unlocked, and showing what the board holds now
	assert.deepEqual(await isEditing(page), [true, true]);
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
	await clickPoint(page, 1, 'aa');
	await sleep(600);
	assert.equal(await page.evaluate(() => window.harness.views[0].data), ONE.replace('AB[cc]', 'AB[cc][ee][gg][aa]'));
	assert.deepEqual(await notices(page), []);
});

for (const mode of ['preview', 'source']) {
	await scenario(`a sequence drawn with the play tool is what the locked board shows (${mode})`, {
		files: { 'N.md': '# New\n\n```kifu\nsize: 9\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode }], autosave: 100,
	}, async (page) => {
		await toggleLock(page);
		// the play tool is the one that is selected to begin with: colours alternate, moves are numbered
		for (const pt of ['ee', 'ce', 'ec']) await clickPoint(page, 0, pt);
		assert.deepEqual(await stones(page), { black: 2, white: 1 });
		assert.equal(await labels(page), '1,2,3');
		await toggleLock(page);
		await sleep(300);
		assert.equal(await text(page, 'N.md'), '# New\n\n```kifu\nsize: 9\n(;GM[1]FF[4]CA[UTF-8]SZ[9];B[ee];W[ce];B[ec])\n```\n\nafter\n');
		// locked: the position, as a book would print it (the figure switch adds the numbers)
		assert.deepEqual(await isEditing(page), [false]);
		assert.deepEqual(await stones(page), { black: 2, white: 1 });
		assert.equal(await labels(page), '');
		assert.equal(await capHidden(page), true);
		// stepping back and forth, and playing on from the end, still work from there
		await page.keyboard.press('ArrowLeft');
		assert.deepEqual(await stones(page), { black: 1, white: 1 });
		await page.keyboard.press('Home');
		assert.deepEqual(await stones(page), { black: 0, white: 0 });
		await page.keyboard.press('Escape');
		assert.deepEqual(await stones(page), { black: 2, white: 1 });
		await clickPoint(page, 0, 'gg');
		assert.deepEqual(await stones(page), { black: 2, white: 2 });
		assert.equal(await labels(page), '1');
		await page.keyboard.press('Escape');
		assert.equal(await text(page, 'N.md'), '# New\n\n```kifu\nsize: 9\n(;GM[1]FF[4]CA[UTF-8]SZ[9];B[ee];W[ce];B[ec])\n```\n\nafter\n');
		assert.deepEqual(await notices(page), []);
	});
}

/* ------------------------------------------------------- what a second review turned up */

/* A refused edit must not come back later and land in the block that merely reads the same. */
const noLines = (page, path) =>
	page.evaluate((path) => {
		const h = window.harness;
		const real = h.app._processors.get('kifu');
		h.app._processors.set('kifu', (src, el, ctx) => real(src, el, { ...ctx, addChild: ctx.addChild, getSectionInfo: () => null }));
		h.views = [h.app.workspace._open(path, 'preview')];
	}, path);
for (const which of ['the board that was edited', 'the other board']) {
	await scenario(`identical boards and no line numbers: the edit is refused, then ${which} gets a caption`, { files: { 'T.md': SAME }, panes: [], autosave: 100, height: 1500 }, async (page) => {
		await noLines(page, 'T.md');
		await sleep(60);
		await toggleLock(page, 1);
		await tool(page, 'Black stone').click();
		await clickPoint(page, 1, 'ee'); // on the second board
		await sleep(700);
		assert.equal(await text(page, 'T.md'), SAME);
		assert.match((await notices(page))[0], /several boards with the same text/);
		// the user does what the notice says, in the note's text
		const next = which === 'the board that was edited'
			? SAME.replace('between\n\n```kifu\n', 'between\n\n```kifu\ncaption: second\n')
			: SAME.replace('# Twins\n\n```kifu\n', '# Twins\n\n```kifu\ncaption: first\n');
		await page.evaluate((t) => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('T.md'), t); }, next);
		await sleep(900);
		// The stone that was refused is not slipped into either block behind the user's back:
		// which block it belonged to is exactly what could not be told.
		assert.equal(await text(page, 'T.md'), next);
		// making the edit again, now that the two differ, works
		const i = which === 'the board that was edited' ? 1 : 1;
		if (!(await isEditing(page))[i]) await toggleLock(page, i);
		await tool(page, 'White stone', (await isEditing(page))[0] ? 1 : 0).click();
		await clickPoint(page, i, 'gg');
		await sleep(700);
		const now = await text(page, 'T.md');
		assert.match(now, /\(;SZ\[9\]AB\[cc\]\)\n```\n\nbetween/); // the first block: untouched
		assert.match(now, /between\n\n```kifu\n(caption: second\n)?\(;SZ\[9\]AB\[cc\](\[ee\])?AW\[gg\]\)/);
	});
}

await scenario('identical boards in a note with CR LF line endings, and a renderer that re-uses drawings', {
	files: { 'T.md': SAME.replace(/\n/g, '\r\n') }, panes: [{ path: 'T.md', mode: 'preview' }], autosave: 100, height: 1400,
}, async (page) => {
	const crlf = (t) => t.replace(/\n/g, '\r\n');
	await toggleLock(page, 0);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), crlf(SAME.replace('AB[cc]', 'AB[cc][ee]')));
	assert.deepEqual(await isEditing(page), [true, false]);
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 2, white: 0 }, { black: 1, white: 0 }]);
	await toggleLock(page, 1);
	await tool(page, 'White stone', 1).click();
	await clickPoint(page, 1, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'T.md'), crlf('# Twins\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc]AW[gg])\n```\n\nend\n'));
	assert.deepEqual(await notices(page), []);
});

for (const mode of ['preview', 'source']) {
	await scenario(`identical boards, one unlocked, and the whole note is drawn again (${mode})`, { files: { 'T.md': SAME }, panes: [{ path: 'T.md', mode }], autosave: 100, height: 1400 }, async (page) => {
		await toggleLock(page, 1);
		assert.deepEqual(await isEditing(page), [false, true]);
		await page.evaluate(() => { const r = window.harness.views[0].renderer; window.__t = r.text; r.set(''); });
		await sleep(50);
		await page.evaluate(() => window.harness.views[0].renderer.set(window.__t));
		await sleep(100);
		// which of the two was the unlocked one can not be known once both are drawn anew:
		// neither is, rather than the wrong one
		assert.deepEqual(await isEditing(page), [false, false]);
	});
}

await scenario('a board that could not show its SGF file does so once the file can be shown', {
	files: { 'g.sgf': '', 'c.sgf': '(;GM[1]SZ[9]AB[aa])', 'N.md': '```kifu\nsgf: g.sgf\n```\n\n```kifu\nsgf: c.sgf\ngame: 2\n```\n' },
	panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	const said = () => page.evaluate(() => [...document.querySelectorAll('.kifu-msg')].map((m) => (m.hidden ? '' : m.textContent)));
	await sleep(150);
	assert.deepEqual(await said(), ['Kifu: "g.sgf" has no game in it.', 'Kifu: "c.sgf" holds 1 game; there is no game 2.']);
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		return Promise.all([
			v.modify(v.getAbstractFileByPath('g.sgf'), '(;GM[1]SZ[9]AB[cc])'),
			v.modify(v.getAbstractFileByPath('c.sgf'), '(;GM[1]SZ[9]AB[aa])\n(;GM[1]SZ[9]AB[bb][cc])'),
		]);
	});
	await sleep(600);
	assert.deepEqual(await said(), ['', '']);
	assert.deepEqual([await stones(page, 0), await stones(page, 1)], [{ black: 1, white: 0 }, { black: 2, white: 0 }]);
});

await scenario('boards on a canvas card can be played but not unlocked, whether their game is in the card or in a file', {
	files: { 'C.canvas': '{"nodes":[]}', 'g.sgf': '(;GM[1]SZ[9]AB[cc])' }, panes: [], autosave: 100, height: 1200,
}, async (page) => {
	// (a canvas draws a card's text with the note renderer, under the canvas file's own path)
	await page.evaluate(() => {
		const h = window.harness;
		const host = document.createElement('div');
		host.className = 'workspace-leaf';
		document.getElementById('main').appendChild(host);
		const comp = new h.O.Component();
		comp.load();
		for (const src of ['sgf: g.sgf\n', '(;SZ[9]AB[cc])\n']) {
			const el = document.createElement('div');
			el.className = 'block-language-kifu';
			host.appendChild(el);
			h.app._processors.get('kifu')(src, el, { docId: 'x', sourcePath: 'C.canvas', frontmatter: null, addChild: (c) => comp.addChild(c), getSectionInfo: () => null });
		}
	});
	await sleep(150);
	assert.equal(await boardCount(page), 2);
	await toggleLock(page, 0);
	await toggleLock(page, 1);
	assert.deepEqual(await isEditing(page), [false, false]);
	assert.match((await notices(page))[0], /canvas card/);
	await clickPoint(page, 1, 'ee'); // playing is fine
	assert.deepEqual(await stones(page, 1), { black: 1, white: 1 });
	await sleep(600);
	assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9]AB[cc])');
	assert.equal(await text(page, 'C.canvas'), '{"nodes":[]}');
});

await scenario('the note and its SGF file are renamed while edits are waiting to be written', {
	files: { 'g.sgf': '(;GM[1]SZ[9]AB[cc])', 'A.md': '```kifu\nsgf: g.sgf\n```\n\n```kifu\n(;SZ[9]AB[dd])\n```\n' }, panes: [{ path: 'A.md', mode: 'preview' }], autosave: 100, height: 1300,
}, async (page) => {
	await sleep(150);
	await toggleLock(page, 0);
	await toggleLock(page, 1);
	await tool(page, 'Black stone', 0).click();
	await tool(page, 'Black stone', 1).click();
	await clickPoint(page, 0, 'ee');
	await clickPoint(page, 1, 'ee');
	await page.evaluate(() => {
		const v = window.harness.app.vault;
		v._rename(v.getAbstractFileByPath('g.sgf'), 'games/h.sgf');
		v._rename(v.getAbstractFileByPath('A.md'), 'Z.md');
	});
	await sleep(900);
	assert.equal(await text(page, 'games/h.sgf'), '(;GM[1]SZ[9]AB[cc][ee])');
	assert.equal(await text(page, 'Z.md'), '```kifu\nsgf: g.sgf\n```\n\n```kifu\n(;SZ[9]AB[dd][ee])\n```\n');
	assert.deepEqual(await notices(page), []);
});

await scenario('Escape in the middle of dragging a crop (reading view)', { files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100 }, async (page) => {
	await toggleLock(page);
	await tool(page, 'Choose the part').click();
	const a = await pointXY(page, 0, 'aa');
	const b = await pointXY(page, 0, 'ee');
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
	await page.mouse.move(b.x, b.y);
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await sleep(700);
	assert.deepEqual(await isEditing(page), [true]);
	assert.equal(await text(page, 'N.md'), ONE);
	// a drag that is finished still sets the crop
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y);
	await page.mouse.up();
	await sleep(700);
	assert.equal(await text(page, 'N.md'), ONE.replace('(;SZ', 'view: A5-E9\n(;SZ'));
});

await browser.close();
process.exit(report() ? 1 : 0);
