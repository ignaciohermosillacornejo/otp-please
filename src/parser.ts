// Parser module: inspects a ParsedEmail (subject/from/body) and decides
// which streaming service sent it and whether it contains an OTP code or a
// household-verification link.
//
// Pattern ordering note: `netflix-household` is deliberately listed BEFORE
// `netflix` so that a household/travel email matches the household pattern
// first. The plain `netflix` pattern still uses a `subjectBlocklist` as a
// belt-and-suspenders guard, but ordering makes the intent explicit and
// robust to future subject-line changes.

// Single source of truth for the full set of service keys. `ServiceKey`
// is DERIVED from this tuple, so adding a new service to the union
// without also adding it to SERVICE_KEYS is impossible — kv.ts and the
// dashboard iterate SERVICE_KEYS to cover every ServiceKey, and a
// drift here would silently omit the new service.
export const SERVICE_KEYS = ['netflix', 'netflix-household', 'disney', 'max', 'amazon'] as const;

export type ServiceKey = (typeof SERVICE_KEYS)[number];

interface PatternCommon {
  service: ServiceKey;
  senderMatch: RegExp;
  // Skip this pattern if the subject matches.
  subjectBlocklist?: RegExp;
  // Skip this pattern if the body does NOT match.
  bodyRequire?: RegExp;
  validForMinutes: number;
}

export type CodePattern = PatternCommon & { codeRegex: RegExp; linkRegex?: never };
export type LinkPattern = PatternCommon & { linkRegex: RegExp; codeRegex?: never };

// Discriminated so TypeScript enforces the "exactly one of codeRegex /
// linkRegex" invariant at the type level — illegal combinations won't
// compile, and matchEmail's branches are exhaustive.
export type Pattern = CodePattern | LinkPattern;

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  html: string;
}

export type MatchResult =
  | { service: ServiceKey; type: 'code'; value: string; validForMinutes: number }
  | { service: ServiceKey; type: 'household'; value: string; validForMinutes: number };

// Shared fragment used to find a verification code inside the body. The
// code must be preceded by a recognized contextual word (English or
// Spanish, since this user's family emails mix languages) so that
// incidental 4- or 6-digit sequences like copyright years, postal codes,
// or order numbers don't false-match. `[^\d]{0,40}` allows up to 40 non-
// digit chars between the keyword and the digits to accommodate typical
// email phrasing ("Your sign-in code is 1234", "código de verificación: 1234").
const CODE_CONTEXT = /(?:code|passcode|pin|verification|c[óo]digo|clave|verificaci[óo]n)[^\d]{0,40}/i;

function codeOf(digits: 4 | 6): RegExp {
  return new RegExp(`${CODE_CONTEXT.source}(\\d{${digits}})\\b`, 'i');
}

export const PATTERNS: readonly Pattern[] = [
  {
    service: 'netflix-household',
    senderMatch: /@account\.netflix\.com$|@mailer\.netflix\.com$/i,
    // No capture group on purpose — household extraction returns the full
    // URL, which matchEmail reads via `match[0]`. The terminator class
    // is negative (exclude whitespace + HTML delimiters) so the regex
    // admits any RFC 3986 character Netflix might include in a token
    // (~, +, !, etc.) without truncating. Real-world terminators in
    // email bodies are whitespace, quotes, or angle brackets.
    linkRegex:
      /https:\/\/(?:www\.)?netflix\.com\/account\/(?:travel|update-primary-location)\/[^\s"'<>]+/,
    validForMinutes: 15,
  },
  {
    service: 'netflix',
    senderMatch: /@account\.netflix\.com$|@mailer\.netflix\.com$/i,
    codeRegex: codeOf(4),
    subjectBlocklist: /household|update.*household|primary.*location/i,
    validForMinutes: 15,
  },
  {
    service: 'disney',
    senderMatch: /@disneyplus\.com$|@mail\.disneyplus\.com$/i,
    codeRegex: codeOf(6),
    validForMinutes: 15,
  },
  {
    service: 'max',
    // `@service.hbomax.com` is a legacy sender from before the HBO Max →
    // Max rebrand; keeping it broadens backward-compat with any still-
    // live transactional mail flows until we have real post-rebrand samples.
    senderMatch: /@(hbomax|max)\.com$|@service\.hbomax\.com$/i,
    codeRegex: codeOf(6),
    validForMinutes: 15,
  },
  {
    service: 'amazon',
    senderMatch: /@amazon\.com$/i,
    codeRegex: codeOf(6),
    bodyRequire: /prime video/i,
    validForMinutes: 15,
  },
];

/**
 * Extract the bare email address from a `from` field.
 *
 * Handles both `"Netflix <info@account.netflix.com>"` and bare
 * `info@account.netflix.com` forms, and lowercases the result.
 *
 * Display-name spoofing guard: if the display name (text before the `<`)
 * itself contains `@`, the value is ambiguous — something like
 * `"evil@attacker.com <legit@account.netflix.com>"` — and we reject it by
 * returning the empty string. `senderMatch` against an empty string
 * never matches, so ambiguous From headers drop.
 *
 * Assumption: the caller hands us a `from` that has already been MIME-
 * decoded (RFC 2047 encoded-words like `=?UTF-8?Q?...?=` resolved). The
 * email() handler uses `postal-mime`'s `parsed.from.address`, which is
 * decoded. A caller that fed us a raw RFC 2047 header could bypass the
 * `@`-in-display-name check by encoding the `@` as `=40` — don't.
 */
function normalizeFrom(from: string): string {
  const angleIdx = from.indexOf('<');
  if (angleIdx !== -1) {
    const angleMatch = from.match(/<([^>]+)>/);
    if (!angleMatch) return '';
    const displayName = from.slice(0, angleIdx).trim().replace(/^"|"$/g, '');
    if (displayName.includes('@')) return '';
    return angleMatch[1].trim().toLowerCase();
  }
  return from.trim().toLowerCase();
}

/**
 * Select the body content to scan. Prefer plain text when non-empty (after
 * trimming), else fall back to HTML. Some MIME senders include a stub text
 * part containing only whitespace alongside the real HTML — treat those as
 * empty so the HTML body is scanned instead.
 */
function selectBody(parsed: ParsedEmail): string {
  if (parsed.text && parsed.text.trim().length > 0) return parsed.text;
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
    }
  }

  return null;
}
