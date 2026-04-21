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
 * Lowercase, trim surrounding whitespace, and strip a single layer of
 * angle brackets. Used for smtp.mailfrom values (sometimes `<a@b>`) and
 * the configured TRUSTED_FORWARDER value.
 */
function normalizeAddress(value: string): string {
  return value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const authResults = message.headers.get('Authentication-Results');
    if (!verifyForwarder(authResults, env.TRUSTED_FORWARDER)) {
      // Redact both envelope parties. In the Gmail-forwarded flow,
      // message.from IS the trusted forwarder's Gmail address — logging
      // it on a transient SPF failure would leak the forwarder identity
      // into Worker logs, contrary to the project's privacy stance.
      // message.to is similarly a private inbound routing address.
      console.log('skip: forwarder verification failed (envelope rejected)');
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
      // Subject and parsed from are safe to log here: we've already
      // confirmed the message was forwarded by the trusted party, so
      // parsed.from is the original streaming-service sender (e.g.
      // info@account.netflix.com), not the forwarder's Gmail address.
      console.log(
        `skip: no pattern matched for "${normalized.subject}" from ${normalized.from}`,
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
