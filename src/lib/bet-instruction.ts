/**
 * WHAT, EXACTLY, TO BUY.
 *
 * Everywhere else in the product a position is identified as a market plus an outcome index, which
 * is precise and frequently unreadable. `"Will Venezia FC vs. ACF Fiorentina end in a draw?"` with
 * the outcome `"No"` is a perfectly well-defined bet and tells you almost nothing about what you
 * are supposed to click, and `"Spread: Bills (-1.5)"` on the `"Texans"` side is worse — the number
 * shown belongs to the other team.
 *
 * This module turns that pair into an instruction and, more importantly, into the two sentences
 * that actually matter: what has to happen for it to pay, and what has to happen for it to lose.
 *
 * TWO RULES, both inherited from `plain-language.ts`.
 *
 * Descriptive, never predictive. "You win if the teams combine for 42 or more points" states the
 * settlement condition. It is not a claim that they will.
 *
 * Degrade, never invent. Polymarket question text is free-form and changes without notice. Every
 * parser here is a best effort over a known format, and when the format is not recognised the
 * result falls back to naming the outcome verbatim rather than guessing at a meaning. A vague
 * instruction is recoverable; a confidently wrong one loses money.
 *
 * Pure and unit-tested.
 */

export interface BetInstructionInput {
  /** Market question, e.g. "Bills vs. Texans: O/U 41.5". */
  question: string;
  /** The outcome being bought, e.g. "Over", "No", "Bills". */
  outcomeLabel: string;
  /** Every outcome on the market, index-aligned. Used to name the losing side. */
  outcomes: string[];
  outcomeIndex: number;
  /** Raw `sportsMarketType`. Null on everything that is not a sports market. */
  sportsMarketType?: string | null;
}

export interface BetInstruction {
  /** Imperative, and the headline of the card. e.g. "Bet OVER 41.5 total points". */
  action: string;
  /** Settlement condition for a win. Always populated. */
  winsIf: string;
  /** Settlement condition for a loss. Always populated. */
  losesIf: string;
  /** The label to look for on Polymarket, which is the raw outcome. */
  clickLabel: string;
  /**
   * False when the question format was not recognised and the instruction is the generic
   * fallback. The UI uses this to tell the reader to check the market text themselves.
   */
  recognised: boolean;
}

/** Yes/No markets need completely different phrasing from team-name markets. */
function isYesNo(label: string): boolean {
  const l = label.trim().toLowerCase();
  return l === "yes" || l === "no";
}

function isOverUnder(label: string): boolean {
  const l = label.trim().toLowerCase();
  return l === "over" || l === "under";
}

/** The other outcome's label, or a neutral phrase when there isn't exactly one. */
function opposingLabel(input: BetInstructionInput): string | null {
  if (input.outcomes.length !== 2) return null;
  return input.outcomes[input.outcomeIndex === 0 ? 1 : 0] ?? null;
}

/**
 * Pulls the line out of a totals or spread question.
 *
 * Handles "O/U 41.5", "1H O/U 22.5", "Spread: Bills (-1.5)" and "Bills (+3)". Returns null rather
 * than a wrong number when nothing matches, because a spread instruction quoting the wrong line is
 * worse than one quoting none.
 */
export function extractLine(question: string): number | null {
  const overUnder = question.match(/O\/U\s*([+-]?\d+(?:\.\d+)?)/i);
  if (overUnder) {
    const n = Number(overUnder[1]);
    if (Number.isFinite(n)) return n;
  }
  const parenthesised = question.match(/\(\s*([+-]\d+(?:\.\d+)?)\s*\)/);
  if (parenthesised) {
    const n = Number(parenthesised[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** The team a spread is quoted against, e.g. "Bills" from "Spread: Bills (-1.5)". */
export function extractSpreadTeam(question: string): string | null {
  const match = question.match(/Spread:\s*(.+?)\s*\(/i);
  return match ? match[1].trim() : null;
}

/**
 * The verbs Polymarket actually puts after "Will …", with their third-person forms.
 *
 * Conjugating arbitrary English would be a source of confident nonsense, so this is a closed list
 * and anything outside it keeps the verb as written. "Rodri win the Ballon d'Or" reads slightly
 * off; it cannot mislead.
 */
const VERBS: Array<[RegExp, string]> = [
  [/\bwin\b/i, "wins"],
  [/\bbeat\b/i, "beats"],
  [/\bend\b/i, "ends"],
  [/\bscore\b/i, "scores"],
  [/\breach\b/i, "reaches"],
  [/\bhit\b/i, "hits"],
  [/\bbe\b/i, "is"],
  [/\bhave\b/i, "has"],
  [/\bmake\b/i, "makes"],
  [/\bqualify\b/i, "qualifies"],
  [/\badvance\b/i, "advances"],
];

export interface Proposition {
  /** Third-person statement, for "wins if" / "loses if": "Rodri wins the 2026 Ballon d'Or". */
  statement: string;
  /** Negated statement: "Rodri does not win the 2026 Ballon d'Or". */
  negatedStatement: string;
  /** Future affirmative, for the YES instruction: "Rodri will win the 2026 Ballon d'Or". */
  willHappen: string;
  /** Future negative, for the NO instruction: "Rodri will NOT win the 2026 Ballon d'Or". */
  willNotHappen: string;
}

/**
 * Negated third-person form of a base verb.
 *
 * Regular verbs take do-support — "win" becomes "does not win". "Be" is the one irregular that
 * appears here and takes none, so "there be a recession" negates to "there is not a recession"
 * rather than the ungrammatical "there does not be".
 */
function negateVerb(verb: string): string {
  return /^be$/i.test(verb) ? "is not" : `does not ${verb}`;
}

/**
 * The proposition inside a "Will X …?" question, in the three forms the instruction needs.
 *
 * A question is already in the interrogative inversion — "Will Venezia end in a draw?" — so the
 * declarative just needs `will` moved back in front of the verb. Locating the verb is the same
 * work as conjugating it, so all three forms come out of one pass. This is what makes the NO case
 * read as "Venezia will NOT end in a draw" rather than the earlier, technically-correct
 * "Venezia ends in a draw does not happen".
 */
export function propositionFromQuestion(question: string): Proposition | null {
  const trimmed = question.trim().replace(/\?+$/, "");
  const match = trimmed.match(/^Will\s+(.+)$/i);
  if (!match) return null;

  const rest = match[1].trim();
  if (!rest) return null;

  for (const [pattern, thirdPerson] of VERBS) {
    if (!pattern.test(rest)) continue;
    const verb = rest.match(pattern)?.[0] ?? "";
    return {
      statement: rest.replace(pattern, thirdPerson),
      negatedStatement: rest.replace(pattern, negateVerb(verb)),
      willHappen: rest.replace(pattern, `will ${verb}`),
      willNotHappen: rest.replace(pattern, `will NOT ${verb}`),
    };
  }

  // Verb not recognised, so neither `will` nor do-support can be placed. Fall back to forms that
  // need no verb position at all rather than putting one in the wrong place.
  return {
    statement: rest,
    negatedStatement: `${rest} does not happen`,
    willHappen: rest,
    willNotHappen: `NOT: ${rest}`,
  };
}

/** Whole-number threshold a total must clear, e.g. 41.5 -> "42 or more". */
function overThreshold(line: number): string {
  const next = Math.floor(line) + 1;
  return line % 1 === 0 ? `more than ${line}` : `${next} or more`;
}

function underThreshold(line: number): string {
  const below = Math.ceil(line) - 1;
  return line % 1 === 0 ? `fewer than ${line}` : `${below} or fewer`;
}

/** What a totals market is counting, inferred from the question. */
function totalsSubject(question: string, sportsMarketType: string | null | undefined): string {
  const q = question.toLowerCase();
  if (q.includes("touchdown")) return "touchdowns";
  if (q.includes("offensive yards")) return "offensive yards";
  if (q.includes("corner")) return "corners";
  if (q.includes("card")) return "cards";
  if (sportsMarketType?.includes("team_totals")) return "points";
  return "points";
}

/** Period qualifier, so a 1Q line is never read as a full-game line. */
function periodPrefix(sportsMarketType: string | null | undefined): string {
  if (!sportsMarketType) return "";
  if (sportsMarketType.startsWith("first_half")) return "in the first half, ";
  if (sportsMarketType.startsWith("second_half")) return "in the second half, ";
  const quarter = sportsMarketType.match(/^q(\d)_/);
  if (quarter) return `in Q${quarter[1]}, `;
  return "";
}

export function describeBet(input: BetInstructionInput): BetInstruction {
  const label = input.outcomeLabel.trim() || "this outcome";
  const type = input.sportsMarketType ?? null;
  const other = opposingLabel(input);
  const period = periodPrefix(type);

  // --- Totals: "Bills vs. Texans: O/U 41.5" with Over / Under -----------------
  if (isOverUnder(label)) {
    const line = extractLine(input.question);
    const subject = totalsSubject(input.question, type);
    const isOver = label.toLowerCase() === "over";

    if (line !== null) {
      return {
        action: `Bet ${label.toUpperCase()} ${line} ${subject}`,
        winsIf: capitalise(
          `${period}the total is ${isOver ? overThreshold(line) : underThreshold(line)} ${subject}.`,
        ),
        losesIf: capitalise(
          `${period}the total is ${isOver ? underThreshold(line) : overThreshold(line)} ${subject}${line % 1 === 0 ? ", or exactly the line, which pushes" : ""}.`,
        ),
        clickLabel: label,
        recognised: true,
      };
    }
    return {
      action: `Bet ${label.toUpperCase()}`,
      winsIf: `The total finishes on the ${label.toLowerCase()} side of the line in "${input.question}".`,
      losesIf: `It finishes on the other side.`,
      clickLabel: label,
      // The line could not be read, so the reader has to check it on Polymarket.
      recognised: false,
    };
  }

  // --- Spread: "Spread: Bills (-1.5)" with a team name ------------------------
  if (type?.includes("spread")) {
    const line = extractLine(input.question);
    const quotedTeam = extractSpreadTeam(input.question);

    if (line !== null && quotedTeam !== null) {
      // The line belongs to the quoted team; the other side gets its mirror image.
      const isQuoted = label.toLowerCase() === quotedTeam.toLowerCase();
      const yourLine = isQuoted ? line : -line;
      const signed = yourLine > 0 ? `+${yourLine}` : `${yourLine}`;
      const margin = Math.abs(yourLine);

      return {
        action: `Bet ${label} ${signed}`,
        winsIf:
          yourLine < 0
            ? `${capitalise(period)}${label} win by more than ${margin}.`
            : `${capitalise(period)}${label} win outright, or lose by less than ${margin}.`,
        losesIf:
          yourLine < 0
            ? `${label} win by less than ${margin}, draw, or lose.`
            : `${label} lose by more than ${margin}.`,
        clickLabel: label,
        recognised: true,
      };
    }
  }

  // --- Yes / No -------------------------------------------------------------
  if (isYesNo(label)) {
    const proposition = propositionFromQuestion(input.question);
    const yes = label.toLowerCase() === "yes";

    if (proposition) {
      const happens = `${capitalise(proposition.statement)}.`;
      const doesNot = `${capitalise(proposition.negatedStatement)}.`;
      return {
        action: yes
          ? `Bet YES — ${proposition.willHappen}`
          : `Bet NO — ${proposition.willNotHappen}`,
        winsIf: yes ? happens : doesNot,
        losesIf: yes ? doesNot : happens,
        clickLabel: label,
        recognised: true,
      };
    }

    return {
      action: yes ? "Bet YES" : "Bet NO",
      winsIf: yes
        ? `"${input.question}" resolves YES.`
        : `"${input.question}" resolves NO.`,
      losesIf: yes ? "It resolves NO." : "It resolves YES.",
      clickLabel: label,
      recognised: false,
    };
  }

  // --- Moneyline and anything else named after a competitor -------------------
  if (type?.includes("moneyline")) {
    return {
      action: `Bet ${label} to win`,
      winsIf: other
        ? `${capitalise(period)}${label} beat ${other}.`
        : `${capitalise(period)}${label} win.`,
      losesIf: other
        ? `${other} win${period ? " that period" : ""}, or it ends level.`
        : `${label} do not win.`,
      clickLabel: label,
      recognised: true,
    };
  }

  // --- Fallback. Names the side without pretending to know what it means. -----
  return {
    action: `Bet ${label}`,
    winsIf: `"${input.question}" settles in favour of ${label}.`,
    losesIf: other
      ? `It settles in favour of ${other}.`
      : `It settles against ${label}.`,
    clickLabel: label,
    recognised: false,
  };
}

function capitalise(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// What a stake actually returns
// ---------------------------------------------------------------------------

export interface StakeOutcome {
  stake: number;
  /** Price actually paid per share, including spread and slippage. */
  price: number;
  shares: number;
  /** Total returned if it wins, stake included. */
  returned: number;
  /** Profit only. */
  profit: number;
  /** Always the whole stake. */
  lost: number;
}

/**
 * What a given stake buys AT THE PRICE YOU WOULD PAY.
 *
 * Distinct from `calculatePayout` in `scoring/payout.ts`, which takes the market price. Over a
 * few days the difference between the mid and the ask is often the entire edge, so a board built
 * around short holds has to quote the figure a buyer would actually get.
 *
 * Returns null rather than a misleading number when the price is not a tradeable one.
 */
export function stakeOutcome(stake: number, effectivePrice: number | null): StakeOutcome | null {
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (effectivePrice === null || !Number.isFinite(effectivePrice)) return null;
  if (effectivePrice <= 0 || effectivePrice >= 1) return null;

  const shares = stake / effectivePrice;
  const returned = shares; // each share settles at exactly $1
  if (!Number.isFinite(shares) || !Number.isFinite(returned)) return null;

  return {
    stake,
    price: effectivePrice,
    shares,
    returned,
    profit: returned - stake,
    lost: stake,
  };
}
