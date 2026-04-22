import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/config';
import {
  KV_KEY_PREFIX,
  ONE_HOUR_SECONDS,
  filterStaleEntries,
  isEntryFresh,
  kvKeyFor,
  readAllEntries,
  readEntry,
  storeMatch,
  type StoredEntry,
} from '../src/kv';
import { SERVICE_KEYS, type MatchResult, type ServiceKey } from '../src/parser';

/**
 * Minimal in-memory KV fake. Implements only the slice of KVNamespace
 * that src/kv.ts uses: `put(key, value, { expirationTtl })` and
 * `get(key, 'json')`.
 *
 * We honor `expirationTtl` so we can assert the TTL-expiry branch: a
 * stored entry whose expiry has passed (according to the fake's own
 * clock) returns null from get. The clock is settable — callers move
 * it forward with `advanceSecondsBy(n)` — and defaults to 0 so tests
 * can reason about absolute timings without wall-clock noise.
 */
class FakeKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  private nowSeconds = 0;
  // Records of every put call, for asserting TTL values.
  public readonly puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];

  setTime(seconds: number): void {
    this.nowSeconds = seconds;
  }

  advanceSecondsBy(seconds: number): void {
    this.nowSeconds += seconds;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const ttl = options?.expirationTtl;
    const expiresAt = typeof ttl === 'number' ? this.nowSeconds + ttl : null;
    this.store.set(key, { value, expiresAt });
    this.puts.push({ key, value, expirationTtl: ttl });
  }

  async get(key: string, type: 'json'): Promise<unknown>;
  async get(key: string): Promise<string | null>;
  async get(key: string, type?: 'json'): Promise<unknown> {
    const row = this.store.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && this.nowSeconds >= row.expiresAt) {
      // Match real KV semantics: reads past TTL return null. Also prune
      // the entry so a later inspection of the map is consistent.
      this.store.delete(key);
      return null;
    }
    if (type === 'json') return JSON.parse(row.value);
    return row.value;
  }
}

function makeEnv(): { env: Env; kv: FakeKV } {
  const kv = new FakeKV();
  // Cast: FakeKV implements only the methods kv.ts touches. The rest of
  // the KVNamespace surface is intentionally unimplemented.
  const env = {
    OTP_STORE: kv as unknown as Env['OTP_STORE'],
    TIMEZONE: 'America/Santiago',
    DASHBOARD_TITLE: 'Streaming Codes',
    FOOTER_TEXT: '',
    TRUSTED_FORWARDER: 'test@example.com',
  } satisfies Env;
  return { env, kv };
}

// A fixed reference instant so every test that pins the clock does so
// with the same baseline — makes expected ISO strings cross-checkable.
const FIXED_NOW = new Date('2026-04-20T12:00:00.000Z');

describe('kvKeyFor', () => {
  it('returns a stable prefixed key for each service', () => {
    expect(kvKeyFor('netflix-household')).toBe('entry:netflix-household');
    expect(kvKeyFor('disney')).toBe('entry:disney');
    expect(kvKeyFor('max')).toBe('entry:max');
  });

  it('uses the exported KV_KEY_PREFIX', () => {
    // Guards against someone changing the prefix on one side only.
    for (const service of SERVICE_KEYS) {
      expect(kvKeyFor(service).startsWith(KV_KEY_PREFIX)).toBe(true);
    }
  });
});

describe('storeMatch', () => {
  let env: Env;
  let kv: FakeKV;

  beforeEach(() => {
    ({ env, kv } = makeEnv());
  });

  it('writes a code entry with valid_until = received_at + validForMinutes and TTL = minutes*60 + 3600', async () => {
    const match: MatchResult = {
      service: 'disney',
      type: 'code',
      value: '424242',
      validForMinutes: 15,
    };
    await storeMatch(env, match, 'Your Disney+ sign-in code', FIXED_NOW);

    const stored = (await kv.get(kvKeyFor('disney'), 'json')) as StoredEntry;
    expect(stored).toEqual({
      type: 'code',
      service: 'disney',
      value: '424242',
      received_at: '2026-04-20T12:00:00.000Z',
      valid_until: '2026-04-20T12:15:00.000Z',
      subject: 'Your Disney+ sign-in code',
    });

    // Exactly one put, with the expected TTL.
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe('entry:disney');
    expect(kv.puts[0].expirationTtl).toBe(15 * 60 + ONE_HOUR_SECONDS);
  });

  it('writes a household entry with `url` (not `value`) and the same TTL arithmetic', async () => {
    const match: MatchResult = {
      service: 'netflix-household',
      type: 'household',
      value: 'https://www.netflix.com/account/update-primary-location/abc123',
      validForMinutes: 15,
    };
    await storeMatch(env, match, 'Update your Netflix Household', FIXED_NOW);

    const stored = (await kv.get(kvKeyFor('netflix-household'), 'json')) as StoredEntry;
    expect(stored).toEqual({
      type: 'household',
      service: 'netflix-household',
      url: 'https://www.netflix.com/account/update-primary-location/abc123',
      received_at: '2026-04-20T12:00:00.000Z',
      valid_until: '2026-04-20T12:15:00.000Z',
      subject: 'Update your Netflix Household',
    });
    // Household variant must NOT have a `value` field.
    expect(stored).not.toHaveProperty('value');

    expect(kv.puts[0].expirationTtl).toBe(15 * 60 + ONE_HOUR_SECONDS);
  });

  it('round-trips: storeMatch followed by readEntry returns a structurally equal entry', async () => {
    const match: MatchResult = {
      service: 'disney',
      type: 'code',
      value: '654321',
      validForMinutes: 15,
    };
    await storeMatch(env, match, 'Your Disney+ code', FIXED_NOW);

    const read = await readEntry(env, 'disney');
    expect(read).toEqual({
      type: 'code',
      service: 'disney',
      value: '654321',
      received_at: '2026-04-20T12:00:00.000Z',
      valid_until: '2026-04-20T12:15:00.000Z',
      subject: 'Your Disney+ code',
    });
  });

  it('overwrites an existing entry for the same service (last write wins)', async () => {
    const first: MatchResult = {
      service: 'max',
      type: 'code',
      value: '111111',
      validForMinutes: 15,
    };
    const second: MatchResult = {
      service: 'max',
      type: 'code',
      value: '222222',
      validForMinutes: 15,
    };
    await storeMatch(env, first, 'first', FIXED_NOW);
    await storeMatch(
      env,
      second,
      'second',
      new Date(FIXED_NOW.getTime() + 60 * 1000),
    );

    const read = await readEntry(env, 'max');
    expect(read?.type).toBe('code');
    if (read?.type !== 'code') throw new Error('unreachable');
    expect(read.value).toBe('222222');
    expect(read.subject).toBe('second');

    // Two puts recorded, both against the same key.
    expect(kv.puts).toHaveLength(2);
    expect(kv.puts.every((p) => p.key === 'entry:max')).toBe(true);
  });
});

describe('readEntry', () => {
  let env: Env;
  let kv: FakeKV;

  beforeEach(() => {
    ({ env, kv } = makeEnv());
  });

  it('returns null when nothing has been stored for the service', async () => {
    const read = await readEntry(env, 'max');
    expect(read).toBeNull();
  });

  it('returns null once the fake clock passes the stored TTL', async () => {
    const match: MatchResult = {
      service: 'max',
      type: 'code',
      value: '345678',
      validForMinutes: 15,
    };
    await storeMatch(env, match, 'Your Max sign-in code', FIXED_NOW);

    // Before expiry.
    expect(await readEntry(env, 'max')).not.toBeNull();

    // Advance past TTL = 15*60 + 3600 = 4500 seconds.
    kv.advanceSecondsBy(15 * 60 + ONE_HOUR_SECONDS);
    expect(await readEntry(env, 'max')).toBeNull();
  });
});

describe('isEntryFresh', () => {
  const entryValidUntil = (isoValidUntil: string): StoredEntry => ({
    type: 'code',
    service: 'disney',
    value: '123456',
    received_at: '2026-04-20T11:45:00.000Z',
    valid_until: isoValidUntil,
    subject: 'irrelevant',
  });

  it('is false for null', () => {
    expect(isEntryFresh(null, FIXED_NOW)).toBe(false);
  });

  it('is true for an entry still inside its validity window', () => {
    const validUntil = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000).toISOString();
    expect(isEntryFresh(entryValidUntil(validUntil), FIXED_NOW)).toBe(true);
  });

  it('is true for an entry expired less than one hour ago (inside grace)', () => {
    const validUntil = new Date(FIXED_NOW.getTime() - 59 * 60 * 1000).toISOString();
    expect(isEntryFresh(entryValidUntil(validUntil), FIXED_NOW)).toBe(true);
  });

  it('is true exactly at the grace boundary (60m past valid_until)', () => {
    // Boundary check: ONE_HOUR_SECONDS = 3600; elapsed = 3600 ⇒ still fresh.
    const validUntil = new Date(FIXED_NOW.getTime() - ONE_HOUR_SECONDS * 1000).toISOString();
    expect(isEntryFresh(entryValidUntil(validUntil), FIXED_NOW)).toBe(true);
  });

  it('is false once the entry has been expired for more than one hour', () => {
    const validUntil = new Date(
      FIXED_NOW.getTime() - (ONE_HOUR_SECONDS + 1) * 1000,
    ).toISOString();
    expect(isEntryFresh(entryValidUntil(validUntil), FIXED_NOW)).toBe(false);
  });
});

describe('filterStaleEntries', () => {
  const code = (validUntil: string): StoredEntry => ({
    type: 'code',
    service: 'disney',
    value: '123456',
    received_at: '2026-04-20T11:45:00.000Z',
    valid_until: validUntil,
    subject: 'irrelevant',
  });

  it('nulls out entries whose valid_until is more than an hour past', () => {
    const fresh = code(new Date(FIXED_NOW.getTime() + 60_000).toISOString());
    const stale = code(
      new Date(FIXED_NOW.getTime() - (ONE_HOUR_SECONDS + 60) * 1000).toISOString(),
    );
    const result = filterStaleEntries(
      {
        'netflix-household': null,
        disney: fresh,
        max: stale,
      },
      FIXED_NOW,
    );
    expect(result.disney).toBe(fresh);
    expect(result.max).toBeNull();
    expect(result['netflix-household']).toBeNull();
  });

  it('returns a record with every ServiceKey present (shape parity with readAllEntries)', () => {
    const result = filterStaleEntries(
      { 'netflix-household': null, disney: null, max: null },
      FIXED_NOW,
    );
    for (const service of SERVICE_KEYS) {
      expect(result).toHaveProperty(service);
      expect(result[service]).toBeNull();
    }
    expect(Object.keys(result).sort()).toEqual([...SERVICE_KEYS].sort());
  });
});

describe('readAllEntries', () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = makeEnv());
  });

  it('returns a Record with one slot per ServiceKey, filling absent services with null', async () => {
    const result = await readAllEntries(env);
    // Every ServiceKey must be a key of the returned record.
    for (const service of SERVICE_KEYS) {
      expect(result).toHaveProperty(service);
      expect(result[service]).toBeNull();
    }
    // And no extra keys.
    expect(Object.keys(result).sort()).toEqual([...SERVICE_KEYS].sort());
  });

  it('populates the slots for stored services and leaves the rest as null', async () => {
    const disney: MatchResult = {
      service: 'disney',
      type: 'code',
      value: '424242',
      validForMinutes: 15,
    };
    const household: MatchResult = {
      service: 'netflix-household',
      type: 'household',
      value: 'https://www.netflix.com/account/travel/token',
      validForMinutes: 15,
    };
    await storeMatch(env, disney, 'Disney+ code', FIXED_NOW);
    await storeMatch(env, household, 'Netflix household', FIXED_NOW);

    const result = await readAllEntries(env);

    expect(result.disney?.type).toBe('code');
    if (result.disney?.type !== 'code') throw new Error('unreachable');
    expect(result.disney.value).toBe('424242');

    expect(result['netflix-household']?.type).toBe('household');
    if (result['netflix-household']?.type !== 'household') throw new Error('unreachable');
    expect(result['netflix-household'].url).toBe(
      'https://www.netflix.com/account/travel/token',
    );

    // Services never written must still be present and null.
    expect(result.max).toBeNull();
  });
});
