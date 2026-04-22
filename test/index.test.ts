import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/config';
import worker, { verifyForwarder } from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal in-memory KV fake. Mirrors the shape used in test/kv.test.ts
 * (duplicated here rather than refactored into a shared helper to keep
 * this PR's blast radius small — the kv test still owns its own copy
 * and they share no runtime dependency).
 */
class FakeKV {
  private store = new Map<string, string>();
  public readonly puts: Array<{ key: string; value: string; expirationTtl?: number }> =
    [];

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, expirationTtl: options?.expirationTtl });
  }

  async get(key: string, type: 'json'): Promise<unknown>;
  async get(key: string): Promise<string | null>;
  async get(key: string, type?: 'json'): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    if (type === 'json') return JSON.parse(value);
    return value;
  }
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; kv: FakeKV } {
  const kv = new FakeKV();
  const env: Env = {
    OTP_STORE: kv as unknown as Env['OTP_STORE'],
    TIMEZONE: 'America/Santiago',
    DASHBOARD_TITLE: 'Streaming Codes',
    FOOTER_TEXT: '',
    TRUSTED_FORWARDER: 'owner@example.com',
    ...overrides,
  };
  return { env, kv };
}

/**
 * Build a ForwardableEmailMessage test double from a raw MIME string
 * and a header map. Only the surface that src/index.ts touches is
 * implemented — any field the handler doesn't read is omitted.
 */
function makeMessage(options: {
  raw: string;
  headers: Record<string, string>;
  from?: string;
  to?: string;
}): ForwardableEmailMessage {
  const headers = new Headers(options.headers);
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(options.raw);
  const rawStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(rawBytes);
      controller.close();
    },
  });

  return {
    from: options.from ?? 'sender@example.com',
    to: options.to ?? 'codes@example.com',
    headers,
    raw: rawStream,
    rawSize: rawBytes.byteLength,
    // Methods the handler never calls — throw loudly if something does.
    setReject: () => {
      throw new Error('setReject should not be called');
    },
    forward: async () => {
      throw new Error('forward should not be called');
    },
    reply: async () => {
      throw new Error('reply should not be called');
    },
  } as unknown as ForwardableEmailMessage;
}

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

describe('verifyForwarder', () => {
  const trusted = 'owner@example.com';

  it('returns false for a null envelope-from', () => {
    expect(verifyForwarder(null, trusted)).toBe(false);
  });

  it('returns false for an empty-string envelope-from', () => {
    expect(verifyForwarder('', trusted)).toBe(false);
  });

  it('returns true when envelope-from equals the configured forwarder', () => {
    expect(verifyForwarder('owner@example.com', trusted)).toBe(true);
  });

  it('rejects a bogus envelope-from even if it looks superficially similar', () => {
    expect(verifyForwarder('attacker@evil.example', trusted)).toBe(false);
    expect(verifyForwarder('owner@evil.example', trusted)).toBe(false);
    expect(verifyForwarder('attacker@example.com', trusted)).toBe(false);
  });

  it('accepts <angle-bracketed> envelope-from values', () => {
    expect(verifyForwarder('<owner@example.com>', trusted)).toBe(true);
  });

  it('accepts <angle-bracketed> TRUSTED_FORWARDER values (operator-error tolerance)', () => {
    // If the secret is misconfigured with angle brackets, normalization
    // strips them from both sides — so a plain envelope-from still
    // matches an angle-bracketed configured value.
    expect(verifyForwarder('owner@example.com', '<owner@example.com>')).toBe(true);
  });

  it('matches case-insensitively on both sides', () => {
    expect(verifyForwarder('OWNER@example.com', 'owner@Example.COM')).toBe(true);
  });

  it('treats Gmail addresses with different dot placements as the same mailbox', () => {
    // Google ignores dots in the gmail.com local-part — e.g.
    // `foo.bar@gmail.com` and `foobar@gmail.com` address the same
    // mailbox, and outbound envelope stamps whichever canonical form
    // the account uses, which may differ from the form the deployer
    // put in TRUSTED_FORWARDER. Both sides get dot-stripped before
    // compare so the check survives that drift.
    expect(verifyForwarder('fo.o.bar@gmail.com', 'foobar@gmail.com')).toBe(true);
    // Reverse — TRUSTED_FORWARDER with dots, envelope without.
    expect(verifyForwarder('foobar@gmail.com', 'fo.o.bar@gmail.com')).toBe(true);
    // Googlemail.com is the same Google mailbox as gmail.com (Google
    // owns both); same dot-insensitivity applies.
    expect(
      verifyForwarder('foo.bar@googlemail.com', 'foobar@googlemail.com'),
    ).toBe(true);
    // Google treats gmail.com and googlemail.com as aliases of the
    // same mailbox — an envelope stamped at @googlemail.com must
    // compare equal to a TRUSTED_FORWARDER configured at @gmail.com,
    // and vice versa.
    expect(
      verifyForwarder('foo.bar@googlemail.com', 'foobar@gmail.com'),
    ).toBe(true);
    expect(
      verifyForwarder('foobar@gmail.com', 'fo.o.bar@googlemail.com'),
    ).toBe(true);
    // Non-Gmail domains are NOT dot-normalized; the comparison stays
    // literal for providers that treat dots as significant.
    expect(verifyForwarder('fo.o@example.com', 'foo@example.com')).toBe(false);
  });

  it('returns false when TRUSTED_FORWARDER is empty/whitespace', () => {
    // Defensive: an empty TRUSTED_FORWARDER must NEVER cause a vacuous
    // match against an empty/missing envelope-from.
    expect(verifyForwarder('owner@example.com', '')).toBe(false);
    expect(verifyForwarder('owner@example.com', '   ')).toBe(false);
  });

  it('returns false when TRUSTED_FORWARDER is undefined (secret unset at runtime)', () => {
    // Env.TRUSTED_FORWARDER is typed `string | undefined` because a
    // Worker deployed without the secret ever being set has
    // env.TRUSTED_FORWARDER literally undefined at runtime. The
    // verifyForwarder guard must fail closed here instead of crashing
    // on `undefined.trim()` inside normalizeAddress.
    expect(verifyForwarder('owner@example.com', undefined)).toBe(false);
  });
});

describe('email() handler', () => {
  beforeEach(() => {
    // The handler logs with structured prefixes; silence them so the
    // test output stays focused on assertions.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('stores exactly one KV entry for a recognized, trusted email', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('disney-signin.eml'),
      headers: {},
      from: 'owner@example.com',
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe('entry:disney');
    const stored = JSON.parse(kv.puts[0].value);
    expect(stored.type).toBe('code');
    expect(stored.service).toBe('disney');
    expect(stored.value).toBe('111111');
    expect(stored.subject).toBe('Tu código de acceso único para Disney+');
  });

  it('writes nothing when the envelope-from does not match the trusted forwarder', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('disney-signin.eml'),
      headers: { 'x-some-header': 'v' },
      from: 'attacker@evil.example',
      to: 'codes@example.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
    // The skip path emits a verbose-by-design log line with full
    // diagnostic context (per the owner's feedback: this is a
    // low-traffic private Worker, aggressive logs are fine — only
    // OTP VALUES and household URL tokens are redacted).
    const skip = logs.find((l) => l.startsWith('skip: forwarder verification failed'));
    // Guard: .find returns undefined when no log line matches, which
    // would produce a cryptic TypeError on the .toContain calls below
    // rather than a clean "expected defined" assertion failure.
    expect(skip).toBeDefined();
    // Envelope fields are JSON.stringify'd in the log to prevent a
    // malformed SMTP envelope (containing whitespace or newlines) from
    // fragmenting the structured log line.
    expect(skip).toContain('envelope-from="attacker@evil.example"');
    expect(skip).toContain('envelope-to="codes@example.com"');
    expect(skip).toContain('configured-forwarder="owner@example.com"');
    expect(skip).toContain('normalized-from="attacker@evil.example"');
    expect(skip).toContain('normalized-configured="owner@example.com"');
    expect(skip).toContain('matched=false');
    expect(skip).toContain('header-names=[x-some-header]');
  });

  it('writes nothing when no parser pattern matches (unknown sender)', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('random-newsletter.eml'),
      headers: {},
      from: 'owner@example.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
    // The no-pattern-match path logs a verbose diagnostic line with
    // from, subject, and a 400-char body prefix so template drift is
    // diagnosable. Lock the shape down so the fields aren't silently
    // dropped if the log line is refactored.
    const skip = logs.find((l) => l.startsWith('skip: no pattern matched'));
    expect(skip).toBeDefined();
    // All three fields are JSON.stringify'd to prevent whitespace or
    // newlines in a crafted From/Subject from fragmenting the log line.
    expect(skip).toContain('from="newsletter@example.org"');
    expect(skip).toContain('subject=');
    expect(skip).toContain('body=');
    // Defense against redaction regressions: the `match.value` redaction
    // discipline lives in the OTP and household-token paths, not here,
    // but any 4/6-digit digit run in the newsletter body should still
    // surface — otherwise our truncation or regex would have corrupted
    // the diagnostic.
    expect(skip).toContain('524312');
  });

  it('swallows and logs KV failures rather than propagating an unhandled rejection', async () => {
    const { env, kv } = makeEnv();
    // Force storeMatch's put() call to fail. We assert the handler
    // resolves normally and emits an `err:`-prefixed log line rather
    // than letting the rejection surface to the Workers runtime (which
    // would otherwise silently retry/drop the mail).
    const failingKv = kv as unknown as { put: typeof kv.put };
    failingKv.put = async () => {
      throw new Error('kv outage');
    };
    const message = makeMessage({
      raw: loadFixture('disney-signin.eml'),
      headers: {},
      from: 'owner@example.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await expect(worker.email!(message, env, fakeCtx())).resolves.toBeUndefined();
    expect(logs.some((l) => l.startsWith('err: KV write failed for disney'))).toBe(
      true,
    );
    // The error log must NOT contain the extracted code.
    expect(logs.every((l) => !l.includes('111111'))).toBe(true);
  });

  it('swallows non-Error throws from KV (string rejection) without crashing', async () => {
    // Defensive test for the `err instanceof Error` branch — some KV
    // wrappers reject with plain strings or objects.
    const { env, kv } = makeEnv();
    const failingKv = kv as unknown as { put: typeof kv.put };
    failingKv.put = async () => {
      throw 'kv string error';
    };
    const message = makeMessage({
      raw: loadFixture('disney-signin.eml'),
      headers: {},
      from: 'owner@example.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await expect(worker.email!(message, env, fakeCtx())).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('kv string error'))).toBe(true);
  });
});

describe('fetch() handler', () => {
  it('GET /healthz returns 200 "ok" text/plain', async () => {
    const { env } = makeEnv();
    const request = new Request('https://otp.example.com/healthz');
    const response = await worker.fetch!(request, env, fakeCtx());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('ok');
  });

  it('GET /api returns 200 application/json with the entries Record', async () => {
    const { env, kv } = makeEnv();
    // Seed one service to prove readAllEntries pass-through. valid_until
    // is anchored to the real wall clock so the grace-window filter
    // in src/index.ts (drops entries more than an hour past their
    // valid_until) doesn't rot this test as time passes.
    const now = Date.now();
    const disneyEntry = {
      type: 'code',
      service: 'disney',
      value: '424242',
      received_at: new Date(now - 5 * 60 * 1000).toISOString(),
      valid_until: new Date(now + 10 * 60 * 1000).toISOString(),
      subject: 'Your Disney+ sign-in code',
    };
    await kv.put('entry:disney', JSON.stringify(disneyEntry));

    const request = new Request('https://otp.example.com/api');
    const response = await worker.fetch!(request, env, fakeCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.disney).toEqual(disneyEntry);
    // Services with no entry still appear as null slots.
    expect(body).toHaveProperty('netflix-household', null);
    expect(body).toHaveProperty('max', null);
    // Dropped services must NOT appear in the /api payload.
    expect(body).not.toHaveProperty('netflix');
    expect(body).not.toHaveProperty('amazon');
  });

  it('GET / returns 200 text/html with the dashboard title and CSP header', async () => {
    const { env } = makeEnv({ DASHBOARD_TITLE: 'Family Codes' });
    const request = new Request('https://otp.example.com/');
    const response = await worker.fetch!(request, env, fakeCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toMatch(
      /default-src 'self'/,
    );
    expect(response.headers.get('content-security-policy')).toMatch(
      /cdn\.tailwindcss\.com/,
    );

    const body = await response.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('Family Codes');
  });

  it('GET /unknown-path falls through to the dashboard', async () => {
    const { env } = makeEnv();
    const request = new Request('https://otp.example.com/unknown-path');
    const response = await worker.fetch!(request, env, fakeCtx());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await response.text();
    expect(body).toContain('<!DOCTYPE html>');
  });

  it('POST / returns 405 Method Not Allowed with Allow: GET', async () => {
    const { env } = makeEnv();
    const request = new Request('https://otp.example.com/', { method: 'POST' });
    const response = await worker.fetch!(request, env, fakeCtx());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('GET / serves dashboard content for populated entries (end-to-end smoke)', async () => {
    const { env, kv } = makeEnv();
    // valid_until anchored to now so the fetch handler's grace-window
    // filter doesn't drop this fixture once the test clock drifts past
    // the old hard-coded 2026-04-20 date.
    const now = Date.now();
    await kv.put(
      'entry:max',
      JSON.stringify({
        type: 'code',
        service: 'max',
        value: '555555',
        received_at: new Date(now - 60 * 1000).toISOString(),
        valid_until: new Date(now + 14 * 60 * 1000).toISOString(),
        subject: 'Your Max sign-in code',
      }),
    );
    const request = new Request('https://otp.example.com/');
    const response = await worker.fetch!(request, env, fakeCtx());
    const body = await response.text();
    expect(body).toContain('data-code="555555"');
    expect(body).toContain('555555');
  });
});
