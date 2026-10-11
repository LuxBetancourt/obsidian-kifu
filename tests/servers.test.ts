import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questToSgf, readDgs, readFox, readGoQuest, serverTarget, tidyFox } from '../src/servers';
import { ImportError } from '../src/importing';
import { getText, parseSgf } from '../src/sgf';

test('links to games on other servers', () => {
	assert.deepEqual(serverTarget('https://www.dragongoserver.net/game.php?gid=1000000'), {
		server: 'dgs', id: '1000000', url: 'https://www.dragongoserver.net/game.php?gid=1000000', api: 'https://www.dragongoserver.net/sgf.php?gid=1000000',
	});
	assert.equal((serverTarget('http://dragongoserver.net/sgf.php?gid=42&owned_comments=1') as { api: string }).api, 'https://www.dragongoserver.net/sgf.php?gid=42');
	assert.equal(serverTarget('https://www.dragongoserver.net/userinfo.php?uid=5'), null);
	assert.equal((serverTarget('https://h5.foxwq.com/yehunewshare/?chessid=1791604708010001161&title=x&boardsize=19') as { api: string }).api,
		'https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?chessid=1791604708010001161');
	assert.equal((serverTarget('https://h5.foxwq.com/txwqshare/index.html?chessid=1676910620010001365&boardsize=19') as { id: string }).id, '1676910620010001365');
	assert.equal(serverTarget('https://h5.foxwq.com/yehunewshare/?title=no-id'), null);
	assert.deepEqual(serverTarget('https://kifu.questgames.net/go/04zyq2qiw1s4'), {
		server: 'goquest', id: '04zyq2qiw1s4', url: 'https://kifu.questgames.net/go/04zyq2qiw1s4', api: 'https://kifu.questgames.net/game/04zyq2qiw1s4.json',
	});
	assert.equal(serverTarget('https://kifu.questgames.net/shogi/games/abc'), null);
	assert.deepEqual(serverTarget('https://stone.gs/games/ogs/12345'), { server: 'stonegs-ogs', ogsId: 12345 });
	assert.equal(serverTarget('https://stone.gs/games/aaaa00000000000000000001'), null);
	assert.equal(serverTarget('https://example.com/game.php?gid=1'), null);
});

test('Fox: komi in hundredths of a stone, handicap stones after the start', () => {
	const root = parseSgf(tidyFox('(;GM[1]FF[4]SZ[19]PB[a]PW[b]KM[375]HA[2];AB[pd][dp];W[dd];B[pp])'))[0];
	assert.equal(getText(root, 'KM'), '7.5');
	assert.deepEqual(root.props.AB, ['pd', 'dp']);
	assert.deepEqual(root.children[0].props.W, ['dd']); // (the setup node is gone, the moves follow the start)
	assert.equal(root.children[0].parent, root);
	assert.equal(getText(parseSgf(tidyFox('(;KM[325];B[aa])'))[0], 'KM'), '6.5');
	assert.equal(getText(parseSgf(tidyFox('(;KM[650];B[aa])'))[0], 'KM'), '6.5');
	assert.equal(getText(parseSgf(tidyFox('(;KM[0];B[aa])'))[0], 'KM'), '0');
	assert.equal(getText(parseSgf(tidyFox('(;KM[6.5];B[aa])'))[0], 'KM'), '6.5'); // (already in points)
	// what Fox answers
	const ok = readFox(serverTargetOf('fox'), 200, () => JSON.stringify({ result: 0, chessid: '1', chess: '(;GM[1]KM[375];B[pd])' }));
	assert.match(ok, /KM\[7\.5\]/);
	assert.throws(() => readFox(serverTargetOf('fox'), 200, () => '{"result":101200,"chess":""}'), (e) => e instanceof ImportError && /Fox has no game 1/.test(e.message));
});

test('GoQuest: its moves as SGF, and who won', () => {
	const sgf = questToSgf({
		gtype: 'go9', players: [{ id: 'dark206', name: 'DARK206' }, { name: 'Kitten' }],
		position: { size: 9, moves: [{ m: 'B[ee]' }, { m: 'W[fe]' }, { m: 'B[ib]' }, { s: 'LOSE:RESIGN' }] },
		created: '2026-10-09T04:30:13.563Z',
	});
	assert.equal(sgf, '(;GM[1]FF[4]SZ[9]PC[GoQuest]PB[DARK206]PW[Kitten]DT[2026-10-09]RE[B+R];B[ee];W[fe];B[ib])');
	assert.match(questToSgf({ position: { size: 9, moves: [{ m: 'B[ee]' }, { m: 'W[fe]' }, { s: 'LOSE:TIME' }] } }), /RE\[W\+T\]/);
	assert.doesNotMatch(questToSgf({ position: { size: 9, moves: [{ m: 'B[ee]' }, { s: 'DRAW' }] } }), /RE\[/);
	assert.throws(() => readGoQuest(serverTargetOf('goquest'), 200, () => '{"error":"Game not found"}'), (e) => e instanceof ImportError && /GoQuest has no game 1 any more/.test(e.message));
});

test('Dragon Go Server: its files name no charset (Latin-1 when not UTF-8)', () => {
	// "Café" in Latin-1, in a file with no CA
	const bytes = new Uint8Array([...new TextEncoder().encode('(;GM[1]PB[Caf'), 0xe9, ...new TextEncoder().encode('];B[aa])')]);
	assert.equal(readDgs(serverTargetOf('dgs'), 200, () => bytes.buffer), '(;GM[1]PB[Café];B[aa])');
	assert.throws(() => readDgs(serverTargetOf('dgs'), 404, () => new ArrayBuffer(0)), (e) => e instanceof ImportError && /Dragon Go Server has no game 1/.test(e.message));
	assert.throws(() => readDgs(serverTargetOf('dgs'), 200, () => new TextEncoder().encode('<html>').buffer), (e) => e instanceof ImportError && /sent no game/.test(e.message));
});

function serverTargetOf(server: 'dgs' | 'fox' | 'goquest') {
	return { server, id: '1', url: 'u', api: 'a' } as const;
}
