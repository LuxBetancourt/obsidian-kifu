// Drives the built plugin in Chromium against the Obsidian stand-in and checks behaviour.
import assert from 'node:assert/strict';
import {
	chromium, runner, out, pointXY, clickPoint, sleep, text, notices, cap, capHidden, stones, labels, lockBtn, tool, boardCount, isEditing, active, toggleLock, doc,
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

await scenario('in the reading view a board has no lock, and is only played', {
	files: { 'N.md': '# New\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100,
}, async (page) => {
	const p = await pointXY(page, 0, 'ee');
	await page.mouse.move(p.x, p.y);
	assert.equal(await lockBtn(page).isHidden(), true);
	// a click plays a move (White's, as Black has set up a stone)
	await page.mouse.click(p.x, p.y);
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	// the panel's lock does not unlock it either (nor is it shown there)
	await page.evaluate(() => window.harness.plugin.toggleLock(window.harness.plugin.activeSession));
	assert.deepEqual(await isEditing(page), [false]);
	await page.evaluate(() => window.harness.plugin.showPanel(false));
	await sleep(100);
	assert.equal(await page.locator('#right .kifu-btn[aria-label="Unlock to edit"]').isHidden(), true);
	// and nothing is written
	await sleep(400);
	assert.equal(await text(page, 'N.md'), '# New\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nafter\n');
});

await scenario('a board left unlocked is locked, and its edit written, once the note is shown only in the reading view', {
	files: { 'N.md': '# New\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100, saveDelay: 5000,
}, async (page) => {
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	// the note is switched to the reading view before the edit is written
	await page.evaluate(() => {
		const h = window.harness;
		h.app.workspace._leaves.find((l) => l.view === h.views[0]).detach();
		h.views = [h.app.workspace._open('N.md', 'preview')];
	});
	await sleep(1000);
	assert.deepEqual(await isEditing(page), [false]);
	assert.equal(await lockBtn(page).isHidden(), true);
	assert.equal(await page.locator('.kifu-tools').count(), 0);
	assert.equal(await text(page, 'N.md'), '# New\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nafter\n');
	assert.deepEqual(await notices(page), []);
});

for (const answer of ['Save', 'Discard', 'neither (the prompt is closed)']) {
	await scenario(`moves played on a locked board: unlocking asks whether to keep them; ${answer}`, {
		files: { 'N.md': '# New\n\n```kifu\n(;SZ[9])\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
	}, async (page) => {
		const start = '# New\n\n```kifu\n(;SZ[9])\n```\n\nafter\n';
		await clickPoint(page, 0, 'ee');
		await clickPoint(page, 0, 'gg');
		assert.deepEqual(await stones(page), { black: 1, white: 1 });
		await toggleLock(page);
		// not unlocked yet: asked first
		const prompt = () => page.evaluate(() => {
			const m = window.__obsidian.Modal.last;
			return m?.isOpen ? { title: m.title, text: m.contentEl.querySelector('p').textContent, buttons: [...m.contentEl.querySelectorAll('button')].map((b) => b.textContent) } : null;
		});
		assert.deepEqual(await prompt(), {
			title: 'Keep the moves you played?',
			text: "You played 2 moves on this board while it was locked. Save them as part of the board's moves, or discard them and edit the board as it was.",
			buttons: ['Discard', 'Save'],
		});
		assert.deepEqual(await isEditing(page), [false]);
		if (answer === 'Save' || answer === 'Discard') {
			await page.locator('.modal-content button', { hasText: answer }).click();
			assert.equal(await prompt(), null);
			assert.deepEqual(await isEditing(page), [true]);
			await sleep(700);
			if (answer === 'Save') {
				assert.deepEqual(await stones(page), { black: 1, white: 1 });
				assert.match(await doc(page), /;B\[ee\];W\[gg\]\)\n```/);
			} else {
				assert.deepEqual(await stones(page), { black: 0, white: 0 });
				assert.equal(await doc(page), start);
			}
		} else {
			await page.evaluate(() => window.__obsidian.Modal.last.close());
			// still locked, with the moves still on the board, and nothing written
			assert.deepEqual(await isEditing(page), [false]);
			assert.deepEqual(await stones(page), { black: 1, white: 1 });
			await sleep(400);
			assert.equal(await doc(page), start);
		}
		assert.deepEqual(await notices(page), []);
	});
}

await scenario('a board unlocked with no moves played on it is not asked about', {
	files: { 'N.md': '# New\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
}, async (page) => {
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [true]);
	assert.equal(await page.evaluate(() => window.__obsidian.Modal.last?.isOpen ?? false), false);
});

await scenario('a locked game record has a play button that plays it through a move at a time; a problem has none', {
	files: { 'N.md': '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee];W[cc];B[gg])\n```\n\n```kifu\n' + KILL + '\n```\n' }, panes: [{ path: 'N.md', mode: 'preview' }], autosave: 100, height: 1400,
}, async (page) => {
	const play = (i) => page.locator('.kifu').nth(i).locator('.kifu-ctl .kifu-btn[aria-label="Play through the game"], .kifu-ctl .kifu-btn[aria-label="Pause"]');
	// (also in the reading view: it is a way of looking at the board)
	assert.equal(await play(0).isHidden(), false);
	assert.equal(await play(1).isHidden(), true); // the problem: that would give its answer away
	assert.deepEqual(await stones(page, 0), { black: 2, white: 1 }); // a record rests at its end
	await play(0).click();
	// it starts over, and plays a move each second
	assert.deepEqual(await stones(page, 0), { black: 0, white: 0 });
	assert.equal(await play(0).getAttribute('aria-label'), 'Pause');
	await sleep(1150);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 0 });
	await sleep(1000);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 1 });
	// paused: it stays there
	await play(0).click();
	assert.equal(await play(0).getAttribute('aria-label'), 'Play through the game');
	await sleep(1300);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 1 });
	// on again, to the end, where it stops by itself
	await play(0).click();
	await sleep(1150);
	assert.deepEqual(await stones(page, 0), { black: 2, white: 1 });
	assert.equal(await play(0).getAttribute('aria-label'), 'Play through the game');
	assert.equal(await text(page, 'N.md'), '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee];W[cc];B[gg])\n```\n\n```kifu\n' + KILL + '\n```\n');
});

await scenario('the play button is gone while the board is unlocked', {
	files: { 'N.md': '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee];W[cc];B[gg])\n```\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
}, async (page) => {
	const play = page.locator('.kifu-ctl .kifu-btn[aria-label="Play through the game"], .kifu-ctl .kifu-btn[aria-label="Pause"]');
	await play.click();
	assert.equal(await play.getAttribute('aria-label'), 'Pause');
	// unlocking stops it (and there are no moves played to be asked about)
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [true]);
	assert.equal(await play.isHidden(), true);
	await toggleLock(page);
	assert.equal(await play.isHidden(), false);
	assert.equal(await play.getAttribute('aria-label'), 'Play through the game');
});

await scenario('while editing, the stone of the current move can be dragged to another point', {
	files: { 'N.md': '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee];W[cc];B[gg])\n```\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
}, async (page) => {
	await toggleLock(page);
	const drag = async (from, to) => {
		const a = await pointXY(page, 0, from);
		const b = await pointXY(page, 0, to);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
		await page.mouse.move(b.x, b.y, { steps: 3 });
		await page.mouse.up();
		await sleep(700);
	};
	// while it is dragged, the stone (with its number) is drawn where it would land
	const label3 = () => page.evaluate(() => {
		const t = [...document.querySelectorAll('.kifu-svg .kifu-text')].find((e) => e.textContent === '3');
		return t ? [Math.round(Number(t.getAttribute('x'))), Math.round(Number(t.getAttribute('y')))] : null;
	});
	assert.deepEqual(await label3(), [650, 672]); // G3 (the text sits a little below the centre)
	{
		const a = await pointXY(page, 0, 'gg');
		const b = await pointXY(page, 0, 'hh');
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(b.x, b.y, { steps: 4 });
		assert.deepEqual(await label3(), [750, 772]); // H2, before it is let go
		await page.mouse.move(a.x, a.y, { steps: 4 });
		assert.deepEqual(await label3(), [650, 672]); // and back
		await page.mouse.up();
		await sleep(700);
		assert.match(await doc(page), /;B\[ee\];W\[cc\];B\[gg\]\)/); // dropped where it was: nothing changed
	}
	// the last move (the current one) goes from G3 to H2; nothing is played at H2 besides
	await drag('gg', 'hh');
	assert.match(await doc(page), /;B\[ee\];W\[cc\];B\[hh\]\)/);
	assert.deepEqual(await stones(page), { black: 2, white: 1 });
	// onto another stone: it stays where it was
	await drag('hh', 'ee');
	assert.match(await doc(page), /;B\[ee\];W\[cc\];B\[hh\]\)/);
	// an earlier move, once it is the current one: the moves after it stay
	await tool(page, 'Previous move').click();
	await drag('cc', 'dc');
	assert.match(await doc(page), /;B\[ee\];W\[dc\];B\[hh\]\)/);
	// undone in one step
	await page.keyboard.press('Control+z');
	await sleep(700);
	assert.match(await doc(page), /;B\[ee\];W\[cc\];B\[hh\]\)/);
	assert.deepEqual(await notices(page), []);
});

{
	const news = (page) => page.evaluate(() => {
		const m = window.__obsidian.Modal.last;
		return m?.isOpen ? {
			title: m.title,
			items: [...m.contentEl.querySelectorAll('.kifu-news-item h3')].map((h) => h.textContent),
			gifs: [...m.contentEl.querySelectorAll('img.kifu-news-gif')].map((i) => i.getAttribute('src')),
		} : null;
	});
	const saved = (page) => page.evaluate(() => JSON.parse(window.harness.plugin._data));
	for (const [label, data, want] of [
		['an update from 1.6.3: once, the news of 1.6.4', { seenVersion: '1.6.3' }, true],
		['an update from a version that kept no record (before 1.6.4): the news too', {}, true],
		['an update, with the setting off: nothing shown', { seenVersion: '1.6.3', whatsNew: false }, false],
		['a fresh install (no settings file yet): nothing shown', 'none', false],
		['the same version started again: nothing shown', { seenVersion: '1.6.4' }, false],
	]) {
		await scenario(`what's new after an update: ${label}`, { files: { 'N.md': 'text\n' }, panes: [], version: '1.6.4', newsDelay: 150, data }, async (page) => {
			// (the animations: answered here, never fetched from GitHub by the checks)
			await page.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
			// (Obsidian says the plugin was switched on by the user after an install, and after an update too)
			await page.evaluate(() => window.harness.plugin.onUserEnable());
			await sleep(400);
			const shown = await news(page);
			if (!want) {
				assert.equal(shown, null);
			} else {
				assert.deepEqual(shown, {
					title: "What's new in Kifu 1.6.4",
					items: ['Drag a stone to move it', 'Embed an SGF file at a move', 'Josekipedia'],
					// (from the repository, at the version's own tag: the plugin does not carry them)
					gifs: ['drag', 'embed', 'josekipedia'].map((g) => `https://raw.githubusercontent.com/LuxBetancourt/obsidian-kifu/1.6.4/docs/whatsnew/${g}.gif`),
				});
			}
			// either way the version counts as seen: the next start shows nothing
			assert.equal((await saved(page)).seenVersion, '1.6.4');
			if (want) {
				// and the window can turn itself off for later updates
				await page.locator('.modal-content button', { hasText: "Don't show this after updates" }).click();
				assert.equal(await news(page), null);
				assert.equal((await saved(page)).whatsNew, false);
			}
		});
	}

	await scenario("what's new, offline: a line where an animation could not be loaded", { allowErrors: /Failed to load resource: net::ERR_FAILED/, files: { 'N.md': 'text\n' }, panes: [], version: '1.6.4', newsDelay: 150, data: { seenVersion: '1.6.3' } }, async (page) => {
		await page.route('https://raw.githubusercontent.com/**', (r) => r.abort());
		await sleep(600);
		assert.deepEqual((await news(page)).items, ['Drag a stone to move it', 'Embed an SGF file at a move', 'Josekipedia']);
		assert.deepEqual(await page.locator('.kifu-news-missing').allTextContents(), Array(3).fill('The animation could not be loaded.'));
	});
}

await scenario('game info: players, ranks, komi and the rest, in a form, written into the game', {
	files: { 'N.md': '# Game\n\n```kifu\n(;GM[1]SZ[9]PB[Lee];B[ee])\n```\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
}, async (page) => {
	await toggleLock(page);
	await tool(page, 'Game info').click();
	const form = page.locator('.modal-content.kifu-game-info');
	assert.deepEqual(await form.locator('.setting-item-name').allTextContents(), ['Game name', 'Event', 'Round', 'Date', 'Place', 'Black', 'Black rank', 'White', 'White rank', 'Komi', 'Handicap', 'Rules', 'Result', 'Source']);
	const field = (id) => form.locator(`input[data-prop="${id}"]`);
	assert.equal(await field('PB').inputValue(), 'Lee'); // what the game says already
	await field('BR').fill('9p');
	await field('PW').fill('AlphaGo');
	await field('KM').fill('7.5');
	await field('RE').fill('W+R');
	await form.locator('button', { hasText: 'Save' }).click();
	await sleep(700);
	assert.match(await doc(page), /\(;GM\[1\]SZ\[9\]PB\[Lee\]BR\[9p\]PW\[AlphaGo\]KM\[7\.5\]RE\[W\+R\];B\[ee\]\)/);
	// Cancel changes nothing
	await tool(page, 'Game info').click();
	await field('PB').fill('someone else');
	await form.locator('button', { hasText: 'Cancel' }).click();
	await sleep(700);
	assert.match(await doc(page), /PB\[Lee\]/);
	assert.deepEqual(await notices(page), []);
});

await scenario('the pass button in the editing toolbar records a pass for the side to play', {
	files: { 'N.md': '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee])\n```\n' }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
}, async (page) => {
	await toggleLock(page);
	const tools = await page.locator('.kifu-tools .kifu-btn').evaluateAll((bs) => bs.slice(0, 3).map((b) => b.getAttribute('aria-label')));
	assert.deepEqual(tools, ['Play moves (click again to change who plays)', 'Pass (for the side to play)', 'Black stone']);
	await tool(page, 'Pass').click();
	await sleep(700);
	assert.match(await doc(page), /\(;GM\[1\]SZ\[9\];B\[ee\];W\[\]\)/);
	// then Black plays on
	await clickPoint(page, 0, 'cc');
	await sleep(700);
	assert.match(await doc(page), /;B\[ee\];W\[\];B\[cc\]\)/);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	assert.deepEqual(await notices(page), []);
});

await scenario('a reading pane beside the editor shows the board being edited, but no tools, and takes no clicks', {
	files: { 'N.md': '# New\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nafter\n' }, panes: [{ path: 'N.md', mode: 'source' }, { path: 'N.md', mode: 'preview' }], width: 1500, autosave: 100,
}, async (page) => {
	await toggleLock(page, 0);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	assert.deepEqual(await stones(page, 1), { black: 2, white: 0 });
	// still unlocked in the editor, and not locked by the reading pane
	assert.deepEqual(await isEditing(page), [true, false]);
	assert.equal(await page.locator('.kifu-tools').count(), 1);
	assert.equal(await lockBtn(page, 1).isHidden(), true);
	// a click there neither edits nor plays
	await clickPoint(page, 1, 'gg');
	await sleep(700);
	assert.deepEqual(await stones(page, 1), { black: 2, white: 0 });
	assert.deepEqual(await isEditing(page), [true, false]);
	assert.equal(await doc(page), '# New\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nafter\n');
	// and the editor carries on
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
});

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
	// the reading pane (boards 2 and 3) has no lock
	assert.deepEqual(await page.locator('.kifu-ctl .kifu-btn[aria-label="Unlock to edit"]').evaluateAll((bs) => bs.map((b) => b.hidden)), [false, false, true, true]);
	// unlock the SECOND block in the editor pane
	const p = await pointXY(page, 1, 'jj');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 1).click();
	// only that one board is unlocked: not its twin, and not the reading pane's
	assert.deepEqual(await isEditing(page), [false, true, false, false]);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'dd');
	assert.deepEqual(await stones(page, 1), { black: 1, white: 0 });
	for (const i of [0, 2, 3]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	await sleep(700);
	// the edit went into the second block; the same block in the reading pane has followed
	assert.equal(await text(page, 'T.md'), '# Twins\n\n```kifu\n```\n\nbetween\n\n```kifu\n(;GM[1]FF[4]CA[UTF-8]SZ[19]AB[dd])\n```\n\nend\n');
	assert.equal(await boardCount(page), 4);
	assert.deepEqual(await stones(page, 3), { black: 1, white: 0 });
	for (const i of [0, 2]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	// it is still not unlocked there, and has no lock
	assert.equal(await lockBtn(page, 3).isHidden(), true);
	// carry on in the editor pane: both panes show the block as it changes
	await clickPoint(page, 1, 'pp');
	await clickPoint(page, 1, 'dp');
	await sleep(700);
	assert.match(await text(page, 'T.md'), /```kifu\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\[dp\]\)/);
	assert.deepEqual(await stones(page, 3), { black: 3, white: 0 });
	// locked again: the stones are played, not added
	await lockBtn(page, 1).click();
	assert.deepEqual(await isEditing(page), [false, false, false, false]);
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
	// work on the second block in the editor; the note on disk lags behind it
	const p = await pointXY(page, 1, 'jj');
	await page.mouse.move(p.x, p.y);
	await lockBtn(page, 1).click();
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'dd');
	await sleep(700);
	// the editor has the stone; the reading pane has not been drawn again
	assert.match(await page.evaluate(() => window.harness.views[0].data), /between\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\)\n```/);
	assert.equal(await text(page, 'T.md'), TWINS);
	assert.deepEqual(await marks(), ['0', null, '2', '3']);
	assert.deepEqual(await isEditing(page), [false, true, false, false]);
	assert.deepEqual(await stones(page, 1), { black: 1, white: 0 });
	assert.deepEqual(await stones(page, 3), { black: 0, white: 0 });
	await clickPoint(page, 1, 'pp');
	await sleep(1700);
	await clickPoint(page, 1, 'dp');
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
	// let the note be saved: the reading pane is drawn again, with the stones, still locked
	await sleep(3200);
	assert.match(await text(page, 'T.md'), /```kifu\n```\n\nbetween\n\n```kifu\n\(;GM\[1\]FF\[4\]CA\[UTF-8\]SZ\[19\]AB\[dd\]\[pp\]\[dp\]\)\n```/);
	assert.deepEqual(await marks(), ['0', null, '2', null]);
	assert.deepEqual(await isEditing(page), [false, true, false, false]);
	assert.deepEqual(await stones(page, 3), { black: 3, white: 0 });
	for (const i of [0, 2]) assert.deepEqual(await stones(page, i), { black: 0, white: 0 });
	// and the editor still takes edits
	await clickPoint(page, 1, 'pd');
	await sleep(700);
	assert.match(await page.evaluate(() => window.harness.views[0].data), /AB\[dd\]\[pp\]\[dp\]\[pd\]/);
	assert.deepEqual(await page.evaluate(() => window.harness.notices()), []);
});

await scenario('move tree panel', { files: { 'P.md': problemNote }, panes: [{ path: 'P.md', mode: 'source' }], autosave: 100 }, async (page) => {
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
	// (the scratch move on the board: kept)
	await page.locator('.modal-content button', { hasText: 'Save' }).click();
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
	panes: [{ path: 'F.md', mode: 'source' }],
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
	panes: [{ path: 'O.md', mode: 'source' }],
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
	panes: [{ path: 'C.md', mode: 'source' }],
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
		return v.modify(f, 'new first line\n\nand another\n\n' + v.files.get('C.md').data);
	});
	await sleep(700);
	assert.equal(await text(page, 'C.md'), 'new first line\n\nand another\n\n# Callout\n\n> [!note] A problem\n> ```kifu\n> (;SZ[9]AB[cc]AW[gg])\n> ```\n> closing words\n\nplain\n');
	// if the block itself is gone, nothing is written and the user is told
	await clickPoint(page, 0, 'hh');
	await page.evaluate(() => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('C.md'), 'everything was replaced\n'); });
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
	panes: [{ path: 'G.md', mode: 'source' }],
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

await scenario('the settings are read only when the page is first shown, and it then shows them', { files: { 'E.md': 'no boards here\n' }, panes: [{ path: 'E.md', mode: 'source' }], data: { scale: 1.2, coords: true, style: 'theme' } }, async (page) => {
	// starting the plugin and having the page indexed reads nothing
	await sleep(100);
	assert.equal(await page.evaluate(() => window.harness.plugin.settingsReady), false);
	const indexed = await page.evaluate(() => {
		const t = window.harness.app._settingTabs[0];
		return t.getSettingDefinitions().length > 0;
	});
	assert.equal(indexed, true);
	await sleep(100);
	assert.equal(await page.evaluate(() => window.harness.plugin.settingsReady), false);
	// opened: read, then drawn again with what was saved
	await page.evaluate(() => {
		const t = window.harness.app._settingTabs[0];
		document.getElementById('main').appendChild(t.containerEl);
		t.display();
	});
	await sleep(150);
	assert.equal(await page.evaluate(() => window.harness.plugin.settingsReady), true);
	assert.equal(await page.evaluate(() => document.querySelector('.setting-item input[type=range]').value), '120');
	assert.equal(await page.evaluate(() => document.querySelectorAll('.setting-item input[type=checkbox]')[0].checked), true);
	assert.equal(await page.evaluate(() => document.querySelectorAll('.setting-item select')[0].value), 'theme');
	assert.equal(await page.evaluate(() => document.querySelector('.kifu-sample').className), 'kifu kifu-sample kifu-theme kifu-center');
	// a value that does not fit changes nothing
	await page.evaluate(() => window.harness.app._settingTabs[0].setControlValue('boardSize', 'huge'));
	assert.equal(await page.evaluate(() => window.harness.plugin.settings.boardSize), 19);
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
	assert.equal(await page.locator('.setting-item').count(), 19); // the preview, and 14 settings under 4 headings
	// the goproblems.com token: only the name of the secret is kept with the settings, never the token
	await page.evaluate(() => {
		window.harness.app.secretStorage.setSecret('gp-token', 's3cret');
		const input = document.querySelector('.secret-component');
		input.value = 'gp-token';
		input.dispatchEvent(new Event('change'));
	});
	await sleep(50);
	assert.equal(await page.evaluate(() => JSON.parse(window.harness.plugin._data).goproblemsKey), 'gp-token');
	assert.doesNotMatch(await page.evaluate(() => window.harness.plugin._data), /s3cret/);
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

await scenario('a ✓ or ✗ is stamped over the board when a line ends, once, and never while editing', {
	files: { 'P.md': problemNote },
	panes: [{ path: 'P.md', mode: 'source' }],
}, async (page) => {
	const stamp = () => page.evaluate(() => [...document.querySelectorAll('.kifu-stamp')].map((e) => e.className).join());
	assert.equal(await stamp(), '');
	await clickPoint(page, 0, 'ra');
	await sleep(700);
	assert.equal(await stamp(), ''); // the line goes on
	await clickPoint(page, 0, 'sa');
	await sleep(100);
	assert.equal(await stamp(), 'kifu-stamp is-correct');
	// it does not block the board, and fades by itself
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kifu-stamp')).pointerEvents), 'none');
	await sleep(2000);
	assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.kifu-stamp')).opacity), '0');
	// stepping back and forth to the end again is a new ending: shown afresh
	await page.evaluate(() => { window.__stamp = document.querySelector('.kifu-stamp'); });
	await page.keyboard.press('ArrowLeft');
	assert.equal(await stamp(), '');
	await page.keyboard.press('ArrowRight');
	assert.equal(await stamp(), 'kifu-stamp is-correct');
	assert.equal(await page.evaluate(() => document.querySelector('.kifu-stamp') === window.__stamp), false);
	// back to the start: gone; a wrong first move: the ✗
	await page.keyboard.press('Escape');
	assert.equal(await stamp(), '');
	await clickPoint(page, 0, 'qa');
	await sleep(700);
	assert.equal(await stamp(), 'kifu-stamp is-incorrect');
	// editing never shows it
	await toggleLock(page);
	assert.equal(await stamp(), '');
});

await scenario('a numbered sequence that is not a problem stamps the ✓ its last move carries', {
	files: {
		'W.md': '```kifu\nnumbers: on\nmove: 1\n(;GM[1]FF[4]CA[UTF-8]SZ[19];B[pd]C[Black asks for the corner.]\n;W[qf]C[White approaches.]\n;B[nc]C[Black shares the corner.]\n;W[rd]\n;B[qc]\n;W[qi]C[White takes a 2-space base for safety.]TE[1])\n```\n',
	},
	panes: [{ path: 'W.md', mode: 'source' }],
}, async (page) => {
	const stamp = () => page.evaluate(() => [...document.querySelectorAll('.kifu-stamp')].map((e) => e.className).join());
	await clickPoint(page, 0, 'qf');
	await sleep(700); // (the saved reply)
	assert.equal(await stamp(), '');
	await clickPoint(page, 0, 'rd');
	await sleep(700);
	await clickPoint(page, 0, 'qi');
	await sleep(100);
	assert.equal(await stamp(), 'kifu-stamp is-correct');
	assert.match(await cap(page), /^Correct/);
});

await scenario('back and forward under the lock step through the moves played, never the record', {
	files: { 'B.md': '```kifu\nmove: 1\n(;SZ[9];B[cc];W[ee];B[gg];W[cg])\n```\n' },
	panes: [{ path: 'B.md', mode: 'source' }],
}, async (page) => {
	const back = page.locator('.kifu-ctl .kifu-btn[aria-label^="Take back"]');
	const forward = page.locator('.kifu-ctl .kifu-btn[aria-label^="Play it again"]');
	// nothing played yet: nothing to step through, so no buttons
	assert.equal(await back.isVisible(), false);
	assert.equal(await forward.isVisible(), false);
	assert.deepEqual(await stones(page), { black: 1, white: 0 });
	await clickPoint(page, 0, 'ee'); // the saved move; the saved reply follows
	await sleep(700);
	assert.deepEqual(await stones(page), { black: 2, white: 1 });
	assert.equal(await back.isVisible(), true);
	assert.equal(await forward.isDisabled(), true);
	await back.click();
	await back.click();
	assert.deepEqual(await stones(page), { black: 1, white: 0 });
	assert.equal(await back.isDisabled(), true); // the resting position: the record before it stays out of reach
	await forward.click();
	await forward.click();
	assert.deepEqual(await stones(page), { black: 2, white: 1 });
	assert.equal(await forward.isDisabled(), true); // W[cg] was never played here
	// a fresh try: gone again
	await page.locator('.kifu-ctl .kifu-btn[aria-label^="Back to the starting"]').click();
	assert.equal(await back.isVisible(), false);
	// and never while editing (the toolbar has its own)
	await clickPoint(page, 0, 'ee');
	await sleep(700);
	await toggleLock(page);
	assert.equal(await back.isVisible(), false);
	assert.equal(await forward.isVisible(), false);
});

await scenario('a locked problem shows its solution on request, without a stamp', {
	files: { 'P.md': problemNote, 'G.md': '```kifu\n(;SZ[9];B[cc];W[ee]TE[1])\n```\n' },
	panes: [{ path: 'P.md', mode: 'source' }, { path: 'G.md', mode: 'source' }],
}, async (page) => {
	const show = page.locator('.kifu-ctl .kifu-btn[aria-label="Show the solution"]');
	assert.equal(await show.count(), 2); // (one per board, shown only where there is an answer)
	assert.equal(await show.nth(0).isVisible(), true);
	assert.equal(await show.nth(1).isVisible(), false); // not a problem
	// a wrong try, then the answer
	await clickPoint(page, 0, 'qa');
	await sleep(700);
	assert.match(await cap(page), /^Incorrect/);
	await show.nth(0).click();
	assert.deepEqual(await stones(page), { black: 9, white: 0 }); // B ra, W qa, B sa: the white group is taken
	assert.equal(await labels(page), '1,3'); // (White's 2 was taken with the group)
	assert.match(await cap(page), /^Correct/);
	await sleep(100);
	assert.equal(await page.locator('.kifu-stamp').count(), 0); // shown, not found: no stamp
	assert.equal(await show.nth(0).isDisabled(), true);
	// step back through it with the buttons under the lock
	await page.locator('.kifu-ctl .kifu-btn[aria-label^="Take back"]').nth(0).click();
	assert.equal(await show.nth(0).isDisabled(), false);
	// and never while editing
	await toggleLock(page);
	assert.equal(await show.nth(0).isVisible(), false);
});

await scenario('a shuffled problem is shown turned and recoloured, solved as shown, and edited as recorded', {
	files: { 'P.md': problemNote },
	panes: [{ path: 'P.md', mode: 'source' }],
}, async (page) => {
	// the roll is fixed: turned over the diagonal and mirrored both ways (t = 7), colours swapped
	await page.evaluate(async (note) => {
		const q = [0.99, 0.2];
		Math.random = () => (q.length ? q.shift() : 0.5);
		const v = window.harness.app.vault;
		await v.modify(v.getAbstractFileByPath('P.md'), note.replace('```kifu\n', '```kifu\nrandomize: on\n'));
	}, problemNote);
	await sleep(200);
	// recorded: 7 black stones, 5 white, Black to play; shown: the other way round
	assert.deepEqual(await stones(page), { black: 5, white: 7 });
	assert.equal(await cap(page), 'White to play and kill.');
	// unlocked it is shown as recorded, with the shuffle switch lit; locked again, as before
	await toggleLock(page);
	assert.deepEqual(await stones(page), { black: 7, white: 5 });
	const shuffle = page.locator('.kifu-ctl .kifu-btn[aria-label^="Shuffle"]');
	assert.equal(await shuffle.isVisible(), true);
	assert.equal(await shuffle.evaluate((b) => b.classList.contains('is-active')), true);
	await toggleLock(page);
	assert.equal(await shuffle.isVisible(), false);
	assert.deepEqual(await stones(page), { black: 5, white: 7 });
	// the vital point (R19 as recorded) is shown at T18: played there, it is the answer
	await clickPoint(page, 0, 'sb');
	await sleep(700);
	await clickPoint(page, 0, 'sa');
	await sleep(100);
	assert.match(await cap(page), /^Correct/);
	assert.match(await cap(page), /Black has no eyes\./); // ("White has no eyes.", in the colours shown)
	assert.equal(await page.locator('.kifu-stamp.is-correct').count(), 1);
	// the note itself was never touched by playing
	assert.match(await text(page, 'P.md'), /randomize: on\n\(;GM\[1\]FF\[4\]SZ\[19\]AB\[oa\]/);
});

await scenario('coordinates sit beside the board\'s real edges, wherever they are', {
	files: { 'C.md': ['top-right', 'bottom-left', 'top', 'center'].map((v) => '```kifu\ncoords: on\nview: ' + v + ' 7x5\n(;SZ[19]AB[pd])\n```').join('\n\n') + '\n' },
	panes: [{ path: 'C.md', mode: 'source' }],
}, async (page) => {
	// for each board: are the numbers right of the grid, and the letters above it?
	const sides = await page.evaluate(() => [...document.querySelectorAll('.kifu-svg')].map((svg) => {
		const grid = svg.querySelector('.kifu-grid').getBoundingClientRect();
		const coords = [...svg.querySelectorAll('.kifu-coord')];
		const nums = coords.filter((t) => /^\d+$/.test(t.textContent)).map((t) => t.getBoundingClientRect());
		const letters = coords.filter((t) => /^[A-Z]$/.test(t.textContent)).map((t) => t.getBoundingClientRect());
		return {
			numbers: nums.every((r) => r.left >= grid.right) ? 'right' : nums.every((r) => r.right <= grid.left) ? 'left' : 'mixed',
			letters: letters.every((r) => r.bottom <= grid.top) ? 'top' : letters.every((r) => r.top >= grid.bottom) ? 'bottom' : 'mixed',
		};
	}));
	assert.deepEqual(sides.map((s) => `${s.numbers} ${s.letters}`), ['right top', 'left bottom', 'left top', 'left bottom']);
	// a click still lands on the point under it, with the coordinates on the far side
	await clickPoint(page, 0, 'qc');
	await sleep(100);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 1 }); // (black stones set up: White plays first)
});

await scenario('embedded links to OGS and goproblems.com are drawn as boards in the reading view', {
	files: { 'L.md': '# Links\n\n![](https://online-go.com/puzzle/2)\n\nsome text ![a game](https://online-go.com/game/9) more text\n\n![](https://www.goproblems.com/problems/5)\n\n![again](https://online-go.com/puzzle/2)\n\n![](https://example.com/photo.png)\n\n![](https://online-go.com/game/404)\n' },
	panes: [],
}, async (page) => {
	await page.evaluate(() => {
		const { requestUrl } = window.__obsidian;
		const puzzle = {
			name: 'Corner life', owner: { username: 'someone' },
			puzzle: {
				width: 9, height: 9, initial_player: 'black', puzzle_type: 'life_and_death', puzzle_description: 'Black to live',
				initial_state: { black: 'aaba', white: 'cacb' },
				move_tree: { x: -1, y: -1, branches: [
					{ x: 0, y: 1, branches: [{ x: 1, y: 1, branches: [{ x: 0, y: 2, correct_answer: true }] }] },
					{ x: 1, y: 1, branches: [{ x: 0, y: 1, wrong_answer: true }] },
				] },
			},
		};
		requestUrl.answers['https://online-go.com/api/v1/puzzles/2'] = { status: 200, json: puzzle };
		requestUrl.answers['https://online-go.com/api/v1/games/9/sgf'] = { status: 200, text: '(;FF[4]GM[1]PB[alice]PW[bob]SZ[9];B[ee];W[cc];B[gg])' };
		requestUrl.answers['https://goproblems.com/api/v2/problems/5'] = { status: 200, json: { sgf: '(;AB[aa][ba]AW[ca][cb]C[Black to live]SZ[9](;B[ab];W[bb];B[ac]C[RIGHT]))' } };

		const h = window.harness;
		h.views.push(h.app.workspace._open('L.md', 'preview'));
	});
	await sleep(300);
	// four boards: the puzzle twice, the game, the goproblems.com problem
	assert.equal(await page.locator('.kifu-svg').count(), 4);
	// a link that is not to a game or problem stays an image; one that is not there says so
	assert.equal(await page.locator('img[src="https://example.com/photo.png"]').count(), 1);
	assert.match(await page.locator('.kifu-linked-msg.is-error').textContent(), /OGS has no game 404, or it is not public\./);
	assert.equal(await page.locator('.kifu-linked-msg:not(.is-error)').count(), 0); // (no "fetching" left)
	// the puzzle shown twice was asked for once
	const urls = await page.evaluate(() => window.__obsidian.requestUrl.log.map((q) => q.url));
	assert.equal(urls.filter((u) => u.endsWith('/puzzles/2')).length, 1);
	// it plays: the right line ends correct
	assert.equal(await cap(page, 0), 'Black to live');
	await clickPoint(page, 0, 'ab');
	await sleep(700);
	await clickPoint(page, 0, 'ac');
	await sleep(100);
	assert.match(await cap(page, 0), /^Correct/);
	// it can not be unlocked: the reading view has no lock
	assert.equal(await lockBtn(page, 0).isHidden(), true);
	assert.deepEqual((await isEditing(page)).slice(0, 1), [false]);
	// and the note was never written
	assert.match(await text(page, 'L.md'), /^# Links\n\n!\[\]\(https:\/\/online-go\.com\/puzzle\/2\)/);
});

for (const mode of ['preview', 'source']) {
	await scenario(`an SGF file of the vault embedded as ![[g.sgf]], at a move or a point (${mode})`, {
		allowErrors: /Failed to load resource: net::ERR_NAME_NOT_RESOLVED/,
		files: {
			'g.sgf': '(;GM[1]SZ[9];B[ee];W[cc];B[gg];W[cg])',
			'E.md': '# Embeds\n\n![[g.sgf]]\n\n![[g.sgf#2]]\n\n![[g.sgf#G3]]\n\n![[g.sgf#J9]]\n\n![](https://files.example.com/go/g.sgf#1)\n',
		},
		panes: [],
	}, async (page) => {
		await page.evaluate((mode) => {
			window.__obsidian.requestUrl.answers['https://files.example.com/go/g.sgf'] = { status: 200, text: '(;GM[1]SZ[9];B[ee];W[cc];B[gg];W[cg])' };
			const h = window.harness;
			h.views.push(h.app.workspace._open('E.md', mode));
		}, mode);
		await sleep(400);
		// (a web link is drawn in an editor by the editor extension, which this plain editor has not got)
		const n = mode === 'preview' ? 5 : 4;
		assert.equal(await boardCount(page), n);
		const all = async () => { const out = []; for (let i = 0; i < n; i++) out.push(await stones(page, i)); return out; };
		assert.deepEqual(await all(), [
			{ black: 2, white: 2 }, // no number: a game rests at its end
			{ black: 1, white: 1 }, // #2
			{ black: 2, white: 1 }, // #G3: the first move played there
			{ black: 0, white: 0 }, // #J9: never played there: the start
			{ black: 1, white: 0 }, // a web link, #1 (and the fetch asked for the file without it)
		].slice(0, n));
		if (mode === 'preview') assert.deepEqual(await page.evaluate(() => window.__obsidian.requestUrl.log.map((q) => q.url)), ['https://files.example.com/go/g.sgf']);
		// the file changes (a stone set up at the start): so do the boards that show it
		await page.evaluate(() => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('g.sgf'), '(;GM[1]SZ[9]AB[aa];B[ee];W[cc];B[gg];W[cg])'); });
		await sleep(300);
		assert.deepEqual(await stones(page, 0), { black: 3, white: 2 });
		// played like a board, never edited: the file stays as it is
		if (mode === 'source') {
			await toggleLock(page, 1);
			assert.deepEqual((await isEditing(page)).slice(0, 2), [false, false]);
			assert.match((await notices(page))[0], /an embedded SGF file\. To edit it, open the file itself, or show it with a kifu block: sgf: \[\[g\]\]/);
		} else {
			assert.equal(await lockBtn(page, 1).isHidden(), true);
		}
		assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9]AB[aa];B[ee];W[cc];B[gg];W[cg])');
	});
}

await scenario('an SGF file opened by itself: a board in a tab of its own, edited into the file', {
	files: { 'g.sgf': '(;GM[1]SZ[9];B[ee];W[cc])' }, panes: [], autosave: 100, width: 1000, height: 900,
}, async (page) => {
	await page.evaluate(() => window.harness.app.workspace._openFile('g.sgf'));
	await sleep(300);
	assert.equal(await page.locator('.view-header').first().textContent(), 'g');
	assert.deepEqual(await stones(page), { black: 1, white: 1 }); // (a game rests at its end)
	// as large as the tab allows
	assert.ok((await page.locator('.kifu-svg').boundingBox()).width > 500);
	await toggleLock(page);
	assert.deepEqual(await isEditing(page), [true]);
	// what only an option line can say is not offered: the file has no place for it
	const hidden = await page.evaluate(() => {
		const t = (label) => document.querySelector(`.kifu-tools .kifu-btn[aria-label^="${label}"]`)?.hidden;
		const c = (label) => document.querySelector(`.kifu-ctl .kifu-btn[aria-label^="${label}"]`)?.hidden;
		return [t('Choose the part'), t('When locked, show the moves'), t('Open the board at this position'), c('Problem'), c('Shuffle'), t('Play moves'), t('Pass'), t('Game info')];
	});
	assert.deepEqual(hidden, [true, true, true, true, true, false, false, false]);
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'g.sgf'), '(;GM[1]SZ[9];B[ee];W[cc];B[gg])');
	// the file changed by someone else: the board follows
	await toggleLock(page);
	await page.evaluate(() => { const v = window.harness.app.vault; return v.modify(v.getAbstractFileByPath('g.sgf'), '(;GM[1]SZ[9]AB[aa];B[ee];W[cc];B[gg])'); });
	await sleep(300);
	assert.deepEqual(await stones(page), { black: 3, white: 1 });
	assert.deepEqual(await notices(page), []);
});

await scenario('the move tree panel follows the SGF file of the tab with the focus, with no click on its board', {
	files: { 'a.sgf': '(;GM[1]SZ[9];B[ee])', 'b.sgf': '(;GM[1]SZ[9];B[cc];W[gg])' }, panes: [], autosave: 100,
}, async (page) => {
	await page.evaluate(() => window.harness.plugin.showPanel(true));
	const move = () => page.locator('.kifu-p-move').textContent();
	await page.evaluate(() => window.harness.app.workspace._openFile('a.sgf'));
	await sleep(300);
	assert.equal(await move(), 'Black 1 · E5');
	await page.evaluate(() => window.harness.app.workspace._openFile('b.sgf'));
	await sleep(300);
	assert.equal(await move(), 'White 2 · G3');
	// back to the first tab
	await page.evaluate(() => { const w = window.harness.app.workspace; w._activate(w._leaves.find((l) => l.view?.file?.path === 'a.sgf')); });
	await sleep(100);
	assert.equal(await move(), 'Black 1 · E5');
});

await scenario('"New SGF" in a folder\'s menu in the file explorer: an empty game, opened in its tab', {
	files: { 'N.md': 'text\n' }, panes: [], autosave: 100, data: { boardSize: 13 },
}, async (page) => {
	const menu = (file, source) => page.evaluate(([file, source]) => {
		const O = window.__obsidian;
		const m = new O.Menu();
		const f = file.endsWith('/') ? new O.TFolder(file.slice(0, -1)) : window.harness.app.vault.getAbstractFileByPath(file);
		window.harness.app.workspace.trigger('file-menu', m, f, source);
		window.__menu = m;
		return m.items.map((i) => [i.title, i.section]);
	}, [file, source]);
	// a folder in the file explorer: there, in the section of "New note", "New base"…
	assert.deepEqual(await menu('Games/', 'file-explorer-context-menu'), [['New SGF', 'action-primary']]);
	// not for a file, and not in other menus of a folder
	assert.deepEqual(await menu('N.md', 'file-explorer-context-menu'), []);
	assert.deepEqual(await menu('Games/', 'link-context-menu'), []);
	// chosen: an empty game of the default size, opened in its tab
	const choose = () => page.evaluate(async () => { window.__menu.items[0].click(new MouseEvent('click')); await new Promise((r) => setTimeout(r, 300)); });
	await menu('Games/', 'file-explorer-context-menu');
	await choose();
	assert.equal(await text(page, 'Games/Untitled.sgf'), '(;GM[1]FF[4]CA[UTF-8]SZ[13])\n');
	assert.equal(await page.locator('.kifu-sgf-view .kifu-svg').count(), 1);
	assert.equal(await page.locator('.view-header').last().textContent(), 'Untitled');
	// a second one does not take the first one's name; and in the vault's top folder
	await menu('Games/', 'file-explorer-context-menu');
	await choose();
	assert.equal(await text(page, 'Games/Untitled 1.sgf'), '(;GM[1]FF[4]CA[UTF-8]SZ[13])\n');
	await menu('/', 'file-explorer-context-menu');
	await choose();
	assert.equal(await text(page, 'Untitled.sgf'), '(;GM[1]FF[4]CA[UTF-8]SZ[13])\n');
});

await scenario('an SGF file of several games opened by itself: a picker, and only that game is edited', {
	files: { 'c.sgf': '(;GM[1]SZ[9]AB[aa])\n(;GM[1]SZ[9]AB[bb][cc])\n(;GM[1]SZ[9]AB[dd][ee][ff])\n' }, panes: [], autosave: 100,
}, async (page) => {
	await page.evaluate(() => window.harness.app.workspace._openFile('c.sgf'));
	await sleep(300);
	const pick = page.locator('.kifu-sgf-games select');
	assert.deepEqual(await pick.locator('option').allTextContents(), ['Game 1 of 3', 'Game 2 of 3', 'Game 3 of 3']);
	assert.deepEqual(await stones(page), { black: 1, white: 0 });
	await pick.selectOption('2');
	await sleep(300);
	assert.deepEqual(await stones(page), { black: 2, white: 0 });
	assert.equal(await pick.inputValue(), '2');
	await toggleLock(page);
	await tool(page, 'White stone').click();
	await clickPoint(page, 0, 'gg');
	await sleep(700);
	assert.equal(await text(page, 'c.sgf'), '(;GM[1]SZ[9]AB[aa])\n(;GM[1]SZ[9]AB[bb][cc]AW[gg])\n(;GM[1]SZ[9]AB[dd][ee][ff])\n');
});

await scenario('an embedded Josekipedia link is drawn as the position, with what may follow as variations', {
	allowErrors: /Failed to load resource: net::ERR_NAME_NOT_RESOLVED/,
	files: { 'J.md': '# Joseki\n\n![](https://www.josekipedia.com/#path:pdqf)\n' },
	panes: [],
}, async (page) => {
	await page.evaluate(() => {
		const { requestUrl } = window.__obsidian;
		const api = (id) => `https://www.josekipedia.com/db/node.php?id=${id}`;
		requestUrl.answers[api(1)] = { status: 200, text: JSON.stringify({ _id: 1, _children: [{ _id: 40, B: 'pd', C: 'Star point' }] }) };
		requestUrl.answers[api(40)] = { status: 200, text: JSON.stringify({ _id: 40, B: 'pd', _children: [{ _id: 42, W: 'qf', C: 'The approach' }] }) };
		requestUrl.answers[api(42)] = { status: 200, text: JSON.stringify({ _id: 42, W: 'qf', _children: [{ _id: 50, B: 'nc', C: 'Most common' }, { _id: 51, B: 'qh', C: 'A pincer' }] }) };
		const h = window.harness;
		h.views.push(h.app.workspace._open('J.md', 'preview'));
	});
	await sleep(400);
	// the position the link is to, not a move further
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
	assert.equal(await cap(page), 'The approach');
	// what may follow is there to play: a saved continuation is followed, with its comment
	await clickPoint(page, 0, 'nc');
	assert.deepEqual(await stones(page), { black: 2, white: 1 });
	assert.equal(await cap(page), 'Most common');
	// asked a node at a time, once each
	assert.deepEqual(await page.evaluate(() => window.__obsidian.requestUrl.log.map((q) => q.url.replace(/.*id=/, ''))), ['1', '40', '42']);
});

await scenario('an embedded link to an SGF file anywhere is drawn as a board', {
	// (like Obsidian, the reading view first makes each link an image, which the browser
	// then tries to load from a host that does not exist here)
	allowErrors: /Failed to load resource: net::ERR_NAME_NOT_RESOLVED/,
	files: { 'S.md': '# Mine\n\n![](https://files.example.com/go/problem.sgf?key=1)\n\n![](https://files.example.com/go/missing.sgf)\n\n![](https://files.example.com/go/page.sgf)\n' },
	panes: [],
}, async (page) => {
	await page.evaluate(() => {
		const { requestUrl } = window.__obsidian;
		requestUrl.answers['https://files.example.com/go/problem.sgf?key=1'] = { status: 200, text: '(;GM[1]SZ[9]AB[aa][ba]AW[ca][cb]C[Black to live](;B[ab];W[bb];B[ac]TE[1])(;B[bb];W[ab]))' };
		requestUrl.answers['https://files.example.com/go/page.sgf'] = { status: 200, text: '<html>please log in</html>' };
		const h = window.harness;
		h.views.push(h.app.workspace._open('S.md', 'preview'));
	});
	await sleep(300);
	assert.equal(await page.locator('.kifu-svg').count(), 1);
	const errs = await page.locator('.kifu-linked-msg.is-error').allTextContents();
	assert.ok(errs.some((t) => /there is no file at https:\/\/files\.example\.com\/go\/missing\.sgf\./.test(t)), errs.join(' | '));
	assert.ok(errs.some((t) => /page\.sgf is not an SGF file\./.test(t)), errs.join(' | '));
	// a problem in the file: judged as one, and it plays
	assert.equal(await cap(page, 0), 'Black to live');
	await clickPoint(page, 0, 'ab');
	await sleep(700);
	await clickPoint(page, 0, 'ac');
	await sleep(100);
	assert.match(await cap(page, 0), /^Correct/);
});

await scenario('embedded links to games on Dragon Go Server, Fox, GoQuest and Stone.gs', {
	// (the reading view first makes each link an image, which the browser tries to load)
	allowErrors: /Failed to load resource/,
	files: { 'G.md': [
		'![](https://www.dragongoserver.net/game.php?gid=77)',
		'![](https://h5.foxwq.com/yehunewshare/?chessid=1791604708010001161&title=x)',
		'![](https://kifu.questgames.net/go/abcdef123456)',
		'![](https://stone.gs/games/ogs/9)',
		'![](https://kifu.questgames.net/go/expired00000)',
	].join('\n\n') + '\n' },
	panes: [],
}, async (page) => {
	await page.evaluate(() => {
		const { requestUrl } = window.__obsidian;
		requestUrl.answers['https://www.dragongoserver.net/sgf.php?gid=77'] = { status: 200, text: '(;FF[4]GM[1]SZ[9]PB[a]PW[b];B[ee];W[cc])' };
		requestUrl.answers['https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?chessid=1791604708010001161'] = { status: 200, text: JSON.stringify({ result: 0, chess: '(;GM[1]SZ[9]KM[375]HA[2];AB[cc][gg];W[ee])' }) };
		requestUrl.answers['https://kifu.questgames.net/game/abcdef123456.json'] = { status: 200, json: { players: [{ name: 'A' }, { name: 'B' }], position: { size: 9, moves: [{ m: 'B[ee]' }, { m: 'W[ce]' }, { s: 'LOSE:RESIGN' }] } } };
		requestUrl.answers['https://kifu.questgames.net/game/expired00000.json'] = { status: 200, json: { error: 'Game not found' } };
		requestUrl.answers['https://online-go.com/api/v1/games/9/sgf'] = { status: 200, text: '(;FF[4]GM[1]SZ[9];B[ee];W[cc];B[gg])' };
		const h = window.harness;
		h.views.push(h.app.workspace._open('G.md', 'preview'));
	});
	await sleep(400);
	assert.equal(await page.locator('.kifu-svg').count(), 4);
	assert.deepEqual(await stones(page, 0), { black: 1, white: 1 }); // DGS
	assert.deepEqual(await stones(page, 1), { black: 2, white: 1 }); // Fox: the handicap stones, then White's move
	assert.deepEqual(await stones(page, 2), { black: 1, white: 1 }); // GoQuest
	assert.deepEqual(await stones(page, 3), { black: 2, white: 1 }); // Stone.gs: the OGS game
	assert.match(await page.locator('.kifu-linked-msg.is-error').textContent(), /GoQuest has no game expired00000 any more/);
	const urls = await page.evaluate(() => window.__obsidian.requestUrl.log.map((q) => q.url));
	assert.ok(urls.includes('https://online-go.com/api/v1/games/9/sgf')); // (Stone.gs: asked of OGS)
});

await scenario('the Kifu boards Bases view: a card per note, its first board playable, its properties', {
	files: {
		'P.md': '---\nlevel: 20k\n---\n# Problem\n\n```kifu\n(;GM[1]SZ[9]AB[aa][ba]AW[ca][cb]C[Black to live](;B[ab];W[bb];B[ac]TE[1])(;B[bb];W[ab]))\n```\n\n```kifu\n(;SZ[9];B[ii])\n```\n',
		'G.md': '# Game\n\n```kifu\n(;GM[1]SZ[9];B[ee];W[cc];B[gg])\n```\n',
		'N.md': '# Nothing\n\nNo board here.\n',
		'games/one.sgf': '(;GM[1]SZ[9];B[cc];W[gg])',
	},
	panes: [],
}, async (page) => {
	// a base as Obsidian hands it to a view: entries for files, values for properties
	await page.evaluate(() => {
		const h = window.harness;
		const v = h.app.vault;
		const value = (text) => ({ isTruthy: () => !!text, toString: () => text, renderTo: (el) => { el.textContent = text; } });
		const props = { 'P.md': '20k', 'G.md': '', 'N.md': '', 'games/one.sgf': '' };
		const entries = Object.keys(props).map((path) => ({ file: v.getAbstractFileByPath(path), getValue: (p) => (p === 'note.level' ? value(props[path]) : null) }));
		const config = { values: { boardScale: 60, playable: true }, get(k) { return this.values[k]; }, getOrder: () => ['file.name', 'note.level'], getDisplayName: (p) => p.replace(/^note\./, '') };
		const controller = { app: h.app, config, data: { groupedData: [{ hasKey: () => false, entries }] } };
		const host = document.createElement('div');
		host.style.width = '900px';
		document.getElementById('main').appendChild(host);
		const reg = h.app._basesViews.get('kifu-boards');
		const view = reg.factory(controller, host);
		view.load();
		view.onDataUpdated();
		window.__base = { view, config, reg };
	});
	await sleep(400);
	// four cards: three boards (the problem, the game, the SGF file) and a note without one
	assert.equal(await page.locator('.kifu-bases-card').count(), 4);
	assert.equal(await page.locator('.kifu-bases-card .kifu-svg').count(), 3);
	assert.equal(await page.locator('.kifu-bases-none').textContent(), 'No board in this note.');
	assert.deepEqual(await page.locator('.kifu-bases-title').allTextContents(), ['P', 'G', 'N', 'one']);
	// every board fills its card: all of it but the card's padding, the paper's edge, the room
	// beside the board for its buttons, and less than one cell (the cell is whole pixels)
	const fill = await page.evaluate(() => [...document.querySelectorAll('.kifu-bases-card')].filter((c) => c.querySelector('.kifu-svg')).map((c) => {
		const svg = c.querySelector('.kifu-svg');
		const cols = Number(svg.getAttribute('viewBox').split(' ')[2]) / 100;
		const cell = svg.getBoundingClientRect().width / cols;
		return c.clientWidth - 16 - 12 - 24 - svg.getBoundingClientRect().width < cell;
	}));
	assert.ok(fill.every(Boolean), fill.join());
	// drawn to fit, not stretched: lines and stone outlines as thin as on a board of the usual size
	const looks = await page.evaluate(() => [...document.querySelectorAll('.kifu-bases-card .kifu-svg')].map((svg) => {
		const unitsPerPx = Number(svg.getAttribute('viewBox').split(' ')[2]) / svg.getBoundingClientRect().width;
		const w = svg.querySelector('.kifu-w');
		return { grid: svg.querySelector('.kifu-grid').getAttribute('stroke-width'), ring: Math.round((Number(w.getAttribute('stroke-width')) / unitsPerPx) * 10) / 10 };
	}));
	assert.ok(looks.every((l) => l.grid === '1' && l.ring <= 1.2), JSON.stringify(looks));
	// the properties chosen for the view, as Obsidian renders them; empty ones left out
	assert.deepEqual(await page.locator('.kifu-bases-prop').allTextContents(), ['level20k']);
	// the options the view offers
	assert.deepEqual(await page.evaluate(() => window.__base.reg.options().map((o) => o.key)), ['boardScale', 'playable']);
	// the first board only (the problem, not the 9x9 after it), and it plays
	assert.equal(await cap(page, 0), 'Black to live');
	await clickPoint(page, 0, 'ab');
	await sleep(700);
	await clickPoint(page, 0, 'ac');
	await sleep(100);
	assert.match(await cap(page, 0), /^Correct/);
	// it is not edited from here
	const box = await page.locator('.kifu-svg').nth(0).boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await lockBtn(page, 0).click();
	assert.ok((await notices(page)).some((n) => /shown in a base\. Open the note to edit it\./.test(n)));
	// the title opens the note (with Ctrl, in a new tab)
	await page.locator('.kifu-bases-title').nth(1).click();
	await page.locator('.kifu-bases-title').nth(1).click({ modifiers: ['Control'] });
	assert.deepEqual(await page.evaluate(() => window.harness.app._opened), [['G.md', false], ['G.md', true]]);
	// new data from the base: a card whose note did not change keeps its board (and the solved problem)
	const first = await page.evaluateHandle(() => document.querySelector('.kifu-bases-card .kifu-svg'));
	await page.evaluate(() => window.__base.view.onDataUpdated());
	await sleep(100);
	assert.equal(await page.evaluate((el) => el.isConnected, first), true);
	assert.match(await cap(page, 0), /^Correct/);
	// pictures only: no buttons, and a click on a board opens its note
	await page.evaluate(() => { window.__base.config.values.playable = false; window.__base.view.onDataUpdated(); });
	await sleep(400);
	assert.equal(await page.locator('.kifu-bases.is-static').count(), 1);
	assert.equal(await page.locator('.kifu-bases-card .kifu-ctl').first().evaluate((e) => getComputedStyle(e).display), 'none');
	await page.locator('.kifu-bases-board').nth(1).click({ force: true });
	assert.deepEqual((await page.evaluate(() => window.harness.app._opened)).at(-1), ['G.md', false]);
	// the board size the view asks for
	await page.evaluate(() => { window.__base.config.values.boardScale = 100; window.__base.view.onDataUpdated(); });
	await sleep(400);
	const widths = await page.evaluate(() => [...document.querySelectorAll('.kifu-bases-card .kifu-svg')].map((e) => Number(e.getAttribute('width'))));
	assert.ok(widths.every((w) => w > 0), widths.join());
});

await scenario('the Bases view: a note whose first board is an embedded link', {
	files: {
		'Only.md': '# A puzzle\n\n![](https://online-go.com/puzzle/2)\n',
		'Before.md': '![](https://online-go.com/game/9)\n\n```kifu\n(;SZ[9];B[ii])\n```\n',
		'After.md': '```kifu\n(;SZ[9];B[aa])\n```\n\n![](https://online-go.com/game/9)\n',
		'Code.md': 'Not a board:\n\n```\n![](https://online-go.com/game/9)\n```\n\nnor `![](https://online-go.com/game/9)`\n',
		'Broken.md': '![](https://online-go.com/game/404)\n',
	},
	panes: [],
}, async (page) => {
	await page.evaluate(() => {
		const h = window.harness;
		const { requestUrl } = window.__obsidian;
		requestUrl.answers['https://online-go.com/api/v1/puzzles/2'] = { status: 200, json: {
			name: 'P', puzzle: { width: 9, height: 9, initial_player: 'black', initial_state: { black: 'aaba', white: 'cacb' }, puzzle_description: 'Black to live',
				move_tree: { x: -1, y: -1, branches: [{ x: 0, y: 1, branches: [{ x: 1, y: 1, branches: [{ x: 0, y: 2, correct_answer: true }] }] }] } },
		} };
		requestUrl.answers['https://online-go.com/api/v1/games/9/sgf'] = { status: 200, text: '(;FF[4]GM[1]SZ[9];B[ee];W[cc];B[gg])' };
		const v = h.app.vault;
		const entries = ['Only.md', 'Before.md', 'After.md', 'Code.md', 'Broken.md'].map((path) => ({ file: v.getAbstractFileByPath(path), getValue: () => null }));
		const config = { get: (k) => (k === 'boardScale' ? 60 : true), getOrder: () => ['file.name'], getDisplayName: (p) => p };
		const host = document.createElement('div');
		host.style.width = '900px';
		document.getElementById('main').appendChild(host);
		const view = h.app._basesViews.get('kifu-boards').factory({ app: h.app, config, data: { groupedData: [{ hasKey: () => false, entries }] } }, host);
		view.load();
		view.onDataUpdated();
	});
	await sleep(500);
	const cards = page.locator('.kifu-bases-card');
	const boardIn = (i) => cards.nth(i).locator('.kifu-svg').count();
	// the embedded puzzle, drawn and playable
	assert.equal(await boardIn(0), 1);
	assert.equal(await cards.nth(0).locator('.kifu-cap').textContent(), 'Black to live');
	// the embed comes first: its game (2 black stones, 1 white), not the block's single stone
	const stonesIn = (i) => cards.nth(i).locator('.kifu-svg').evaluate((svg) => {
		const n = (q) => (svg.querySelector(q).getAttribute('d').match(/M/g) ?? []).length;
		return [n('.kifu-b'), n('.kifu-w')];
	});
	assert.deepEqual(await stonesIn(1), [2, 1]);
	// the block comes first: its board
	assert.deepEqual(await stonesIn(2), [1, 0]);
	// links in code are not boards
	assert.equal(await boardIn(3), 0);
	assert.equal(await cards.nth(3).locator('.kifu-bases-none').textContent(), 'No board in this note.');
	// an embed that can not be fetched says why, on its card (once it is in sight: boards are drawn then)
	await cards.nth(4).scrollIntoViewIfNeeded();
	await sleep(300);
	assert.match(await cards.nth(4).locator('.kifu-bases-none.is-error').textContent(), /OGS has no game 404, or it is not public\./);
});

await scenario('the start switch writes a move line, and the locked board opens there', {
	files: { 'S.md': '# S\n\n```kifu\n(;SZ[9];B[dd];W[ee];B[ff])\n```\n' },
	panes: [{ path: 'S.md', mode: 'source' }],
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
	assert.match(await doc(page), /```kifu\nmove: 2\n\(;SZ\[9\];B\[dd\];W\[ee\];B\[ff\]\)\n```/);
	assert.deepEqual(await stones(page), { black: 1, white: 1 });
});

await scenario('an SGF file that changes while an edit is pending wins', {
	files: { 'games/g.sgf': '(;GM[1]SZ[9]AB[cc])', 'Y.md': '```kifu\nsgf: [[g.sgf]]\n```\n' },
	panes: [{ path: 'Y.md', mode: 'source' }],
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

/** Close the pane a note is open in (as with the note's tab). */
const closePane = (page, i = 0) =>
	page.evaluate((i) => { const h = window.harness; h.app.workspace._leaves.find((l) => l.view === h.views[i]).detach(); }, i);

await scenario('a note that can not be written once its pane is closed: the edit is written later', {
	files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100, saveDelay: 1000, allowErrors: /writing the note failed|EBUSY/,
}, async (page) => {
	await failOnce(page, 'process');
	await toggleLock(page);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	// closed before the edit was written: with no editor left, it goes into the file itself
	await closePane(page);
	await sleep(500);
	assert.equal(await text(page, 'N.md'), ONE);
	assert.match((await notices(page))[0], /could not be written, so an edit is not saved yet\. Saving will be tried again/);
	// tried again, and this time it works
	await sleep(2500);
	assert.equal(await text(page, 'N.md'), ONE.replace('AB[cc]', 'AB[cc][ee]'));
	assert.equal((await notices(page)).length, 1);
});

await scenario('an SGF file that can not be written: the same', {
	files: { 'g.sgf': '(;GM[1]SZ[9]AB[cc])', 'Y.md': '```kifu\nsgf: [[g.sgf]]\n```\n' }, panes: [{ path: 'Y.md', mode: 'source' }], autosave: 100,
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
	panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
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
	files: { 'g.sgf': '(;GM[1]SZ[9]CA[gb2312]PB[Li]AB[cc])', 'Y.md': '```kifu\nsgf: g.sgf\n```\n' }, panes: [{ path: 'Y.md', mode: 'source' }], autosave: 100,
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

await scenario('the label box keeps the keyboard when a save redraws the board (live preview)', { files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100 }, async (page) => {
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
	files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
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
	files: { 'T.md': '# Twins\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nend\n' }, panes: [{ path: 'T.md', mode: 'source' }], autosave: 100, height: 1400,
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
	files: { 'T.md': SAME }, panes: [{ path: 'T.md', mode: 'source' }], autosave: 100, height: 1400,
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
	// work in the editor; the reading pane next door sees none of it
	await toggleLock(page, 0);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 0, 'ee');
	await sleep(600);
	const first = await page.evaluate(() => window.harness.views[0].data);
	assert.equal(first, ONE.replace('AB[cc]', 'AB[cc][ee]'));
	await clickPoint(page, 0, 'gg');
	await sleep(600);
	assert.equal(await page.evaluate(() => window.harness.views[0].data), ONE.replace('AB[cc]', 'AB[cc][ee][gg]'));
	// now the reading pane catches up half way: it draws the text of the first write
	await page.evaluate((t) => window.harness.views[1].renderer.set(t), first);
	await sleep(50);
	// its new drawing is still that board, showing what the board holds now (and not as
	// unlocked: that is the editor's business)
	assert.deepEqual(await isEditing(page), [true, false]);
	assert.deepEqual(await stones(page, 1), { black: 3, white: 0 });
	await clickPoint(page, 0, 'aa');
	await sleep(600);
	assert.equal(await page.evaluate(() => window.harness.views[0].data), ONE.replace('AB[cc]', 'AB[cc][ee][gg][aa]'));
	assert.deepEqual(await notices(page), []);
});

for (const mode of ['source']) {
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
		h.views = [h.app.workspace._open(path, 'source')];
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

await scenario('identical boards in a note with CR LF line endings, written into the file', {
	files: { 'T.md': SAME.replace(/\n/g, '\r\n') }, panes: [{ path: 'T.md', mode: 'source' }], autosave: 100, saveDelay: 1000, height: 1400,
}, async (page) => {
	const crlf = (t) => t.replace(/\n/g, '\r\n');
	await toggleLock(page, 1);
	await tool(page, 'Black stone').click();
	await clickPoint(page, 1, 'ee');
	// closed before the edit was written: it goes into the file itself, into the second
	// block and not its twin, and the line endings are kept
	await closePane(page);
	await sleep(700);
	assert.equal(await text(page, 'T.md'), crlf('# Twins\n\n```kifu\n(;SZ[9]AB[cc])\n```\n\nbetween\n\n```kifu\n(;SZ[9]AB[cc][ee])\n```\n\nend\n'));
	assert.deepEqual(await notices(page), []);
});

for (const mode of ['source']) {
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
	panes: [{ path: 'N.md', mode: 'source' }], autosave: 100,
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
	files: { 'g.sgf': '(;GM[1]SZ[9]AB[cc])', 'A.md': '```kifu\nsgf: g.sgf\n```\n\n```kifu\n(;SZ[9]AB[dd])\n```\n' }, panes: [{ path: 'A.md', mode: 'source' }], autosave: 100, height: 1300,
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

await scenario('Escape in the middle of dragging a crop (live preview)', { files: { 'N.md': ONE }, panes: [{ path: 'N.md', mode: 'source' }], autosave: 100 }, async (page) => {
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
