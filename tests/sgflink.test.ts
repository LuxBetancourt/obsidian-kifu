import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSgf, isSgfLink, readSgfLink } from '../src/sgflink';
import { ImportError } from '../src/importing';

test('links to SGF files', () => {
	assert.equal(isSgfLink('https://files.example.com/go/game.sgf'), true);
	assert.equal(isSgfLink('http://192.168.1.20:8080/kifu/My%20Game.SGF'), true);
	assert.equal(isSgfLink('https://example.com/a.sgf?token=abc'), true);
	assert.equal(isSgfLink('https://example.com/a.sgf#move-50'), true);
	assert.equal(isSgfLink('https://example.com/a.sgf.png'), false);
	assert.equal(isSgfLink('https://example.com/view?file=a.sgf'), false); // (the page, not the file)
	assert.equal(isSgfLink('file:///C:/games/a.sgf'), false);
	assert.equal(isSgfLink('not a link.sgf'), false);
});

test('decoding: UTF-8, or the charset the file names', () => {
	const utf8 = new TextEncoder().encode('(;GM[1]C[囲碁])');
	assert.equal(decodeSgf(utf8.buffer), '(;GM[1]C[囲碁])');
	// 囲碁 in Shift_JIS, in a file that says so
	const head = new TextEncoder().encode('(;GM[1]CA[Shift_JIS]C[');
	const sjis = new Uint8Array([...head, 0x88, 0xcd, 0x8c, 0xe9, 0x5d, 0x29]);
	assert.equal(decodeSgf(sjis.buffer), '(;GM[1]CA[Shift_JIS]C[囲碁])');
	// a charset nobody knows: what UTF-8 makes of it
	const odd = new Uint8Array([...new TextEncoder().encode('(;CA[klingon]C['), 0xff, 0x5d, 0x29]);
	assert.match(decodeSgf(odd.buffer), /^\(;CA\[klingon\]C\[\ufffd\]\)$/);
});

test('what the server answered', () => {
	const bytes = (s: string) => () => new TextEncoder().encode(s).buffer as ArrayBuffer;
	assert.equal(readSgfLink('https://x/a.sgf', 200, bytes('(;GM[1];B[aa])')), '(;GM[1];B[aa])');
	const fails = (status: number, body: string, msg: RegExp) =>
		assert.throws(() => readSgfLink('https://x/a.sgf', status, bytes(body)), (e) => e instanceof ImportError && msg.test(e.message));
	fails(404, '', /there is no file at https:\/\/x\/a\.sgf/);
	fails(403, '', /refused to send the file/);
	fails(500, '', /answered 500/);
	fails(200, '<html>login</html>', /is not an SGF file/);
});
