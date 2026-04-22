import PostalMime from 'postal-mime';

import type { Env } from './config';
import { renderDashboard } from './dashboard';
import { readAllEntries, storeMatch } from './kv';
import { matchEmail, type ParsedEmail } from './parser';

// Conservative Content-Security-Policy for the HTML response.
//
// `'unsafe-inline'` on script-src is unavoidable while we ship the
// Tailwind CDN runtime — Tailwind injects inline style/script tags at
// load. Our own client code is also inline. Dropping `'unsafe-inline'`
// would require nonce-tagging both ours and Tailwind's, which the CDN
// doesn't support. Tradeoff accepted: the attack surface is limited to
// the dashboard being single-tenant and Access-gated.
//
// `img-src 'self' data:` allows inline data URLs if a future card ever
// wants a small embedded icon; `connect-src 'self'` blocks outbound
// fetches to third parties.
const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; " +
  "style-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self';";

/**
 * Returns true iff an Authentication-Results header proves the mail
 * transited the configured trusted forwarder (i.e., an spf=pass with
 * smtp.mailfrom matching env.TRUSTED_FORWARDER, case-insensitive).
 *
 * Threat model: the Worker is exposed at a public Email Routing address,
 * so any sender can reach us. We trust a message ONLY if the receiving
 * MTA (Cloudflare) attests that SPF passed for an envelope-sender
 * (smtp.mailfrom) we own — i.e., the owner's Gmail forwarding path.
 * `smtp.helo` is intentionally NOT accepted on its own: helo is a
 * self-declared hostname and not authenticated by SPF the same way
 * mailfrom is, so a matching helo without a matching mailfrom could be
 * spoofed by any host that claims the hostname.
 *
 * Underlying assumption (RFC 8601 §5): the Authentication-Results
 * header we read was produced by Cloudflare's receiving MTA, not
 * carried over from the sender. Per RFC 8601 §5.3, a receiver
 * "SHOULD" strip untrusted Authentication-Results headers before
 * adding its own, and Cloudflare Email Routing does so in practice —
 * otherwise an attacker could simply prepend a forged
 * `Authentication-Results: ...; spf=pass smtp.mailfrom=<owner>` line
 * to their message and bypass this check trivially. If that invariant
 * ever changes, this function is not safe and must be rewritten to
 * select the correct (MTA-authored) stanza.
 *
 * The header is semi-structured (RFC 8601 / 5451): one or more stanzas
 * joined by `;`, each with `method=result` tokens and ptype.property
 * key/values. Multiple Authentication-Results headers may be merged by
 * `Headers.get` into one comma-separated value; we accept either shape.
 */
export function verifyForwarder(
  authResultsHeader: string | null,
  trustedForwarder: string,
): boolean {
  if (!authResultsHeader) return false;

  const normalizedTrusted = normalizeAddress(trustedForwarder);
  if (!normalizedTrusted) return false;

  // Strip RFC 8601 parenthetical comments before splitting. SPF-result
  // parentheticals commonly contain commas
  // (e.g. "spf=pass (google.com: domain of X designates Y as permitted
  // sender, allow) smtp.mailfrom=..."), and splitting on `,` inside a
  // comment would fragment a single stanza so neither fragment carries
  // both spf=pass and smtp.mailfrom — dropping legitimate mail.
  // Comments are documentation, not semantic, so removing them is safe.
  const withoutComments = authResultsHeader.replace(/\([^)]*\)/g, '');

  // Split on both `;` (intra-header segmentation) and `,` (multiple
  // headers merged by Headers.get). Each resulting segment is checked
  // independently for an spf=pass + matching smtp.mailfrom pair.
  const segments = withoutComments.split(/[;,]/);
  for (const segment of segments) {
    const spfMatch = segment.match(/\bspf=(\w+)/i);
    if (!spfMatch) continue;
    if (spfMatch[1].toLowerCase() !== 'pass') continue;

    const mailfromMatch = segment.match(/\bsmtp\.mailfrom=([^\s;()]+)/i);
    if (!mailfromMatch) continue;

    if (normalizeAddress(mailfromMatch[1]) === normalizedTrusted) return true;
  }

  return false;
}

/**
 * Lowercase, trim surrounding whitespace, strip a single layer of
 * angle brackets, and — for gmail.com / googlemail.com addresses —
 * remove dots from the local-part. Used for smtp.mailfrom values
 * (sometimes `<a@b>`) and the configured TRUSTED_FORWARDER value.
 *
 * Gmail dot normalization: Google treats `foo.bar@gmail.com` and
 * `foobar@gmail.com` as the same mailbox. Outbound SPF stamps the
 * envelope with whichever canonical form the account uses, which may
 * differ from the form the deployer configured in TRUSTED_FORWARDER.
 * Stripping dots on both sides makes the comparison correct for any
 * variant of a Gmail address.
 */
function normalizeAddress(value: string): string {
  const bare = value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  const atIdx = bare.lastIndexOf('@');
  if (atIdx === -1) return bare;
  const local = bare.slice(0, atIdx);
  const domain = bare.slice(atIdx + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@${domain}`;
  }
  return bare;
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const authResults = message.headers.get('Authentication-Results');
    if (!verifyForwarder(authResults, env.TRUSTED_FORWARDER)) {
      // Log a redacted breakdown of what the envelope produced vs what
      // we were configured to trust. No full addresses / local-parts —
      // only SPF result, mailfrom domain, and configured domain. This
      // is enough to diagnose the two common failure modes (Gmail
      // stamping a different domain like googlemail.com / SRS rewrite,
      // or an empty TRUSTED_FORWARDER secret) without leaking either
      // party's identity into Worker logs.
      const stripped = (authResults ?? '').replace(/\([^)]*\)/g, '');
      const spfResult = stripped.match(/\bspf=(\w+)/i)?.[1] ?? 'absent';
      const mailfromMatch = stripped.match(/\bsmtp\.mailfrom=([^\s;()]+)/i);
      const gotDomain = mailfromMatch
        ? (normalizeAddress(mailfromMatch[1]).split('@')[1] ?? 'malformed')
        : 'absent';
      const configuredDomain =
        normalizeAddress(env.TRUSTED_FORWARDER).split('@')[1] ?? 'malformed';
      console.log(
        `skip: forwarder verification failed (envelope rejected) spf=${spfResult} mailfrom-domain=${gotDomain} configured-domain=${configuredDomain}`,
      );
      return;
    }

    // message.raw is a ReadableStream<Uint8Array>; Response.text() is the
    // simplest way to turn it into a decoded string for postal-mime.
    const raw = await new Response(message.raw).text();
    const parsed = await PostalMime.parse(raw);

    const normalized: ParsedEmail = {
      from: parsed.from?.address ?? '',
      subject: parsed.subject ?? '',
      text: parsed.text ?? '',
      html: parsed.html ?? '',
    };

    const match = matchEmail(normalized);
    if (!match) {
      // Log only the sender DOMAIN, not the full address. With
      // manual-forward support, the outer `from` on a no-match can
      // be a family member's personal Gmail (`foo@gmail.com`) —
      // logging that verbatim would leak PII into Worker logs and
      // now that observability is enabled, those logs persist. The
      // domain alone is enough to debug template/regex drift
      // ("unknown sender from gmail.com" = manual forward, from
      // account.netflix.com = something changed upstream).
      const atIdx = normalized.from.lastIndexOf('@');
      const domain = atIdx === -1 ? 'unknown' : normalized.from.slice(atIdx + 1);
      console.log(
        `skip: no pattern matched for "${normalized.subject}" from @${domain}`,
      );
      return;
    }

    try {
      await storeMatch(env, match, normalized.subject, new Date());
    } catch (err) {
      // kv.ts intentionally doesn't catch — we do, here, so a transient
      // KV failure produces a structured log line rather than an
      // unhandled rejection. Don't rethrow: Cloudflare would retry the
      // email, potentially multiplying side effects if the put half-
      // succeeded. Intentionally omit match.value from the error string.
      console.log(
        `err: KV write failed for ${match.service}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Deliberately omit match.value — codes are short-lived user-visible
    // secrets that must not hit logs. Service + type + TTL is enough to
    // debug a pipeline issue.
    console.log(
      `info: stored ${match.type} for ${match.service} (valid ${match.validForMinutes}m)`,
    );
  },

  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    // Reject non-GET early with a conventional 405 + Allow header. The
    // dashboard is read-only; POST/PUT/etc. have no meaning and we'd
    // rather fail loudly than silently serve the HTML to, say, a
    // misconfigured health probe.
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET' },
      });
    }

    const url = new URL(request.url);

    // /healthz — unauthenticated liveness probe. Expected to be exempt
    // from Access at the app-config layer so uptime monitoring can
    // reach it without a cookie. Keep the body a literal "ok" and the
    // content-type plain text so curl-style probes work unchanged.
    if (url.pathname === '/healthz') {
      return new Response('ok', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    // /api — machine-readable JSON snapshot of every service entry.
    // Same Record<ServiceKey, StoredEntry|null> shape the HTML
    // renderer consumes. Intentionally identical to readAllEntries'
    // return value; downstream scripts can mirror the dashboard's
    // state without parsing HTML.
    if (url.pathname === '/api') {
      const entries = await readAllEntries(env);
      return Response.json(entries, {
        headers: { 'cache-control': 'no-store' },
      });
    }

    // Everything else → dashboard. Unknown paths intentionally fall
    // through rather than 404ing, so bookmarks to old URLs and
    // casual typos still land on something useful.
    const entries = await readAllEntries(env);
    const html = renderDashboard({
      entries,
      title: env.DASHBOARD_TITLE,
      footerText: env.FOOTER_TEXT,
      now: new Date(),
    });

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': CSP_HEADER,
      },
    });
  },
} satisfies ExportedHandler<Env>;
