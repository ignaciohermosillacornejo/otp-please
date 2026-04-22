import PostalMime from 'postal-mime';

import type { Env } from './config';
import { renderDashboard } from './dashboard';
import { filterStaleEntries, readAllEntries, storeMatch } from './kv';
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
// wants a small embedded icon. `connect-src` permits the Cloudflare
// Insights telemetry beacon; all other outbound fetches are blocked.
const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self' https://cdn.tailwindcss.com https://static.cloudflareinsights.com 'unsafe-inline'; " +
  "style-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self' https://cloudflareinsights.com;";

/**
 * Returns true iff the envelope-from address matches the configured
 * trusted forwarder after normalization (case-insensitive, Gmail dots
 * ignored in the local-part).
 *
 * Threat model: the Worker is exposed at a public Email Routing address,
 * so any sender can reach us. Trust derives from Cloudflare's receiving
 * MTA, which has already performed SPF/DKIM/DMARC/ARC checks at ingest
 * (visible in the Email Routing Activity tab as
 * `spf=pass dkim=pass arc=pass Spam=Safe`). Cloudflare would not have
 * delivered the message to this Worker if SPF against the envelope-from
 * had failed, so a `message.from` we see here is an envelope address
 * Cloudflare has already authenticated.
 *
 * An earlier iteration of this function parsed an
 * `Authentication-Results` header out of the inbound message. That
 * approach was wrong: Cloudflare Email Routing does NOT surface a
 * fresh Authentication-Results header to Workers. Only the sender's
 * own `ARC-Authentication-Results` (if any) and Cloudflare's envelope
 * fields pass through. Real inbound mail was being silently dropped
 * because the Worker-level header parse always failed. See the
 * "aggressive skip-path logging" diag work on `main` for the evidence.
 *
 * If Cloudflare ever starts surfacing its own Authentication-Results
 * header, we could *additionally* verify it — but the envelope match
 * alone is the load-bearing check, because CF wouldn't have delivered
 * otherwise.
 */
export function verifyForwarder(
  envelopeFrom: string | null,
  trustedForwarder: string,
): boolean {
  if (!envelopeFrom) return false;

  const normalizedTrusted = normalizeAddress(trustedForwarder);
  if (!normalizedTrusted) return false;

  const normalizedFrom = normalizeAddress(envelopeFrom);
  if (!normalizedFrom) return false;

  return normalizedFrom === normalizedTrusted;
}

/**
 * Lowercase, trim surrounding whitespace, strip a single layer of
 * angle brackets, and — for gmail.com / googlemail.com addresses —
 * remove dots from the local-part. Used for envelope-from values
 * (sometimes `<a@b>`) and the configured TRUSTED_FORWARDER value.
 *
 * Gmail dot normalization: Google treats `foo.bar@gmail.com` and
 * `foobar@gmail.com` as the same mailbox. The owner's envelope-from
 * alternates between canonical forms (e.g. with vs. without dots), so
 * stripping dots on both sides before comparison makes the check
 * correct for any variant of a Gmail address.
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
    if (!verifyForwarder(message.from, env.TRUSTED_FORWARDER)) {
      // Verbose by design. This is a low-traffic personal Worker on the
      // owner's CF account, logs are private, and we've been burned by
      // under-logged skip paths. Dump the raw + normalized envelope-
      // from, the raw + normalized configured forwarder, and the
      // inbound header names (for future diagnostics of any other
      // drift).
      //
      // Do NOT log extracted OTP values or household URL tokens from
      // here or anywhere else — those are the user-facing secrets the
      // Worker is built to relay and the one thing we always redact.
      const names: string[] = [];
      for (const name of message.headers.keys()) names.push(name);
      console.log(
        `skip: forwarder verification failed` +
          ` envelope-from=${JSON.stringify(message.from)}` +
          ` envelope-to=${JSON.stringify(message.to)}` +
          ` configured-forwarder=${JSON.stringify(env.TRUSTED_FORWARDER)}` +
          ` normalized-from=${JSON.stringify(normalizeAddress(message.from))}` +
          ` normalized-configured=${JSON.stringify(normalizeAddress(env.TRUSTED_FORWARDER))}` +
          ` matched=false` +
          ` header-names=[${names.join(',')}]`,
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
      // Full sender + subject + first 400 chars of body so template
      // drift (service adds a new subdomain, changes the code prefix,
      // etc.) is immediately diagnosable. Short text bodies fit; HTML
      // bodies get truncated which is fine for triage.
      const body = (normalized.text || normalized.html).slice(0, 400);
      console.log(
        `skip: no pattern matched` +
          ` from=${normalized.from} subject=${JSON.stringify(normalized.subject)}` +
          ` body=${JSON.stringify(body)}`,
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

    // Both /api and / apply the same grace-window filter so the JSON
    // and the HTML always agree on which entries exist. Any entry whose
    // valid_until is more than an hour in the past is nulled out — the
    // dashboard should not surface "expired 600m ago" from a KV row
    // that outlived its TTL briefly.
    const now = new Date();

    // /api — machine-readable JSON snapshot of every service entry.
    // Same Record<ServiceKey, StoredEntry|null> shape the HTML
    // renderer consumes. Downstream scripts can mirror the dashboard's
    // state without parsing HTML.
    if (url.pathname === '/api') {
      const entries = filterStaleEntries(await readAllEntries(env), now);
      return Response.json(entries, {
        headers: { 'cache-control': 'no-store' },
      });
    }

    // Everything else → dashboard. Unknown paths intentionally fall
    // through rather than 404ing, so bookmarks to old URLs and
    // casual typos still land on something useful.
    const entries = filterStaleEntries(await readAllEntries(env), now);
    const html = renderDashboard({
      entries,
      title: env.DASHBOARD_TITLE,
      footerText: env.FOOTER_TEXT,
      now,
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
