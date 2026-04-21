import type { Env } from './config';
import type { MatchResult, ServiceKey } from './parser';
import { SERVICE_KEYS } from './parser';

// What's written to KV. Discriminated on `type`. The household variant
// uses `url` (not `value`) per the original build spec — downstream
// dashboard code treats households as links, codes as strings, so the
// field name carries the distinction.
export type StoredEntry =
  | {
      type: 'code';
      service: ServiceKey;
      value: string;
      received_at: string; // ISO 8601 UTC
      valid_until: string; // ISO 8601 UTC, received_at + validForMinutes
      subject: string;
    }
  | {
      type: 'household';
      service: ServiceKey;
      url: string;
      received_at: string;
      valid_until: string;
      subject: string;
    };

// KV key namespace. One entry per service key — each new match
// overwrites the prior entry for that service. Prefix keeps the space
// clear if we later add other kinds of data to the same namespace.
export const KV_KEY_PREFIX = 'entry:';

// One hour grace period after `valid_until`. The dashboard wants to
// render "expired Nm ago" for a while before the row silently vanishes,
// so KV's expirationTtl is pushed out past the semantic expiry.
export const ONE_HOUR_SECONDS = 3600;

const SECONDS_PER_MINUTE = 60;

/**
 * Build the KV key for a given service. One entry per service — new
 * matches overwrite older ones.
 */
export function kvKeyFor(service: ServiceKey): string {
  return `${KV_KEY_PREFIX}${service}`;
}

/**
 * Persist a parser MatchResult to KV.
 *
 * `now` is injected (not derived from `new Date()` inside) so tests can
 * pin the clock and assert exact `received_at` / `valid_until` values.
 *
 * The stored entry's TTL is `validForMinutes*60 + ONE_HOUR_SECONDS`.
 * The extra hour is a render grace period — see ONE_HOUR_SECONDS above.
 *
 * Errors from KV are intentionally not caught here. The caller (email
 * handler) will log and decide; swallowing them would mask real bugs.
 */
export async function storeMatch(
  env: Env,
  match: MatchResult,
  subject: string,
  now: Date,
): Promise<void> {
  const receivedAt = now.toISOString();
  const validUntilMs = now.getTime() + match.validForMinutes * SECONDS_PER_MINUTE * 1000;
  const validUntil = new Date(validUntilMs).toISOString();
  const expirationTtl = match.validForMinutes * SECONDS_PER_MINUTE + ONE_HOUR_SECONDS;

  const entry: StoredEntry =
    match.type === 'code'
      ? {
          type: 'code',
          service: match.service,
          value: match.value,
          received_at: receivedAt,
          valid_until: validUntil,
          subject,
        }
      : {
          type: 'household',
          service: match.service,
          url: match.value,
          received_at: receivedAt,
          valid_until: validUntil,
          subject,
        };

  await env.OTP_STORE.put(kvKeyFor(match.service), JSON.stringify(entry), {
    expirationTtl,
  });
}

/**
 * Read the current entry for one service, or null if nothing is stored
 * (or the stored entry has expired).
 *
 * Using `get(key, 'json')` lets the Workers runtime do the JSON.parse
 * and return a typed object directly. We cast through the JSON type:
 * KVNamespace's typings don't know our schema.
 */
export async function readEntry(
  env: Env,
  service: ServiceKey,
): Promise<StoredEntry | null> {
  const value = await env.OTP_STORE.get<StoredEntry>(kvKeyFor(service), 'json');
  return value ?? null;
}

/**
 * Read every known service's entry in parallel. Returns a Record with
 * one slot per ServiceKey — absent services map to null. The dashboard
 * iterates this in a fixed order so the layout is stable.
 */
export async function readAllEntries(
  env: Env,
): Promise<Record<ServiceKey, StoredEntry | null>> {
  const entries = await Promise.all(
    SERVICE_KEYS.map(async (service) => [service, await readEntry(env, service)] as const),
  );
  return Object.fromEntries(entries) as Record<ServiceKey, StoredEntry | null>;
}
