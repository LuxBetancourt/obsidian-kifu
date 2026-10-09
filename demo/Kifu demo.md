# Kifu demo

Every board on this page is a `kifu` code block. Switch the note to source mode to see how each one is written, and keep `Kifu demo.sgf` in the same folder as this note.

## A problem

Click a point to answer. The lines saved in the block reply, and tell you how it went. `Esc` (or the ↺ button beside the board) starts over.

```kifu
(;GM[1]FF[4]SZ[19]AB[oa][ob][oc][pc][qc][rc][sc]AW[pa][pb][qb][rb][sb]C[Black to play and kill.]
(;B[ra]C[The middle of three is the vital point.];W[qa];B[sa]C[White is captured.])
(;B[qa];W[ra]C[White captures and has two eyes.])
(;B[sa];W[ra]C[White captures and has two eyes.]))
```

## A numbered figure

`numbers: on` shows the moves the way a book prints them.

```kifu
numbers: on
(;GM[1]FF[4]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])
```

Without that line the same block shows the position the moves lead to. Click it and use the arrow keys to step through them.

```kifu
(;GM[1]FF[4]SZ[19];B[pd];W[nc];B[qf];W[pb];B[qc];W[kc])
```

## Marks and letters

A `view:` line picks the part of the board to show.

```kifu
view: top-right 13x11
(;GM[1]FF[4]SZ[19]AB[pd][qf][qc]AW[nc][pb][kc]TR[kc]SQ[pd]CR[qf]MA[pb]LB[qj:a][hc:b])
```

## A board from an SGF file

`game: 2` is the second game in the file. Unlocking and editing this board changes the file, not the note.

```kifu
sgf: [[Kifu demo.sgf]]
game: 2
```

## A board to draw on

Move the mouse over it and click the lock that appears beside its upper right corner. The first tool plays moves in turn, the next two put single stones down, and the panel in the right sidebar shows the moves as a tree. Click the lock again when you are done, and look at what was written into the block.

```kifu
size: 9
coords: on
```
