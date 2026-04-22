// Parser module: inspects a ParsedEmail (subject/from/body) and decides
// which streaming service sent it and whether it contains an OTP code or a
// household-verification link.

// Single source of truth for the full set of service keys. `ServiceKey`
// is DERIVED from this tuple, so adding a new service to the union
// without also adding it to SERVICE_KEYS is impossible — kv.ts and the
// dashboard iterate SERVICE_KEYS to cover every ServiceKey, and a
// drift here would silently omit the new service.
export const SERVICE_KEYS = ['netflix-household', 'disney', 'max'] as const;

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
// code must be preceded somewhere before it by a recognized contextual
// word (English or Spanish — this user's family emails mix the two) so
// that incidental digit runs like copyright years or promotion numbers
// don't false-match.
//
// We use a LAZY `[\s\S]{0,500}?` between the context word and the code
// — not `[^\d]{0,N}` — because real HTML templates often contain
// intermediate digit fragments (e.g. "...expire en 15 minutos. <code>",
// "Order 123456 · código <real>"). A strict non-digit gap would fail
// on those. The `(?<![\d])` / `(?![\d])` boundaries around the capture
// group prevent grabbing a sub-sequence of a longer digit run (phone
// numbers, order ids, etc.).
const CODE_CONTEXT = /(?:code|passcode|pin|verification|c[óo]digo|clave|verificaci[óo]n)/i;

function codeOf(digits: 4 | 6): RegExp {
  return new RegExp(
    `${CODE_CONTEXT.source}[\\s\\S]{0,500}?(?<![\\d])(\\d{${digits}})(?![\\d])`,
    'i',
  );
}

export const PATTERNS: readonly Pattern[] = [
  {
    service: 'netflix-household',
    senderMatch: /@account\.netflix\.com$|@mailer\.netflix\.com$/i,
    // No capture group on purpose — household extraction returns the full
    // URL, which matchEmail reads via `match[0]`. The terminator class
    // is negative (exclude whitespace, HTML delimiters, and square
    // brackets). Square brackets are excluded because Netflix's plain-
    // text parts wrap URLs as `[https://...]`; without this, the regex
    // would capture the trailing `]`. Real Netflix tokens are URL-safe
    // base64 + query string, so nothing legitimate in the URL contains
    // `[`, `]`, `"`, `'`, `<`, `>`, or whitespace.
    linkRegex:
      /https:\/\/(?:www\.)?netflix\.com\/account\/(?:travel|update-primary-location)\/[^\s"'<>[\]]+/,
    validForMinutes: 15,
  },
  {
    service: 'disney',
    // Real transactional sender seen in the wild: disneyplus@trx.mail2.
    // disneyplus.com. The regex matches any disneyplus.com subdomain so
    // the parser doesn't need updating when Disney adds a new subdomain
    // or rotates bulk-mailer hosts.
    senderMatch: /@([\w-]+\.)*disneyplus\.com$/i,
    codeRegex: codeOf(6),
    validForMinutes: 15,
  },
  {
    service: 'max',
    // Real transactional senders: no-reply@alerts.hbomax.com and
    // hbomax@service.hbomax.com — both hbomax.com subdomains. Accept any
    // hbomax.com subdomain (it's a single-product transactional domain)
    // plus only the apex max.com (the post-rebrand sender). We do NOT
    // wildcard *.max.com because max.com is the primary brand surface
    // used for marketing / promos / billing too — widening there would
    // expand the false-positive footprint for no real gain. If a new
    // max.com subdomain ships an OTP in practice, add it explicitly.
    senderMatch: /@([\w-]+\.)*hbomax\.com$|@max\.com$/i,
    codeRegex: codeOf(6),
    // Max's real email body says "This code expires in 30 minutes".
    validForMinutes: 30,
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
 * Convert HTML to a flat, searchable text approximation. Strips every
 * tag, decodes the small handful of entities we see in real streaming
 * emails, and collapses whitespace so the code-context regex can see
 * the textual content contiguously (otherwise inline `<span>` and
 * `<td>` wrappers around the digits break the context match).
 *
 * Not a general-purpose HTML parser — the fixtures are real emails
 * from Netflix / Disney+ / Max templates and this handles them. If a
 * new service uses a template that encodes digits as entity refs or
 * inserts zero-width spaces between digits, this helper will need to
 * grow.
 */
function stripHtml(html: string): string {
  // Hoist anchor href targets into the flow so linkRegex scanning
  // can find URLs that only exist inside <a href="..."> attributes
  // (common in HTML-only Netflix household emails where the anchor
  // body is "Confirm" rather than the URL itself).
  const withHrefs = html.replace(/<a\s[^>]*?href=(?:"([^"]*)"|'([^']*)')/gi, ' $1$2 ');
  return withHrefs
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Select the body content to scan. Prefer plain text when non-empty
 * (after trimming). Some templates ship an HTML-only body — Disney+'s
 * sign-in code email, for one — so we fall back to an HTML-stripped
 * view of the HTML part. We intentionally do NOT scan raw HTML because
 * inline markup between the context word and the code (e.g.
 * `<span>código</span><td>111111</td>`) would push the digits outside
 * the `[\s\S]{0,500}?` window of the code regex.
 */
function selectBody(parsed: ParsedEmail): string {
  if (parsed.text && parsed.text.trim().length > 0) return parsed.text;
  const html = parsed.html ?? '';
  if (html.length === 0) return '';
  return stripHtml(html);
}

/**
 * Extract the sender address from a Gmail-style forwarded-message
 * block in the body. Gmail's "Forward" button produces a quoted
 * block like:
 *
 *   ---------- Forwarded message ---------
 *   From: Netflix <info@account.netflix.com>
 *   Date: ...
 *   Subject: ...
 *   To: <original recipient>
 *
 * When a family member clicks Forward and sends an OTP email to the
 * Worker, the outer RFC 822 `From:` becomes *their* Gmail (not the
 * streaming service). The original sender only survives inside the
 * quoted header block, which is what this helper pulls out so
 * matchEmail can still run the real sender through senderMatch.
 *
 * Trust model: by the time matchEmail runs, verifyForwarder has
 * already confirmed the envelope came from the configured
 * TRUSTED_FORWARDER (the deployer's Gmail). The body is therefore
 * authored by the trusted forwarder and it's safe to extract the
 * inner From. A non-trusted sender wouldn't pass the envelope check
 * in the first place.
 *
 * Localization: Gmail localizes the separator — English uses
 * "Forwarded message", Spanish uses "Mensaje reenviado". Both are
 * recognized. Returns null if no forwarded block is found.
 */
function extractForwardedFrom(body: string): string | null {
  const fwdMatch = body.match(/-+\s*(?:Forwarded message|Mensaje reenviado)\s*-+/i);
  if (!fwdMatch || fwdMatch.index === undefined) return null;
  // Look for "From:" (English Gmail) or "De:" (Spanish Gmail) within
  // 500 chars after the marker. Gmail localizes the header key per
  // the account's UI language, so supporting both keeps us aligned
  // with the localized "Forwarded message" / "Mensaje reenviado"
  // marker variants above.
  const tail = body.slice(fwdMatch.index, fwdMatch.index + 500);
  const fromMatch = tail.match(
    /^(?:From|De):\s*(?:[^<\n]*?<)?([^<>\s\n,]+@[^<>\s\n,]+)/im,
  );
  return fromMatch ? normalizeFrom(fromMatch[1]) : null;
}

/**
 * Main dispatcher. Iterates PATTERNS in order and returns the first pattern
 * that both addresses-matches and successfully extracts a code or link. If a
 * pattern matches by sender but fails to extract, iteration continues so the
 * caller can fall through to a later pattern covering the same sender.
 *
 * Manual-forward support: if the outer `from` doesn't match any
 * pattern, try again using the inner `From:` pulled from a Gmail-
 * style forwarded-message block in the body. This lets a family
 * member hit Gmail's Forward button on an OTP and still have the
 * Worker recognize it.
 */
export function matchEmail(parsed: ParsedEmail): MatchResult | null {
  const outerFrom = normalizeFrom(parsed.from);
  const subject = parsed.subject ?? '';
  const body = selectBody(parsed);

  const primary = tryMatch(outerFrom, subject, body);
  if (primary) return primary;

  const innerFrom = extractForwardedFrom(body);
  if (innerFrom && innerFrom !== outerFrom) {
    return tryMatch(innerFrom, subject, body);
  }
  return null;
}

function tryMatch(
  from: string,
  subject: string,
  body: string,
): MatchResult | null {
  for (const pattern of PATTERNS) {
    if (!pattern.senderMatch.test(from)) continue;
    if (pattern.subjectBlocklist && pattern.subjectBlocklist.test(subject)) continue;
    if (pattern.bodyRequire && !pattern.bodyRequire.test(body)) continue;

    if (pattern.codeRegex) {
      const match = body.match(pattern.codeRegex);
      if (match) {
        // codeOf() always emits exactly one capture group, so match[1]
        // is defined whenever the regex matched. linkRegex (below)
        // intentionally has no capture group and so needs match[0].
        return {
          service: pattern.service,
          type: 'code',
          value: match[1],
          validForMinutes: pattern.validForMinutes,
        };
      }
      continue;
    }

    if (pattern.linkRegex) {
      const match = body.match(pattern.linkRegex);
      if (match) {
        // linkRegex patterns have no capture group by design (see the
        // netflix-household comment in PATTERNS), so match[0] — the
        // full matched URL — is what we want. Symmetric with the
        // codeRegex branch above, just inverted: codeRegex always has
        // exactly one group, linkRegex always has none.
        return {
          service: pattern.service,
          type: 'household',
          value: match[0],
          validForMinutes: pattern.validForMinutes,
        };
      }
    }
  }

  return null;
}
