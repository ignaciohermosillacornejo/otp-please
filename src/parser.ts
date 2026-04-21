// Parser module: inspects a ParsedEmail (subject/from/body) and decides
// which streaming service sent it and whether it contains an OTP code or a
// household-verification link.
//
// Pattern ordering note: `netflix-household` is deliberately listed BEFORE
// `netflix` so that a household/travel email matches the household pattern
// first. The plain `netflix` pattern still uses a `subjectBlocklist` as a
// belt-and-suspenders guard, but ordering makes the intent explicit and
// robust to future subject-line changes.

export type ServiceKey = 'netflix' | 'netflix-household' | 'disney' | 'max' | 'amazon';

export interface Pattern {
  service: ServiceKey;
  senderMatch: RegExp;
  // Exactly one of codeRegex or linkRegex must be set on any given pattern.
  codeRegex?: RegExp;
  linkRegex?: RegExp;
  // Skip this pattern if the subject matches.
  subjectBlocklist?: RegExp;
  // Skip this pattern if the body does NOT match.
  bodyRequire?: RegExp;
  validForMinutes: number;
}

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  html: string;
}

export type MatchResult =
  | { service: ServiceKey; type: 'code'; value: string; validForMinutes: number }
  | { service: ServiceKey; type: 'household'; value: string; validForMinutes: number };

export const PATTERNS: readonly Pattern[] = [
  {
    service: 'netflix-household',
    senderMatch: /@account\.netflix\.com$|@mailer\.netflix\.com$/i,
    linkRegex:
      /https:\/\/(?:www\.)?netflix\.com\/account\/(?:travel|update-primary-location)\/[A-Za-z0-9_\-=?&%./]+/,
    validForMinutes: 15,
  },
  {
    service: 'netflix',
    senderMatch: /@account\.netflix\.com$|@mailer\.netflix\.com$/i,
    codeRegex: /\b(\d{4})\b/,
    subjectBlocklist: /household|update.*household|primary.*location/i,
    validForMinutes: 15,
  },
  {
    service: 'disney',
    senderMatch: /@disneyplus\.com$|@mail\.disneyplus\.com$/i,
    codeRegex: /\b(\d{6})\b/,
    validForMinutes: 15,
  },
  {
    service: 'max',
    senderMatch: /@(hbomax|max)\.com$|@service\.hbomax\.com$/i,
    codeRegex: /\b(\d{6})\b/,
    validForMinutes: 15,
  },
  {
    service: 'amazon',
    senderMatch: /@amazon\.com$/i,
    codeRegex: /\b(\d{6})\b/,
    bodyRequire: /prime video/i,
    validForMinutes: 15,
  },
];

/**
 * Extract the bare email address from a `from` field.
 *
 * Handles both `"Netflix <info@account.netflix.com>"` and bare
 * `info@account.netflix.com` forms. Returns the address lowercased.
 */
function normalizeFrom(from: string): string {
  const angleMatch = from.match(/<([^>]+)>/);
  const addr = angleMatch ? angleMatch[1] : from;
  return addr.trim().toLowerCase();
}

/**
 * Select the body content to scan. Prefer plain text when present; fall
 * back to HTML otherwise. We intentionally do NOT concatenate the two to
 * avoid duplicate-match noise.
 */
function selectBody(parsed: ParsedEmail): string {
  if (parsed.text && parsed.text.length > 0) return parsed.text;
  return parsed.html ?? '';
}

/**
 * Main dispatcher. Iterates PATTERNS in order and returns the first pattern
 * that both addresses-matches and successfully extracts a code or link. If a
 * pattern matches by sender but fails to extract, iteration continues — the
 * next pattern may cover the same sender (e.g. netflix vs netflix-household).
 */
export function matchEmail(parsed: ParsedEmail): MatchResult | null {
  const from = normalizeFrom(parsed.from);
  const subject = parsed.subject ?? '';
  const body = selectBody(parsed);

  for (const pattern of PATTERNS) {
    if (!pattern.senderMatch.test(from)) continue;
    if (pattern.subjectBlocklist && pattern.subjectBlocklist.test(subject)) continue;
    if (pattern.bodyRequire && !pattern.bodyRequire.test(body)) continue;

    if (pattern.codeRegex) {
      const match = body.match(pattern.codeRegex);
      if (match) {
        const value = match[1] ?? match[0];
        return {
          service: pattern.service,
          type: 'code',
          value,
          validForMinutes: pattern.validForMinutes,
        };
      }
      continue;
    }

    if (pattern.linkRegex) {
      const match = body.match(pattern.linkRegex);
      if (match) {
        const value = match[1] ?? match[0];
        return {
          service: pattern.service,
          type: 'household',
          value,
          validForMinutes: pattern.validForMinutes,
        };
      }
      continue;
    }
  }

  return null;
}
