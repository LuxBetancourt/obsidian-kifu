/** What every import from a website has in common. */

export interface Fetched {
	/** The game, ready for a block. */
	sgf: string;
	/** What is said about it, for the link above the board ("Life and death, 14 kyu, by adum"). */
	about: string;
}

/** Why an import did not work, in words for a notice. */
export class ImportError extends Error {}
