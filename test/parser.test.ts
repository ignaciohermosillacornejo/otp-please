import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import PostalMime from 'postal-mime';
import { describe, expect, it, test } from 'vitest';

import { matchEmail, PATTERNS, type ParsedEmail } from '../src/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<ParsedEmail> {
  const raw = readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const parsed = await PostalMime.parse(raw);
  return {
    from: parsed.from?.address ?? '',
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    html: parsed.html ?? '',
  };
}

describe('matchEmail — happy paths per service', () => {
  it('matches a Netflix sign-in code', async () => {
    const parsed = await loadFixture('netflix-signin.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '1234',
      validForMinutes: 15,
    });
  });

  it('matches a Disney+ sign-in code', async () => {
    const parsed = await loadFixture('disney-signin.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '123456',
      validForMinutes: 15,
    });
  });

  it('matches a Max sign-in code', async () => {
    const parsed = await loadFixture('max-signin.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'max',
      type: 'code',
      value: '234567',
      validForMinutes: 15,
    });
  });

  it('matches an Amazon Prime Video code when body references Prime Video', async () => {
    const parsed = await loadFixture('amazon-primevideo.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'amazon',
      type: 'code',
      value: '345678',
      validForMinutes: 15,
    });
  });
});

describe('matchEmail — Netflix household / travel', () => {
  it('matches a Netflix household email as household (not as a 4-digit code)', async () => {
    const parsed = await loadFixture('netflix-household.eml');
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toContain(
      'https://www.netflix.com/account/update-primary-location/',
    );
    expect(result?.validForMinutes).toBe(15);
  });

  it('matches a Netflix travel email as household (travel link family)', async () => {
    const parsed = await loadFixture('netflix-travel.eml');
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toContain('https://www.netflix.com/account/travel/');
  });
});

describe('matchEmail — negative cases', () => {
  it('returns null for an Amazon non-Prime-Video login email (bodyRequire rejects)', async () => {
    const parsed = await loadFixture('amazon-login-non-prime.eml');
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('returns null for an unrelated newsletter', async () => {
    const parsed = await loadFixture('random-newsletter.eml');
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });
});

describe('matchEmail — direct unit tests (branch coverage)', () => {
  it('handles a bare (un-wrapped) from address', () => {
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Your Netflix sign-in code',
      text: 'Your code is 4242. It expires in 15 minutes.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '4242',
      validForMinutes: 15,
    });
  });

  it('handles a from address with display name and uppercase characters', () => {
    const parsed: ParsedEmail = {
      from: 'Netflix <INFO@Account.Netflix.COM>',
      subject: 'Your Netflix sign-in code',
      text: 'Code: 9999',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '9999',
      validForMinutes: 15,
    });
  });

  it('falls back to HTML body when text body is empty', () => {
    const parsed: ParsedEmail = {
      from: 'noreply@disneyplus.com',
      subject: 'Your code',
      text: '',
      html: '<p>Code: <b>777777</b></p>',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '777777',
      validForMinutes: 15,
    });
  });

  it('returns null when body is empty and no pattern can extract', () => {
    const parsed: ParsedEmail = {
      from: 'noreply@disneyplus.com',
      subject: 'empty',
      text: '',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('skips the plain-netflix pattern when subject mentions "household" and body has no household link, yielding null', () => {
    // Sender matches Netflix. Subject has "household" so plain netflix is
    // skipped by subjectBlocklist. netflix-household ran first but its
    // linkRegex finds no link in the body. Result: null — a "sender hit
    // but no extraction" case across BOTH netflix patterns.
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Your Netflix Household update',
      text: 'Nothing useful here and no link.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('continues to the next pattern when an earlier pattern matches sender but fails to extract', () => {
    // Sender matches netflix-household's senderMatch, but there's no link
    // in the body. Implementation must NOT give up — it should continue
    // and let the plain-netflix pattern succeed on the 4-digit code.
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Your Netflix sign-in code',
      text: 'Your code is 5678.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '5678',
      validForMinutes: 15,
    });
  });

  it('returns null when the sender matches no pattern', () => {
    const parsed: ParsedEmail = {
      from: 'random@unknown.example',
      subject: '',
      text: 'nothing',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('returns null when from is empty string', () => {
    const parsed: ParsedEmail = {
      from: '',
      subject: 'Your code',
      text: '123456',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('returns null when Max pattern sender matches but no 6-digit code is present', () => {
    const parsed: ParsedEmail = {
      from: 'noreply@max.com',
      subject: 'Welcome',
      text: 'Thanks for joining Max!',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('rejects display-name spoofing (address-shaped display name with a legit angle-bracket address)', () => {
    // SECURITY: "Evil Display <legit@...>" must NOT authenticate as the
    // legit sender. An @ in the display name is treated as ambiguous and
    // normalizeFrom returns empty, so senderMatch fails for every pattern.
    const parsed: ParsedEmail = {
      from: 'evil@attacker.example <info@account.netflix.com>',
      subject: 'Your Netflix sign-in code',
      text: 'Your code is 1234.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('rejects a malformed from with an unclosed angle bracket', () => {
    const parsed: ParsedEmail = {
      from: 'Netflix <info@account.netflix.com',
      subject: 'Your Netflix sign-in code',
      text: 'Your code is 1234.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('extracts the Netflix code from context and ignores nearby 4-digit years', () => {
    // A real Netflix email may include "© 2026 Netflix, Inc." or
    // "account since 2019". The codeRegex requires a contextual word
    // (code/passcode/código/...) so the year-shaped digits are skipped.
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Your Netflix sign-in code',
      text: 'Account since 2019. Your sign-in code is 7531. © 2026 Netflix, Inc.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '7531',
      validForMinutes: 15,
    });
  });

  it('extracts a Spanish-language code via "código"', () => {
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Tu código de inicio de sesión de Netflix',
      text: 'Tu código de verificación es 4242. Expira en 15 minutos.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'netflix',
      type: 'code',
      value: '4242',
      validForMinutes: 15,
    });
  });

  it('matches a Netflix household link when it only appears in the HTML body', () => {
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Update your Netflix Household',
      text: '',
      html:
        '<p><a href="https://www.netflix.com/account/update-primary-location/' +
        'HTML_ONLY_TOKEN_0002">Confirm</a></p>',
    };
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toContain(
      'https://www.netflix.com/account/update-primary-location/HTML_ONLY_TOKEN_0002',
    );
  });

  it('returns null when Amazon sender matches but body lacks Prime Video', () => {
    const parsed: ParsedEmail = {
      from: 'no-reply@amazon.com',
      subject: 'Your Amazon code',
      text: 'Your code is 222222.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });
});

describe('matchEmail — defensive branches', () => {
  it('uses match[0] when the subject is missing entirely (undefined)', () => {
    // Covers the `parsed.subject ?? ''` fallback branch where subject is
    // not provided. The ParsedEmail type requires `subject`, but in
    // practice a postal-mime Email can have subject undefined; we cast
    // here to exercise the defensive branch without polluting the type.
    const parsed = {
      from: 'noreply@disneyplus.com',
      // subject omitted
      text: 'Your code is 424242',
      html: '',
    } as unknown as ParsedEmail;
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '424242',
      validForMinutes: 15,
    });
  });

  it('falls back to empty string when html is missing and text is absent', () => {
    // Covers the `parsed.html ?? ''` branch in selectBody.
    const parsed = {
      from: 'noreply@disneyplus.com',
      subject: 'no body at all',
      text: '',
      // html omitted
    } as unknown as ParsedEmail;
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('falls back to HTML when the text part is only whitespace', () => {
    // Some MIME senders include a whitespace-only stub text part alongside
    // the real HTML body. selectBody should skip the whitespace stub.
    const parsed: ParsedEmail = {
      from: 'noreply@disneyplus.com',
      subject: 'Your Disney+ sign-in code',
      text: '   \n\n  \t  ',
      html: '<p>Your verification code is <strong>557788</strong>.</p>',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '557788',
      validForMinutes: 15,
    });
  });
});

describe('PATTERNS invariants', () => {
  test('each pattern has exactly one of codeRegex or linkRegex', () => {
    for (const pattern of PATTERNS) {
      const hasCode = Boolean(pattern.codeRegex);
      const hasLink = Boolean(pattern.linkRegex);
      expect(hasCode !== hasLink).toBe(true);
    }
  });

  test('netflix-household is ordered before netflix', () => {
    const householdIdx = PATTERNS.findIndex((p) => p.service === 'netflix-household');
    const netflixIdx = PATTERNS.findIndex((p) => p.service === 'netflix');
    expect(householdIdx).toBeGreaterThanOrEqual(0);
    expect(netflixIdx).toBeGreaterThanOrEqual(0);
    expect(householdIdx).toBeLessThan(netflixIdx);
  });
});
