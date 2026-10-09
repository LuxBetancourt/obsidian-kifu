/** Plugin-wide defaults. A board uses these unless its own block says otherwise. */

export interface KifuSettings {
	/** 1 = 100 %. Per board: `scale:`. */
	scale: number;
	/** White paper with black ink, or the colours of the current theme. Per board: `style:`. */
	style: 'paper' | 'theme';
	/** Coordinates along the left and bottom edges. Per board: `coords:`. */
	coords: boolean;
	/** What a board shows when it has no `view:` line. */
	view: 'auto' | 'full';
	/** Number the moves as a position is played out. Per board: `numbers:`. */
	numberPlayed: boolean;
	/** Per board: `align:`. */
	align: 'left' | 'center' | 'right';
	/** Size of a board that has no SGF yet. Per board: `size:`. */
	boardSize: number;
	/** Show the comment of the current move under the board. Per board: `comments:`. */
	showComments: boolean;
	/** How the saved lines answer when one has several replies. */
	reply: 'first' | 'random';
	/** Pause before the reply is played, in milliseconds. */
	replyDelay: number;
	/** Bring the move tree panel forward when a board is unlocked. */
	revealPanel: boolean;
	/** While a problem is locked, the panel shows only the moves played, not the saved answers. */
	hideAnswers: boolean;
}

export const DEFAULT_SETTINGS: KifuSettings = {
	scale: 1,
	style: 'paper',
	coords: false,
	view: 'auto',
	numberPlayed: true,
	align: 'center',
	boardSize: 19,
	showComments: true,
	reply: 'first',
	replyDelay: 350,
	revealPanel: true,
	hideAnswers: true,
};

/** Pixels between two lines at 100 % scale. */
export const BASE_CELL = 24;

export const BLOCK_LANG = 'kifu';
export const VIEW_TYPE = 'kifu-tree';

/**
 * How long a block we have just rewritten has to be drawn again and reclaim its
 * board's state. (A reading pane beside an editor follows it with some delay.)
 */
export const HANDBACK = 5000;
