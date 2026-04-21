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
    TAILSCALE_PROBE_URL: '',
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

// Gmail-style Authentication-Results stanza. Matches the shape documented
// in the task auth memo. We use owner@example.com so the test file is
// sanitized (matches the TRUSTED_FORWARDER in makeEnv).
const GMAIL_AUTH_PASS =
  'mx.cloudflare.com;' +
  ' dkim=pass header.i=@account.netflix.com header.s=nflx1 header.b=abc;' +
  ' spf=pass (cloudflare.com: domain of owner@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=owner@example.com;' +
  ' dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=account.netflix.com';

describe('verifyForwarder', () => {
  const trusted = 'owner@example.com';

  it('returns false for a null header', () => {
    expect(verifyForwarder(null, trusted)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(verifyForwarder('', trusted)).toBe(false);
  });

  it('returns true for a typical Gmail-forwarded spf=pass stanza', () => {
    expect(verifyForwarder(GMAIL_AUTH_PASS, trusted)).toBe(true);
  });

  it('returns false when spf=fail even if smtp.mailfrom matches', () => {
    const header = GMAIL_AUTH_PASS.replace('spf=pass', 'spf=fail');
    expect(verifyForwarder(header, trusted)).toBe(false);
  });

  it('returns false when spf=pass but smtp.mailfrom is a different address', () => {
    const header = GMAIL_AUTH_PASS.replace(
      'smtp.mailfrom=owner@example.com',
      'smtp.mailfrom=attacker@example.com',
    );
    expect(verifyForwarder(header, trusted)).toBe(false);
  });

  it('returns false when spf=pass but smtp.mailfrom is absent (helo-only)', () => {
    const header =
      'mx.cloudflare.com; spf=pass (fallback) smtp.helo=mail-sor-f41.example.com';
    expect(verifyForwarder(header, trusted)).toBe(false);
  });

  it('returns false when there is no spf= result at all', () => {
    const header =
      'mx.cloudflare.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com';
    expect(verifyForwarder(header, trusted)).toBe(false);
  });

  it('accepts multiple stanzas joined by comma where one matches', () => {
    const receivingMTA = 'mx.other.net; dkim=none; spf=none';
    const header = `${receivingMTA}, ${GMAIL_AUTH_PASS}`;
    expect(verifyForwarder(header, trusted)).toBe(true);
  });

  it('still matches when stanzas are separated by both ";" and a newline (header folding)', () => {
    // Regex splits on `;` and `,` only — this passes because the
    // critical `spf=pass smtp.mailfrom=...` clause is cleanly bounded
    // by `;` within the second stanza, not because `\n` is a separator.
    // The test is here to document that newline-folded real-world
    // headers still work, NOT to claim `\n` is an intentional split point.
    const receivingMTA = 'mx.other.net; dkim=none; spf=none';
    const header = `${receivingMTA}\n${GMAIL_AUTH_PASS}`;
    expect(verifyForwarder(header, trusted)).toBe(true);
  });

  it('accepts <angle-bracketed> smtp.mailfrom values', () => {
    const header =
      'mx.cloudflare.com; spf=pass smtp.mailfrom=<owner@example.com>';
    expect(verifyForwarder(header, trusted)).toBe(true);
  });

  it('matches case-insensitively on both sides', () => {
    const header =
      'mx.cloudflare.com; spf=pass smtp.mailfrom=OWNER@example.com';
    expect(verifyForwarder(header, 'owner@Example.COM')).toBe(true);
  });

  it('returns false when TRUSTED_FORWARDER is empty/whitespace', () => {
    // Defensive: an empty TRUSTED_FORWARDER must NEVER cause a vacuous
    // match. Blank string must not equal blank mailfrom, etc.
    expect(verifyForwarder(GMAIL_AUTH_PASS, '')).toBe(false);
    expect(verifyForwarder(GMAIL_AUTH_PASS, '   ')).toBe(false);
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
      raw: loadFixture('netflix-signin.eml'),
      headers: { 'Authentication-Results': GMAIL_AUTH_PASS },
      from: 'info@account.netflix.com',
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe('entry:netflix');
    const stored = JSON.parse(kv.puts[0].value);
    expect(stored.type).toBe('code');
    expect(stored.service).toBe('netflix');
    expect(stored.value).toBe('1234');
    expect(stored.subject).toBe('Your Netflix sign-in code');
  });

  it('writes nothing when forwarder verification fails', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('netflix-signin.eml'),
      headers: {
        'Authentication-Results':
          'mx.cloudflare.com; spf=fail smtp.mailfrom=owner@example.com',
      },
      from: 'owner@example.com',
      to: 'codes@example.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
    // Privacy: the skip log must NOT include the envelope from/to or
    // any authentication header content.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe('skip: forwarder verification failed (envelope rejected)');
    expect(logs[0]).not.toContain('owner@example.com');
    expect(logs[0]).not.toContain('codes@example.com');
  });

  it('writes nothing when the Authentication-Results header is missing', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('netflix-signin.eml'),
      headers: {},
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
  });

  it('writes nothing when no parser pattern matches (unknown sender)', async () => {
    const { env, kv } = makeEnv();
    const message = makeMessage({
      raw: loadFixture('random-newsletter.eml'),
      headers: { 'Authentication-Results': GMAIL_AUTH_PASS },
      from: 'newsletter@example.org',
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
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
      raw: loadFixture('netflix-signin.eml'),
      headers: { 'Authentication-Results': GMAIL_AUTH_PASS },
      from: 'info@account.netflix.com',
    });
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await expect(worker.email!(message, env, fakeCtx())).resolves.toBeUndefined();
    expect(logs.some((l) => l.startsWith('err: KV write failed for netflix'))).toBe(
      true,
    );
    // The error log must NOT contain the extracted code.
    expect(logs.every((l) => !l.includes('1234'))).toBe(true);
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
      raw: loadFixture('netflix-signin.eml'),
      headers: { 'Authentication-Results': GMAIL_AUTH_PASS },
      from: 'info@account.netflix.com',
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
    // Seed one service to prove readAllEntries pass-through.
    const netflixEntry = {
      type: 'code',
      service: 'netflix',
      value: '4242',
      received_at: '2026-04-20T11:55:00.000Z',
      valid_until: '2026-04-20T12:10:00.000Z',
      subject: 'sign-in',
    };
    await kv.put('entry:netflix', JSON.stringify(netflixEntry));

    const request = new Request('https://otp.example.com/api');
    const response = await worker.fetch!(request, env, fakeCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.netflix).toEqual(netflixEntry);
    // Services with no entry still appear as null slots.
    expect(body).toHaveProperty('disney', null);
    expect(body).toHaveProperty('max', null);
    expect(body).toHaveProperty('amazon', null);
    expect(body).toHaveProperty('netflix-household', null);
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
    await kv.put(
      'entry:netflix',
      JSON.stringify({
        type: 'code',
        service: 'netflix',
        value: '5555',
        received_at: '2026-04-20T11:59:00.000Z',
        valid_until: '2026-04-20T12:14:00.000Z',
        subject: 'code',
      }),
    );
    const request = new Request('https://otp.example.com/');
    const response = await worker.fetch!(request, env, fakeCtx());
    const body = await response.text();
    expect(body).toContain('data-code="5555"');
    expect(body).toContain('5555');
  });
});
