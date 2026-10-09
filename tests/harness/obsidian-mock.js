/*
 * A stand-in for the parts of the Obsidian API this plugin uses, so the plugin can be
 * exercised in a plain browser. It mimics documented behaviour only:
 *   - code block processors get (source, el, ctx) with el = div.block-language-xxx
 *   - a section is re-rendered (and its render children unloaded) when its text changes
 *   - reading views follow the file; editing views own their text and save it later
 * Where Obsidian's behaviour is not documented, the mock has a switch and the checks
 * are run both ways (asyncRender, lagReading, reuse).
 */
(function () {
	const listeners = () => new Map();

	class Events {
		constructor() { this._ev = listeners(); }
		on(name, cb) { const l = this._ev.get(name) ?? []; l.push(cb); this._ev.set(name, l); return { name, cb, src: this }; }
		offref(ref) { const l = this._ev.get(ref.name) ?? []; const i = l.indexOf(ref.cb); if (i >= 0) l.splice(i, 1); }
		trigger(name, ...args) { for (const cb of (this._ev.get(name) ?? []).slice()) cb(...args); }
	}

	class Component {
		constructor() { this._loaded = false; this._children = []; this._cleanup = []; }
		load() { if (this._loaded) return; this._loaded = true; this.onload(); for (const c of this._children) c.load(); }
		onload() {}
		unload() {
			if (!this._loaded) return; this._loaded = false;
			for (const c of this._children.splice(0)) c.unload();
			for (const fn of this._cleanup.splice(0)) fn();
			this.onunload();
		}
		onunload() {}
		addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
		removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload(); } return c; }
		register(fn) { this._cleanup.push(fn); }
		registerEvent(ref) { this._cleanup.push(() => ref.src.offref(ref)); }
		registerDomEvent(el, type, fn, opts) { el.addEventListener(type, fn, opts); this._cleanup.push(() => el.removeEventListener(type, fn, opts)); }
		registerInterval(id) { this._cleanup.push(() => clearInterval(id)); return id; }
	}

	class MarkdownRenderChild extends Component {
		constructor(containerEl) { super(); this.containerEl = containerEl; }
	}

	class TAbstractFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); } }
	class TFile extends TAbstractFile {
		constructor(path) { super(path); const i = this.name.lastIndexOf('.'); this.extension = i < 0 ? '' : this.name.slice(i + 1); this.basename = i < 0 ? this.name : this.name.slice(0, i); this.stat = { mtime: Date.now(), size: 0 }; }
	}
	class TFolder extends TAbstractFile {}

	const normalizePath = (p) => p.replace(/[\\/]+/g, '/').replace(/^\/|\/$/g, '').replace(/ /g, ' ').normalize();

	class Vault extends Events {
		constructor() { super(); this.files = new Map(); this.binary = new Map(); this.writes = []; }
		_add(path, data, bytes) { const f = new TFile(path); this.files.set(path, { file: f, data }); if (bytes) this.binary.set(path, bytes); return f; }
		getAbstractFileByPath(p) { return this.files.get(p)?.file ?? null; }
		getFileByPath(p) { return this.getAbstractFileByPath(p); }
		getFiles() { return [...this.files.values()].map((e) => e.file); }
		async cachedRead(f) { await 0; return this.files.get(f.path).data; }
		async read(f) { return this.cachedRead(f); }
		async readBinary(f) { await 0; return this.binary.get(f.path) ?? new TextEncoder().encode(this.files.get(f.path).data).buffer; }
		async modify(f, data) { await 0; this._set(f, data); }
		async process(f, fn) {
			await 0;
			const e = this.files.get(f.path);
			const out = fn(e.data);
			if (out !== e.data) this._set(f, out);
			return out;
		}
		_set(f, data) {
			const e = this.files.get(f.path);
			e.data = data; f.stat.mtime = Date.now();
			this.writes.push({ path: f.path, data });
			this.trigger('modify', f);
		}
		_rename(f, to) {
			const old = f.path; const e = this.files.get(old); this.files.delete(old);
			f.path = to; f.name = to.split('/').pop(); this.files.set(to, e);
			this.trigger('rename', f, old);
		}
	}

	class MetadataCache extends Events {
		constructor(vault) { super(); this.vault = vault; }
		getFirstLinkpathDest(link, _source) {
			const want = normalizePath(link);
			const all = this.vault.getFiles();
			return all.find((f) => f.path === want) ?? all.find((f) => f.path === want + '.md')
				?? all.find((f) => f.name === want) ?? all.find((f) => f.path.endsWith('/' + want)) ?? null;
		}
		fileToLinktext(file) {
			const same = this.vault.getFiles().filter((f) => f.name === file.name);
			return same.length > 1 ? file.path : file.name;
		}
	}

	/* ---------------------------------------------------------------- markdown */

	const FENCE = /^([ \t>]*)(`{3,}|~{3,})\s*(\S*)/;

	/** Split a note into sections: fenced blocks (incl. callouts wrapping them) and paragraphs. */
	function sections(text) {
		const lines = text.split('\n');
		const out = [];
		let i = 0;
		while (i < lines.length) {
			if (!lines[i].trim()) { i++; continue; }
			const m = FENCE.exec(lines[i]);
			if (m) {
				let j = i + 1;
				const strip = (l) => l.startsWith(m[1]) ? l.slice(m[1].length) : l.replace(/^[ \t>]+/, '');
				while (j < lines.length && !(strip(lines[j]).trim().startsWith(m[2]) && strip(lines[j]).trim().replace(new RegExp(m[2][0] === '`' ? '`' : '~', 'g'), '') === '')) j++;
				// a callout/quote section runs over all its quoted lines
				let start = i, end = Math.min(j, lines.length - 1);
				if (m[1].includes('>')) {
					while (start > 0 && lines[start - 1].startsWith('>')) start--;
					while (end + 1 < lines.length && lines[end + 1].startsWith('>')) end++;
				}
				out.push({ type: 'code', lang: m[3], lineStart: start, lineEnd: end, source: lines.slice(i + 1, j).map(strip).join('\n') + '\n', raw: lines.slice(start, end + 1).join('\n') });
				i = end + 1;
			} else {
				let j = i;
				while (j + 1 < lines.length && lines[j + 1].trim() && !FENCE.test(lines[j + 1])) j++;
				out.push({ type: 'text', lineStart: i, lineEnd: j, raw: lines.slice(i, j + 1).join('\n') });
				i = j + 1;
			}
		}
		return out;
	}

	let docCounter = 0;

	/** Renders a note, re-using the DOM of sections whose text did not change. */
	class Renderer extends Component {
		constructor(app, container, sourcePath, live) {
			super();
			this.app = app; this.container = container; this.sourcePath = sourcePath; this.live = live;
			this.docId = 'doc' + (++docCounter);
			this.rendered = []; // { raw, el, child components }
			this.text = '';
			this.load();
		}
		set(text) {
			this.text = text;
			const next = sections(text);
			const old = this.rendered;
			const result = new Array(next.length);
			let pool;
			if (this.app._reuse === 'ends') {
				// The way a diff would: what is unchanged at the start and at the end of the
				// note keeps its drawing, everything in between is drawn afresh.
				let a = 0;
				while (a < old.length && a < next.length && old[a].raw === next[a].raw) { old[a].sec = next[a]; result[a] = old[a]; a++; }
				let b = 0;
				while (b < old.length - a && b < next.length - a && old[old.length - 1 - b].raw === next[next.length - 1 - b].raw) {
					const r = old[old.length - 1 - b]; r.sec = next[next.length - 1 - b]; result[next.length - 1 - b] = r; b++;
				}
				pool = old.slice(a, old.length - b);
				for (let i = a; i < next.length - b; i++) result[i] = this.make(next[i]);
			} else {
				// By text alone, wherever it stood: a drawing may end up on another section
				// that reads the same. (Nothing says a renderer may not do this.)
				pool = old.slice();
				next.forEach((sec, i) => {
					const k = pool.findIndex((r) => r.raw === sec.raw);
					if (k >= 0) { const r = pool.splice(k, 1)[0]; r.sec = sec; result[i] = r; }
					else result[i] = this.make(sec);
				});
			}
			for (const r of pool) { r.el.remove(); for (const c of r.children) this.removeChild(c); }
			// put them in order
			let prev = null;
			for (const r of result) {
				if (prev ? prev.el.nextSibling !== r.el : this.container.firstChild !== r.el) this.container.insertBefore(r.el, prev ? prev.el.nextSibling : this.container.firstChild);
				prev = r;
			}
			this.rendered = result;
		}
		make(sec) {
			const r = { raw: sec.raw, sec, children: [], el: null };
			const doc = this.container.ownerDocument;
			if (sec.type === 'text') {
				const h = /^(#{1,6})\s+(.*)$/.exec(sec.raw);
				r.el = doc.createElement('div');
				r.el.className = h ? 'el-h' + h[1].length : 'el-p';
				const inner = doc.createElement(h ? 'h' + h[1].length : 'p');
				inner.textContent = h ? h[2] : sec.raw;
				r.el.appendChild(inner);
				return r;
			}
			const handler = this.app._processors.get(sec.lang);
			const block = doc.createElement('div');
			if (!handler) {
				r.el = doc.createElement('div'); r.el.className = 'el-pre';
				const pre = doc.createElement('pre'); const code = doc.createElement('code'); code.textContent = sec.source; pre.appendChild(code); r.el.appendChild(pre);
				return r;
			}
			block.className = 'block-language-' + sec.lang;
			if (this.live) {
				r.el = doc.createElement('div');
				r.el.className = 'cm-preview-code-block cm-embed-block markdown-rendered';
				r.el.contentEditable = 'false';
				r.el.appendChild(block);
				const edit = doc.createElement('div'); edit.className = 'edit-block-button'; edit.textContent = '</>';
				r.el.appendChild(edit);
			} else {
				r.el = doc.createElement('div'); r.el.className = 'el-pre';
				r.el.appendChild(block);
			}
			const ctx = {
				docId: this.docId, sourcePath: this.sourcePath, frontmatter: null,
				addChild: (c) => { r.children.push(c); this.addChild(c); },
				getSectionInfo: (el) => {
					// (embeds, hover previews and the like give none)
					if (this.app._noSectionInfo) return null;
					const hit = this.rendered.find((x) => x.el.contains(el)) ?? (r.el.contains(el) ? r : null);
					return hit ? { text: this.text, lineStart: hit.sec.lineStart, lineEnd: hit.sec.lineEnd } : null;
				},
			};
			const run = () => { try { const p = handler(sec.source, block, ctx); if (p && p.catch) p.catch((e) => console.error('processor failed', e)); } catch (e) { console.error('processor failed', e); } };
			run();
			return r;
		}
		clear() { this.set(''); }
	}

	class Editor {
		constructor(view) { this.view = view; this.cursor = { line: 0, ch: 0 }; }
		getValue() { return this.view.data; }
		lineCount() { return this.view.data.split('\n').length; }
		getLine(n) { return this.view.data.split('\n')[n] ?? ''; }
		getCursor() { return this.cursor; }
		setCursor(pos) { this.cursor = pos; }
		_offset(pos) { const lines = this.view.data.split('\n'); let o = 0; for (let i = 0; i < pos.line && i < lines.length; i++) o += lines[i].length + 1; return Math.min(this.view.data.length, o + pos.ch); }
		replaceRange(text, from, to) {
			const a = this._offset(from); const b = this._offset(to ?? from);
			this.view._edit(this.view.data.slice(0, a) + text + this.view.data.slice(b));
		}
	}

	class View extends Component {
		constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = leaf.containerEl; this.navigation = true; this.scope = null; }
		getIcon() { return 'document'; }
		async onOpen() {} async onClose() {}
	}
	class ItemView extends View {
		constructor(leaf) {
			super(leaf);
			const doc = leaf.containerEl.ownerDocument;
			const header = doc.createElement('div'); header.className = 'view-header';
			this.contentEl = doc.createElement('div'); this.contentEl.className = 'view-content';
			leaf.containerEl.append(header, this.contentEl);
			this._header = header;
		}
	}

	/** A note open in a pane, either as a reading view or as an editor with live preview. */
	class MarkdownView extends ItemView {
		constructor(leaf, file, mode) {
			super(leaf);
			this.file = file; this.mode = mode; this.data = ''; this.dirty = false;
			this.editor = new Editor(this);
			this.contentEl.classList.add(mode === 'source' ? 'markdown-source-view' : 'markdown-reading-view');
			if (mode === 'source') this.contentEl.classList.add('mod-cm6', 'is-live-preview');
			const inner = this.contentEl.ownerDocument.createElement('div');
			inner.className = mode === 'source' ? 'cm-content cm-contentContainer' : 'markdown-preview-view markdown-rendered';
			if (mode === 'source') inner.contentEditable = 'true';
			this.contentEl.appendChild(inner);
			this._header.textContent = file.basename + (mode === 'source' ? '  ·  live preview' : '  ·  reading view');
			this.renderer = new Renderer(this.app, inner, file.path, mode === 'source');
			this.data = this.app.vault.files.get(file.path).data;
			this.renderer.set(this.data);
		}
		getViewType() { return 'markdown'; }
		getMode() { return this.mode; }
		getViewData() { return this.data; }
		/** An edit made through the editor: every view of the note follows; the file is written later. */
		_edit(text) {
			this.data = text; this.dirty = true;
			// (with _lagReading, a reading view beside the editor only follows once the file has been written)
			const lags = (v) => this.app._lagReading && v !== this && v.mode === 'preview';
			const apply = () => { for (const v of this.app.workspace._markdownViews(this.file.path)) { if (lags(v)) continue; v.data = text; v.renderer.set(text); } };
			if (this.app._asyncRender) Promise.resolve().then(apply); else apply();
			// (only an editor says so; "typing" into a reading view is a way of the checks to change a note it shows)
			if (this.mode === 'source' && this.app._editorChange !== false) this.app.workspace.trigger('editor-change', this.editor, this);
			clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => this.save(), this.app._autosave ?? 2000);
		}
		async save() {
			clearTimeout(this._saveTimer);
			if (!this.dirty) return;
			this.dirty = false;
			for (const v of this.app.workspace._markdownViews(this.file.path)) v.dirty = false;
			this._saving = true;
			await this.app.vault.modify(this.file, this.data);
			this._saving = false;
		}
		/** The file changed on disk. */
		_external(data) {
			if (this.data === data) return;
			this.data = data; this.dirty = false;
			this.renderer.set(data);
		}
		unload() { this.renderer.unload(); super.unload(); }
	}

	class WorkspaceLeaf {
		constructor(app, parent) {
			this.app = app;
			this.containerEl = parent.ownerDocument.createElement('div');
			this.containerEl.className = 'workspace-leaf';
			parent.appendChild(this.containerEl);
			this.view = null;
		}
		get isDeferred() { return false; }
		async loadIfDeferred() {}
		async setViewState(state) {
			const factory = this.app._views.get(state.type);
			this._setView(factory(this));
			await this.view.onOpen();
		}
		_setView(view) { this.view = view; view.load(); }
		detach() { this.view?.unload(); this.containerEl.remove(); const l = this.app.workspace._leaves; l.splice(l.indexOf(this), 1); }
	}

	class Workspace extends Events {
		constructor(app) { super(); this.app = app; this._leaves = []; this.layoutReady = true; this.activeEditor = null; this.revealed = []; }
		onLayoutReady(cb) { cb(); }
		iterateAllLeaves(cb) { for (const l of this._leaves.slice()) cb(l); }
		getLeavesOfType(type) { return this._leaves.filter((l) => l.view && l.view.getViewType() === type); }
		getActiveViewOfType(cls) { const l = this._leaves.find((x) => x.view instanceof cls); return l ? l.view : null; }
		_markdownViews(path) { return this._leaves.map((l) => l.view).filter((v) => v instanceof MarkdownView && v.file.path === path); }
		async ensureSideLeaf(type, side, opts = {}) {
			let leaf = this.getLeavesOfType(type)[0];
			if (!leaf) {
				leaf = new WorkspaceLeaf(this.app, this.app._dom[side]);
				this._leaves.push(leaf);
				await leaf.setViewState({ type });
			}
			if (opts.reveal !== false) await this.revealLeaf(leaf);
			return leaf;
		}
		async revealLeaf(leaf) { this.revealed.push(leaf.view.getViewType()); this.app._dom.right.classList.remove('is-collapsed'); }
		getRightLeaf() { const leaf = new WorkspaceLeaf(this.app, this.app._dom.right); this._leaves.push(leaf); return leaf; }
		/** test helper: open a note in a new pane */
		_open(path, mode) {
			const leaf = new WorkspaceLeaf(this.app, this.app._dom.main);
			this._leaves.push(leaf);
			leaf._setView(new MarkdownView(leaf, this.app.vault.getAbstractFileByPath(path), mode));
			return leaf.view;
		}
	}

	class App {
		constructor(dom) {
			this._dom = dom;
			this._processors = new Map(); this._views = new Map(); this._commands = []; this._settingTabs = []; this._icons = new Map(); this._notices = [];
			this.vault = new Vault();
			this.metadataCache = new MetadataCache(this.vault);
			this.workspace = new Workspace(this);
			this.vault.on('modify', (f) => {
				for (const v of this.workspace._markdownViews(f.path)) if (!v._saving) v._external(this.vault.files.get(f.path).data);
			});
		}
	}

	class Plugin extends Component {
		constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this._data = null; }
		registerMarkdownCodeBlockProcessor(lang, handler) {
			if (this.app._processors.has(lang)) throw new Error(`Code block postprocessor for language ${lang} is already registered`);
			this.app._processors.set(lang, handler);
			this.register(() => this.app._processors.delete(lang));
		}
		registerView(type, factory) { this.app._views.set(type, factory); }
		addSettingTab(tab) { this.app._settingTabs.push(tab); }
		addCommand(cmd) { this.app._commands.push(cmd); return cmd; }
		async loadData() { await 0; return this._data ? JSON.parse(this._data) : null; }
		async saveData(d) { await 0; this._data = JSON.stringify(d); }
	}

	class SettingTab { constructor(app) { this.app = app; this.containerEl = document.createElement('div'); this.containerEl.className = 'vertical-tab-content'; } }
	class PluginSettingTab extends SettingTab { constructor(app, plugin) { super(app); } display() {} hide() {} }

	class Setting {
		constructor(containerEl) {
			const d = containerEl.ownerDocument;
			this.settingEl = d.createElement('div'); this.settingEl.className = 'setting-item';
			this.infoEl = d.createElement('div'); this.infoEl.className = 'setting-item-info';
			this.nameEl = d.createElement('div'); this.nameEl.className = 'setting-item-name';
			this.descEl = d.createElement('div'); this.descEl.className = 'setting-item-description';
			this.controlEl = d.createElement('div'); this.controlEl.className = 'setting-item-control';
			this.infoEl.append(this.nameEl, this.descEl); this.settingEl.append(this.infoEl, this.controlEl);
			containerEl.appendChild(this.settingEl);
		}
		setName(t) { this.nameEl.textContent = t; return this; }
		setDesc(t) { this.descEl.textContent = t; return this; }
		setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
		_control(tag, type, build) {
			const input = this.controlEl.ownerDocument.createElement(tag); if (type) input.type = type; this.controlEl.appendChild(input);
			let handler = () => {};
			const api = {
				inputEl: input, selectEl: input, sliderEl: input, toggleEl: input,
				setLimits(min, max, step) { input.min = min; input.max = max; input.step = step; return api; },
				setValue(v) { if (type === 'checkbox') input.checked = !!v; else input.value = v; return api; },
				getValue() { return type === 'checkbox' ? input.checked : type === 'range' ? Number(input.value) : input.value; },
				setDynamicTooltip() { return api; }, setPlaceholder(p) { input.placeholder = p; return api; }, setTooltip() { return api; }, setIcon() { return api; }, setButtonText(t) { input.textContent = t; return api; },
				addOption(value, label) { const o = input.ownerDocument.createElement('option'); o.value = value; o.textContent = label; input.appendChild(o); return api; },
				onChange(fn) { handler = fn; return api; }, onClick(fn) { input.addEventListener('click', fn); return api; },
			};
			input.addEventListener(type === 'range' || type === 'text' ? 'input' : 'change', () => handler(api.getValue()));
			build(api);
			return this;
		}
		addSlider(cb) { return this._control('input', 'range', cb); }
		addToggle(cb) { return this._control('input', 'checkbox', cb); }
		addText(cb) { return this._control('input', 'text', cb); }
		addDropdown(cb) { return this._control('select', null, cb); }
		addButton(cb) { return this._control('button', null, cb); }
		addExtraButton(cb) { return this._control('button', null, cb); }
	}

	class Notice { constructor(message) { Notice.log.push(String(message)); console.log('[notice]', message); } }
	Notice.log = [];

	class Modal { constructor(app) { this.app = app; Modal.last = this; } open() { this.isOpen = true; } close() { this.isOpen = false; } }
	class SuggestModal extends Modal { setPlaceholder(p) { this.placeholder = p; } }
	class FuzzySuggestModal extends SuggestModal {}

	// Menus as plugins see them. setSubmenu is not in the published API; Menu.noSubmenu
	// takes it away, to check the fallback.
	class MenuItem {
		constructor() { this.title = ''; this.icon = null; this.section = null; this.submenu = null; this.click = null; }
		setTitle(t) { this.title = String(t); return this; }
		setIcon(i) { this.icon = i; return this; }
		setSection(s) { this.section = s; return this; }
		onClick(fn) { this.click = fn; return this; }
		setChecked(c) { this.checked = c; return this; }
		setDisabled(d) { this.disabled = d; return this; }
	}
	MenuItem.prototype.setSubmenu = function () { return (this.submenu = new Menu()); };
	class Menu {
		constructor() { this.items = []; }
		addItem(cb) {
			const item = new MenuItem();
			if (Menu.noSubmenu) item.setSubmenu = undefined;
			this.items.push(item);
			cb(item);
			return this;
		}
	}
	Menu.noSubmenu = false;

	const icons = new Map();

	window.__obsidian = {
		App, Plugin, Component, Events, MarkdownRenderChild, MarkdownView, ItemView, View, WorkspaceLeaf, Editor,
		TFile, TFolder, TAbstractFile, Vault, PluginSettingTab, Setting, Notice, Modal, SuggestModal, FuzzySuggestModal, Menu, MenuItem,
		normalizePath,
		addIcon: (id, content) => icons.set(id, content),
		setIcon: () => {}, setTooltip: () => {},
		debounce: (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
		Platform: { isMobile: false, isDesktop: true },
		requireApiVersion: () => true,
		_icons: icons,
	};
})();
