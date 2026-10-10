// Shared helpers for the browser-driven checks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
export const { chromium, webkit, devices } = require('playwright');
export const here = path.dirname(fileURLToPath(import.meta.url));
export const out = path.resolve(here, '../out');
export const pageUrl = 'file://' + path.join(here, 'index.html');
export const mainJs = () => readFileSync(path.resolve(here, '../../main.js'), 'utf8');
mkdirSync(out, { recursive: true });

let cmBundle = null;

/** The CodeMirror live preview stand-in (cm-lp.ts), bundled on first use. */
async function cmLivePreview() {
	if (cmBundle === null) {
		const esbuild = require('esbuild');
		const r = await esbuild.build({ entryPoints: [path.join(here, 'cm-lp.ts')], bundle: true, format: 'iife', target: 'es2022', write: false, logLevel: 'warning' });
		cmBundle = r.outputFiles[0].text;
	}
	return cmBundle;
}

/**
 * Start a page with the plugin loaded. `panes` opens notes in the mock's own views
 * (reading view, or a simple live preview); `live` opens notes in the CodeMirror
 * live preview, with `lp` setting its switches. Everything else goes to harness.boot().
 */
export async function open(browser, { width = 1280, height = 900, scale = 1, dark = false, font = null, live = [], lp = {}, device = null, ...boot } = {}) {
	// (`device`: Playwright context options for a phone or tablet, touch included)
	const ctx = await browser.newContext(device ?? { viewport: { width, height }, deviceScaleFactor: scale });
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e.stack || e)));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	await page.goto(pageUrl);
	// Obsidian on phones and tablets lays the app out at the device's width
	if (device) await page.evaluate(() => document.head.insertAdjacentHTML('afterbegin', '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">'));
	if (dark) await page.evaluate(() => { document.body.className = 'theme-dark'; });
	if (font) await page.evaluate((f) => document.body.style.setProperty('--test-font', f), font);
	// (the stand-in brings the CodeMirror the plugin is given: it goes in first)
	await page.addScriptTag({ content: await cmLivePreview() });
	await page.evaluate((code) => window.harness.loadPlugin(code), mainJs());
	await page.evaluate((b) => window.harness.boot(b), boot);
	if (live.length) {
		await page.evaluate(([lp, live]) => { Object.assign(window.LP, lp); for (const p of live) window.openLivePreview(p); }, [lp, live]);
		await sleep(80);
	}
	await page.evaluate(() => document.fonts.ready);
	return { page, ctx, errors };
}

/** Centre of a board point on screen, for the nth board on the page. */
export async function pointXY(page, board, pt, sel = '.kifu-svg') {
	return page.evaluate(([board, pt, sel]) => {
		const svg = document.querySelectorAll(sel)[board];
		const [vx, vy, vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number);
		const box = svg.getBoundingClientRect();
		const x = pt.charCodeAt(0) - 97, y = pt.charCodeAt(1) - 97;
		return { x: box.left + ((x * 100 + 50 - vx) / vw) * box.width, y: box.top + ((y * 100 + 50 - vy) / vh) * box.height };
	}, [board, pt, sel]);
}

export async function clickPoint(page, board, pt) {
	const p = await pointXY(page, board, pt);
	await page.mouse.click(p.x, p.y);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* What the checks look at. */
export const text = (page, path) => page.evaluate((p) => window.harness.text(p), path);
/** The text an open pane holds (for an editor: possibly not written to the file yet). */
export const doc = (page, i = 0) => page.evaluate((i) => window.harness.views[i].data, i);
export const notices = (page) => page.evaluate(() => window.harness.notices());
export const cap = (page, i = 0) => page.evaluate((i) => document.querySelectorAll('.kifu-cap')[i]?.textContent ?? '', i);
export const capHidden = (page, i = 0) => page.evaluate((i) => document.querySelectorAll('.kifu-cap')[i].hidden, i);
export const stones = (page, i = 0) =>
	page.evaluate((i) => {
		const svg = document.querySelectorAll('.kifu-svg')[i];
		if (!svg) return null;
		const n = (sel) => (svg.querySelector(sel).getAttribute('d').match(/M/g) ?? []).length;
		return { black: n('.kifu-b'), white: n('.kifu-w') };
	}, i);
export const labels = (page, i = 0) =>
	page.evaluate((i) => [...document.querySelectorAll('.kifu-svg')[i].querySelectorAll('.kifu-text')].map((t) => t.textContent).sort().join(','), i);
export const lockBtn = (page, i = 0) => page.locator('.kifu-ctl .kifu-btn[aria-label*="nlock"], .kifu-ctl .kifu-btn[aria-label^="Lock"]').nth(i);
export const tool = (page, title, i = 0) => page.locator(`.kifu-tools .kifu-btn[aria-label^="${title}"]`).nth(i);
export const boardCount = (page) => page.locator('.kifu-svg').count();
export const isEditing = (page) => page.evaluate(() => [...document.querySelectorAll('.kifu')].map((k) => k.classList.contains('is-editing')));
/** Which element has the keyboard, as "TAG.first-class". */
export const active = (page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		return a ? (typeof a.className === 'string' && a.className ? a.tagName + '.' + a.className.split(' ')[0] : a.tagName) : null;
	});
/** Unlock (or lock) the nth board, the way a user does: move the mouse over it, click the lock. */
export async function toggleLock(page, i = 0) {
	const box = await page.locator('.kifu-svg').nth(i).boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await lockBtn(page, i).click();
}

/** Runs named scenarios, each on a fresh page, and reports. */
export function runner(browser) {
	const results = [];
	let shots = 0;
	return {
		/** `allowErrors` (a pattern) names console errors the scenario provokes on purpose. */
		async scenario(name, { allowErrors = null, ...opts }, fn) {
			// (ONLY=pattern in the environment runs the scenarios whose name matches)
			if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
			const { page, errors } = await open(browser, opts);
			try {
				await fn(page);
				assert.deepEqual(allowErrors ? errors.filter((e) => !allowErrors.test(e)) : errors, [], 'no page errors');
				results.push(['ok', name]);
			} catch (e) {
				results.push(['FAIL', name, e.stack ?? String(e)]);
				await page.screenshot({ path: `${out}/fail-${++shots}.png` }).catch(() => {});
			}
			await page.context().close();
		},
		/** Print the results; returns the number of failures. */
		report() {
			for (const [status, name, err] of results) {
				console.log(`${status === 'ok' ? '\u2714' : '\u2716'} ${name}`);
				if (err) console.log(err.split('\n').slice(0, 16).map((l) => '    ' + l).join('\n'));
			}
			const failed = results.filter((r) => r[0] !== 'ok').length;
			console.log(`\n${results.length - failed} passed, ${failed} failed`);
			return failed;
		},
	};
}
