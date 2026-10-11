/**
 * Boards from links to games on other Go servers: Dragon Go Server, Fox (野狐), GoQuest,
 * and OGS games as Stone.gs shows them. For each, the link a player copies, where the
 * record can be fetched without signing in, and how what comes back becomes SGF. (The
 * requests are made by the plugin; this is plain work on what came back.)
 */

import { ImportError } from './importing';
import { SgfNode, findGames, getMove, getText, parseSgf, serializeSgf, setText } from './sgf';
import { decodeSgf } from './sgflink';

export type ServerTarget =
	| { server: 'dgs'; id: string; url: string; api: string }
	| { server: 'fox'; id: string; url: string; api: string }
	| { server: 'goquest'; id: string; url: string; api: string };

const param = (url: URL, name: string): string => url.searchParams.get(name) ?? '';

/** The game a link is to, on one of these servers; or, for Stone.gs, the OGS game number. */
export function serverTarget(href: string): ServerTarget | { server: 'stonegs-ogs'; ogsId: number } | null {
	let u: URL;
	try {
		u = new URL(href.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const host = u.hostname.toLowerCase().replace(/^www\./, '');
	// Dragon Go Server: the game page, or its SGF download
	if (host === 'dragongoserver.net' && /^\/(game|sgf)\.php$/i.test(u.pathname)) {
		const gid = param(u, 'gid');
		if (!/^\d+$/.test(gid)) return null;
		return { server: 'dgs', id: gid, url: `https://www.dragongoserver.net/game.php?gid=${gid}`, api: `https://www.dragongoserver.net/sgf.php?gid=${gid}` };
	}
	// Fox: the pages its "share" button makes
	if (host === 'h5.foxwq.com' && /^\/(yehunewshare|txwqshare)(\/|$)/i.test(u.pathname)) {
		const id = param(u, 'chessid');
		if (!/^\d{10,}$/.test(id)) return null;
		return { server: 'fox', id, url: `https://h5.foxwq.com/yehunewshare/?chessid=${id}`, api: `https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?chessid=${id}` };
	}
	// GoQuest: its game record pages
	if (host === 'kifu.questgames.net') {
		const m = /^\/go\/([A-Za-z0-9]{6,})\/?$/.exec(u.pathname);
		if (!m) return null;
		return { server: 'goquest', id: m[1], url: `https://kifu.questgames.net/go/${m[1]}`, api: `https://kifu.questgames.net/game/${m[1]}.json` };
	}
	// Stone.gs shows OGS games under its own address
	if (host === 'stone.gs') {
		const m = /^\/games\/ogs\/(\d+)\/?$/.exec(u.pathname);
		return m ? { server: 'stonegs-ogs', ogsId: parseInt(m[1]) } : null;
	}
	return null;
}

const NAME: Record<ServerTarget['server'], string> = { dgs: 'Dragon Go Server', fox: 'Fox', goquest: 'GoQuest' };

function checkStatus(t: ServerTarget, status: number): void {
	if (status === 404 || status === 401 || status === 403) throw new ImportError(`${NAME[t.server]} has no game ${t.id}, or it is not public.`);
	if (status !== 200) throw new ImportError(`${NAME[t.server]} answered ${status} for game ${t.id}.`);
}

/* ------------------------------------------------------------------ DGS */

/** Dragon Go Server's SGF download. Its files name no charset: UTF-8, else Western (Latin-1). */
export function readDgs(t: ServerTarget, status: number, bytes: () => ArrayBuffer): string {
	checkStatus(t, status);
	const text = decodeSgf(bytes(), 'windows-1252');
	if (!findGames(text).length) throw new ImportError(`Dragon Go Server sent no game for ${t.id}.`);
	return text;
}

/* ------------------------------------------------------------------ Fox */

/**
 * Fox's SGF, tidied: komi is written in hundredths of a stone (KM[375] is 3.75 stones,
 * that is 7.5 points), and handicap stones are put in a node after the start rather
 * than in it.
 */
export function tidyFox(sgf: string): string {
	const root = parseSgf(sgf)[0];
	if (!root) throw new Error('no SGF');
	const km = parseFloat(getText(root, 'KM'));
	if (Math.abs(km) >= 200) {
		let komi = km / 100;
		if (Math.abs(komi) <= 4 && Math.abs((Math.abs(komi) * 4) % 2) === 1) komi *= 2;
		setText(root, 'KM', String(komi));
	}
	// a node of setup stones alone, right after the start: its stones belong to the start
	const first = root.children[0] as SgfNode | undefined;
	if (root.children.length === 1 && first && !getMove(first) && (first.props.AB || first.props.AW) && Object.keys(first.props).every((k) => k === 'AB' || k === 'AW')) {
		for (const k of ['AB', 'AW'] as const) if (first.props[k]) root.props[k] = [...(root.props[k] ?? []), ...first.props[k]];
		root.children = first.children;
		for (const c of root.children) c.parent = root;
	}
	return serializeSgf(root);
}

export function readFox(t: ServerTarget, status: number, text: () => string): string {
	checkStatus(t, status);
	let data: { result?: number; chess?: string } | null = null;
	try {
		data = JSON.parse(text()) as { result?: number; chess?: string };
	} catch {
		// (handled below)
	}
	if (!data || data.result !== 0 || typeof data.chess !== 'string' || !data.chess.includes('(')) throw new ImportError(`Fox has no game ${t.id}, or it is not public.`);
	try {
		return tidyFox(data.chess);
	} catch {
		throw new ImportError(`the record of Fox game ${t.id} could not be read.`);
	}
}

/* -------------------------------------------------------------- GoQuest */

interface QuestGame {
	gtype?: string;
	players?: { name?: string; id?: string }[];
	position?: { size?: number; moves?: { m?: string; s?: string }[] };
	created?: string;
	error?: string;
}

/** A GoQuest game (JSON: its players, then its moves as SGF moves) as SGF. */
export function questToSgf(g: QuestGame): string {
	const size = Number(g.position?.size) || 9;
	const [black, white] = g.players ?? [];
	let sgf = `(;GM[1]FF[4]SZ[${size}]PC[GoQuest]`;
	const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
	const bn = black?.name ?? black?.id;
	const wn = white?.name ?? white?.id;
	if (bn) sgf += `PB[${esc(bn)}]`;
	if (wn) sgf += `PW[${esc(wn)}]`;
	if (g.created && /^\d{4}-\d\d-\d\d/.test(g.created)) sgf += `DT[${g.created.slice(0, 10)}]`;
	let moves = '';
	let last: 'B' | 'W' | null = null;
	let result = '';
	for (const e of g.position?.moves ?? []) {
		if (e.m && /^[BW]\[[a-s]{0,2}\]$/.test(e.m)) {
			moves += ';' + e.m;
			last = e.m[0] as 'B' | 'W';
		} else if (e.s) {
			// "LOSE:RESIGN": the side to move loses (that is, the one that did not move last)
			const m = /^LOSE:(RESIGN|TIME)/.exec(e.s);
			if (m && last) result = `${last}+${m[1] === 'RESIGN' ? 'R' : 'T'}`;
		}
	}
	if (result) sgf += `RE[${result}]`;
	return sgf + moves + ')';
}

export function readGoQuest(t: ServerTarget, status: number, text: () => string): string {
	checkStatus(t, status);
	let data: QuestGame | null = null;
	try {
		data = JSON.parse(text()) as QuestGame;
	} catch {
		// (handled below)
	}
	// (GoQuest keeps games for a while only: an older one answers "Game not found")
	if (!data || data.error || !data.position) throw new ImportError(`GoQuest has no game ${t.id} any more, or it is not public.`);
	return questToSgf(data);
}
