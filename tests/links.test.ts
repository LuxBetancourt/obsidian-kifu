import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkWorld, makeRetarget, relinkBody, rewriteComments, rewriteLinks, sgfRef } from '../src/links';

// A small vault after the renames, as links see it: what a target reaches, and how a file is named.
function vault(files: string[]): LinkWorld {
	return {
		reaches(target) {
			const t = target.toLowerCase();
			return files.find((f) => {
				const l = f.toLowerCase();
				return l === t || l === t + '.md' || l.endsWith('/' + t) || (l.endsWith('.md') && l.endsWith('/' + t + '.md'));
			}) ?? null;
		},
		name(path, _source, keepMd) {
			const base = path.split('/').pop() as string;
			const text = files.filter((f) => f.split('/').pop() === base).length === 1 ? base : path;
			return keepMd ? text : text.replace(/\.md$/, '');
		},
	};
}

const FILES = ['Notes/Renamed.md', 'Other.md', 'games/new game.sgf', 'games/new.sgf', 'A/Twin.md', 'B/Twin.md'];
const RENAMED = new Map([
	['Notes/Old.md', 'Notes/Renamed.md'],
	['games/old game.sgf', 'games/new game.sgf'],
	['games/old.sgf', 'games/new.sgf'],
	['A/Pair.md', 'A/Twin.md'],
	['B/Pair.md', 'B/Twin.md'],
]);
const retarget = makeRetarget(vault(FILES), RENAMED, 'Notes/Doc.md');
const fix = (s: string) => rewriteLinks(s, retarget);

test('links: a wikilink to a renamed note follows it, keeping its heading, alias and embed mark', () => {
	assert.equal(fix('see [[Old]]'), 'see [[Renamed]]'); // a short link
	assert.equal(fix('see [[Notes/Old]]'), 'see [[Renamed]]'); // the whole path
	assert.equal(fix('[[Old#Ladder|the ladder]] and ![[Old]]'), '[[Renamed#Ladder|the ladder]] and ![[Renamed]]');
	assert.equal(fix('[[Other]] [[#Here]] [[]]'), '[[Other]] [[#Here]] [[]]'); // still found, this note, empty
	assert.equal(fix('no links here'), 'no links here');
});

test('links: Markdown links, URL-encoded or in angle brackets, keep ".md" and their form', () => {
	assert.equal(fix('[see](Old.md)'), '[see](Renamed.md)');
	assert.equal(fix('[see](./Old.md#Top "a title")'), '[see](Renamed.md#Top "a title")'); // from the note's own folder
	assert.equal(fix('[g](games/old%20game.sgf)'), '[g](new%20game.sgf)');
	assert.equal(fix('[g](<games/old game.sgf>)'), '[g](<new game.sgf>)');
	// web addresses, mail and headings of this note are no files
	const left = '[w](https://x.org/Old.md) [m](mailto:a@b.c) [t](#Old) [s](not a link)';
	assert.equal(fix(left), left);
});

test('links: a link that could have meant either of two renamed files is left alone', () => {
	assert.equal(fix('[[Pair]]'), '[[Pair]]'); // A/Pair or B/Pair: no telling which
	assert.equal(fix('[[A/Pair]]'), '[[A/Twin]]'); // the path says which (and the new name is not unique)
});

test('links: comments in an SGF text are rewritten in place, every other byte left as it was', () => {
	const sgf = '(;GM[1]GN[about [[Old\\]\\]]\n  C[see [[Old\\]\\] here]\n;B[aa]C[nothing])';
	assert.equal(rewriteComments(sgf, fix), '(;GM[1]GN[about [[Old\\]\\]]\n  C[see [[Renamed\\]\\] here]\n;B[aa]C[nothing])');
	// an old file's property name spelt out
	assert.equal(rewriteComments('(;Comment[[[Old\\]\\]])', fix), '(;Comment[[[Renamed\\]\\]])');
	// "C[" inside another property's value is not a comment; text outside the games is not looked at
	const other = '[[Old]] (;GN[says C[x\\] [[Old\\]\\]]C[ok])';
	assert.equal(rewriteComments(other, fix), other);
	// nothing to change: the very same text back
	const same = '(;C[see [[Other\\]\\]])';
	assert.equal(rewriteComments(same, fix), same);
});

test('links: the "sgf:" value follows its file, written as it was', () => {
	const ref = (v: string) => sgfRef(v, retarget);
	assert.equal(ref('[[old.sgf]]'), '[[new.sgf]]');
	assert.equal(ref('[[old]]'), '[[new]]'); // (".sgf" left out, as it may be)
	assert.equal(ref('old.sgf'), 'new.sgf');
	assert.equal(ref('"games/old game.sgf"'), '"new game.sgf"');
	assert.equal(ref('[[old.sgf|my game]]'), '[[new.sgf|my game]]');
	assert.equal(ref('[[new.sgf]]'), null); // already right
	assert.equal(ref('[[elsewhere.sgf]]'), null); // never renamed
});

test('links: a block body has its "sgf:" line and its comments mended, nothing else', () => {
	const ref = (v: string) => sgfRef(v, retarget);
	const body = ['caption: C[x] is [[Old]]', 'sgf:  [[old.sgf]]', 'scale: 0.8', '(;GM[1]C[see [[Old\\]\\]];B[aa])', 'after'].join('\n');
	assert.equal(
		relinkBody(body, fix, ref),
		['caption: C[x] is [[Old]]', 'sgf:  [[new.sgf]]', 'scale: 0.8', '(;GM[1]C[see [[Renamed\\]\\]];B[aa])', 'after'].join('\n'),
	);
	assert.equal(relinkBody('sgf: [[old]]', fix, ref), 'sgf: [[new]]'); // option lines only
	assert.equal(relinkBody('(;C[see [[Old\\]\\]])', fix, ref), '(;C[see [[Renamed\\]\\]])'); // a game only
	assert.equal(relinkBody('scale: 1\n(;C[[[Other\\]\\]])', fix, ref), null); // nothing to change
});
