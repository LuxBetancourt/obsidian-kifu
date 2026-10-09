// Makes the pictures in docs/ from the demo note, using the test page.
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, open, here, pointXY, clickPoint, sleep, toggleLock, tool } from './lib.mjs';

const root = path.resolve(here, '../..');
const docs = path.join(root, 'docs');
mkdirSync(docs, { recursive: true });
const demo = readFileSync(path.join(root, 'demo/Kifu demo.md'), 'utf8');
const sgf = readFileSync(path.join(root, 'demo/Kifu demo.sgf'), 'utf8');
const blocks = [...demo.matchAll(/```kifu\n[\s\S]*?```/g)].map((m) => m[0]);
const [problem, figure, , marks, fromFile] = blocks;

const browser = await chromium.launch();

// 1. Three kinds of board, side by side.
{
	const note = [figure, problem, marks].join('\n\n');
	const { page, errors } = await open(browser, { scale: 2, width: 1000, height: 420, files: { 'Boards.md': note }, panes: [{ path: 'Boards.md', mode: 'preview' }] });
	await page.addStyleTag({
		content: `.view-header { display: none } .markdown-preview-view { max-width: none; display: flex; align-items: flex-start; justify-content: center; gap: 8px; padding: 18px 8px }
			.markdown-preview-view > div { flex: none } .kifu { margin: 0 }`,
	});
	await sleep(100);
	const box = await page.locator('.markdown-preview-view').boundingBox();
	const bottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.kifu')].map((k) => k.getBoundingClientRect().bottom)));
	await page.screenshot({ path: path.join(docs, 'boards.png'), clip: { x: box.x, y: box.y, width: box.width, height: bottom - box.y + 18 } });
	if (errors.length) console.log('boards', errors);
	await page.context().close();
}

// 2. A board being edited, with the move tree beside it.
{
	const { page, errors } = await open(browser, { scale: 2, width: 1120, height: 640, files: { 'Edit.md': problem }, panes: [{ path: 'Edit.md', mode: 'preview' }], autosave: 100 });
	await page.addStyleTag({ content: '.view-header { display: none } .markdown-preview-view { padding-top: 14px }' });
	await toggleLock(page);
	await sleep(150);
	await clickPoint(page, 0, 'ra');
	await clickPoint(page, 0, 'qa');
	await page.keyboard.press('ArrowLeft');
	const p = await pointXY(page, 0, 'pe');
	await page.mouse.move(p.x, p.y + 200);
	await sleep(400);
	const bar = await page.locator('.kifu-tools').boundingBox();
	await page.screenshot({ path: path.join(docs, 'editing.png'), clip: { x: 0, y: 0, width: 1120, height: Math.min(640, bar.y + bar.height + 16) } });
	if (errors.length) console.log('editing', errors);
	await page.context().close();
}

// 3. The same file-backed problem, half solved (for a look at the panel while playing).
{
	const { page, errors } = await open(browser, {
		scale: 2, width: 860, height: 330, files: { 'File.md': fromFile, 'Kifu demo.sgf': sgf }, panes: [{ path: 'File.md', mode: 'preview' }],
	});
	await page.addStyleTag({ content: '.view-header { display: none } .markdown-preview-view { padding-top: 14px }' });
	await page.evaluate(() => window.harness.app._commands.find((c) => c.id === 'show-tree').callback());
	await sleep(150);
	await clickPoint(page, 0, 'ba');
	await sleep(600);
	await page.mouse.move(5, 300);
	await sleep(300);
	await page.screenshot({ path: path.join(docs, 'playing.png') });
	if (errors.length) console.log('playing', errors);
	await page.context().close();
}

await browser.close();
console.log('docs pictures written');
