import type { Env } from './config';

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

  // Split on both `;` (intra-header segmentation) and `,` (multiple
  // headers merged by Headers.get). Each resulting segment is checked
  // independently for an spf=pass + matching smtp.mailfrom pair.
  const segments = authResultsHeader.split(/[;,]/);
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
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // TODO(index): parse incoming email, extract OTP, write to KV.
    return;
  },
  async fetch(
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    // TODO(index): serve the Access-gated dashboard.
    return new Response('Not Implemented', { status: 501 });
  },
} satisfies ExportedHandler<Env>;
