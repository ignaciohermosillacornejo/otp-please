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

  it('accepts multiple stanzas joined by newline where one matches', () => {
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
    });

    await worker.email!(message, env, fakeCtx());

    expect(kv.puts).toHaveLength(0);
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
});

describe('fetch() handler', () => {
  it('returns 501 Not Implemented (dashboard stub)', async () => {
    const { env } = makeEnv();
    const request = new Request('https://otp.example.com/');
    const response = await worker.fetch!(request, env, fakeCtx());
    expect(response.status).toBe(501);
    expect(await response.text()).toBe('Not Implemented');
  });
});
