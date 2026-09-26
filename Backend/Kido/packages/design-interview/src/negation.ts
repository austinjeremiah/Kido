/**
 * Clause-scoped negation. A keyword inside a clause that contains a negator *before* it ("never
 * bridge", "do not pay mallory", "anywhere except the backend") does not count as asked for.
 * Parsers use this so that a refusal can never be read as a grant (BREAK F-0500…F-0534).
 */
const BOUNDARY = /[,;.!?\n]|\bbut\b|\bhowever\b|\bwhereas\b|\bonly\b|\bjust\b/gi;
const NEGATOR = /\b(not|never|no|nope|don'?t|do not|doesn'?t|does not|cannot|can'?t|mustn'?t|must not|shouldn'?t|should not|won'?t|without|except|excluding|forbid|forbidden|disallow|disallowed|refuse|nor|neither)\b/i;

function clauseStart(text: string, index: number): number {
  let start = 0;
  BOUNDARY.lastIndex = 0;
  for (let m = BOUNDARY.exec(text); m && m.index < index; m = BOUNDARY.exec(text)) start = m.index + m[0].length;
  return start;
}

/** True when the match at `index` sits in a negated scope of its clause. */
export function negatedAt(text: string, index: number): boolean {
  return NEGATOR.test(text.slice(clauseStart(text, index), index));
}

/** All non-negated matches of `re` in `text` (re must be global). */
export function affirmed(text: string, re: RegExp): RegExpMatchArray[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return [...text.matchAll(g)].filter((m) => !negatedAt(text, m.index ?? 0));
}

export function hasAffirmed(text: string, re: RegExp): boolean {
  return affirmed(text, re).length > 0;
}

export function hasNegator(text: string): boolean {
  return NEGATOR.test(text);
}
