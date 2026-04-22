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
  it('matches a Disney+ sign-in code from an HTML-only body', async () => {
    // Fixture is a sanitized real email: HTML-only (text.length = 0),
    // Spanish subject + body, sender on a trx.mail2.disneyplus.com
    // subdomain. The sanitized code is 111111.
    const parsed = await loadFixture('disney-signin.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '111111',
      validForMinutes: 15,
    });
  });

  it('matches a Max sign-in code from a plain-text body with the alerts.hbomax.com sender', async () => {
    // Fixture is a sanitized real email: plain-text body, sender
    // no-reply@alerts.hbomax.com. The sanitized code is 222222, and
    // Max's real body says the code expires in 30 minutes.
    const parsed = await loadFixture('max-signin.eml');
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'max',
      type: 'code',
      value: '222222',
      validForMinutes: 30,
    });
  });

  it('matches a Max sign-in code from the post-rebrand @max.com apex sender', () => {
    // Exercises the `@max\.com$` branch of the Max senderMatch, which
    // was previously covered only by a null-returning negative test.
    const parsed: ParsedEmail = {
      from: 'Max <no-reply@max.com>',
      subject: 'Your Max sign-in code',
      text: 'Your verification code is 664422. This code expires in 30 minutes.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'max',
      type: 'code',
      value: '664422',
      validForMinutes: 30,
    });
  });
});

describe('matchEmail — Netflix travel / household link', () => {
  it('matches a Netflix temporary-access-code email and extracts the travel verify link', async () => {
    // Fixture is a sanitized real email. The full URL includes a query
    // string (?nftoken=FAKE_NFTOKEN&messageGuid=FAKE_GUID) which the
    // linkRegex captures in full, stopping at whitespace or bracket.
    const parsed = await loadFixture('netflix-travel.eml');
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toMatch(
      /^https:\/\/www\.netflix\.com\/account\/travel\/verify\?nftoken=/,
    );
    // The capture must NOT include a trailing `]` from the bracketed
    // text-link format in the plain-text part.
    expect(result?.value.endsWith(']')).toBe(false);
    expect(result?.validForMinutes).toBe(15);
  });

  it('also matches the update-primary-location URL variant', () => {
    // Synthetic: the legacy Netflix household URL shape still needs
    // to match the same pattern.
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Update your Netflix Household',
      text: 'Confirm device: https://www.netflix.com/account/update-primary-location/FAKE_TOKEN_XYZ',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toBe(
      'https://www.netflix.com/account/update-primary-location/FAKE_TOKEN_XYZ',
    );
  });
});

describe('matchEmail — negative cases', () => {
  it('returns null for an unrelated newsletter', async () => {
    const parsed = await loadFixture('random-newsletter.eml');
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });
});

describe('matchEmail — direct unit tests (branch coverage)', () => {
  it('handles a bare (un-wrapped) from address', () => {
    const parsed: ParsedEmail = {
      from: 'noreply@disneyplus.com',
      subject: 'Your Disney+ code',
      text: 'Your code is 424242. It expires in 15 minutes.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '424242',
      validForMinutes: 15,
    });
  });

  it('handles a from address with display name and uppercase characters', () => {
    const parsed: ParsedEmail = {
      from: 'Disney+ <NOREPLY@DisneyPlus.COM>',
      subject: 'Your Disney+ code',
      text: 'Code: 999999',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '999999',
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

  it('returns null for a Netflix sender when there is no household link in the body', () => {
    // Netflix now only matches when there is a household/travel link;
    // plain sign-in emails are out of scope.
    const parsed: ParsedEmail = {
      from: 'info@account.netflix.com',
      subject: 'Your Netflix sign-in code',
      text: 'Your code is 5678. No link here.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
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
      from: 'evil@attacker.example <noreply@disneyplus.com>',
      subject: 'Your Disney+ code',
      text: 'Your code is 123456.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('rejects a malformed from with an unclosed angle bracket', () => {
    const parsed: ParsedEmail = {
      from: 'Disney+ <noreply@disneyplus.com',
      subject: 'Your Disney+ code',
      text: 'Your code is 123456.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toBeNull();
  });

  it('extracts the Disney+ code from context and ignores nearby 6-digit years / postal codes', () => {
    // A real Disney+ email may include "© 2026 Disney" or an "Order
    // number 100024" artifact. The codeRegex requires a contextual word
    // (code/passcode/código/...) so those digit-shaped non-codes skip.
    const parsed: ParsedEmail = {
      from: 'disneyplus@trx.mail2.disneyplus.com',
      subject: 'Your Disney+ code',
      text: 'Order 100024 · Your sign-in code is 753199. © 2026 Disney.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '753199',
      validForMinutes: 15,
    });
  });

  it('extracts a Spanish-language code via "código"', () => {
    const parsed: ParsedEmail = {
      from: 'disneyplus@trx.mail2.disneyplus.com',
      subject: 'Tu código de inicio de sesión de Disney+',
      text: 'Tu código de verificación es 424242. Expira en 15 minutos.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '424242',
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

  it('matches Disney+ code from a trx.mail2.disneyplus.com subdomain sender', () => {
    // Real transactional sender seen in the wild:
    // disneyplus@trx.mail2.disneyplus.com.
    const parsed: ParsedEmail = {
      from: 'Disney+ <disneyplus@trx.mail2.disneyplus.com>',
      subject: 'Your Disney+ one-time passcode',
      text: 'Your verification code is 889911.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '889911',
      validForMinutes: 15,
    });
  });

  it('matches a Max code from the alerts.hbomax.com subdomain', () => {
    // Real transactional sender seen in the wild:
    // no-reply@alerts.hbomax.com.
    const parsed: ParsedEmail = {
      from: 'Max <no-reply@alerts.hbomax.com>',
      subject: 'Your Max sign-in code',
      text: 'Your code is 554433.',
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'max',
      type: 'code',
      value: '554433',
      validForMinutes: 30,
    });
  });
});

describe('matchEmail — manually forwarded emails (Gmail Forward button)', () => {
  it('extracts the inner Netflix From from a Gmail-style "Forwarded message" block and matches the travel link', () => {
    // Shape of a Gmail manual forward: outer From is the family
    // member's Gmail; the real streaming-service From only exists
    // inside the quoted block in the body.
    const parsed: ParsedEmail = {
      from: 'Family Member <family@gmail.com>',
      subject: 'Fwd: Your Netflix temporary access code',
      text: [
        '',
        '---------- Forwarded message ---------',
        'From: Netflix <info@account.netflix.com>',
        'Date: Fri, 27 Mar 2026 at 16:03',
        'Subject: Your Netflix temporary access code',
        'To: <codes@example.com>',
        '',
        'Get Code',
        '[https://www.netflix.com/account/travel/verify?nftoken=FAKE_TOKEN]',
      ].join('\n'),
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.type).toBe('household');
    expect(result?.value).toBe(
      'https://www.netflix.com/account/travel/verify?nftoken=FAKE_TOKEN',
    );
  });

  it('extracts the inner Disney+ sender from a Spanish Gmail forward (De: + Mensaje reenviado, no English headers at all)', () => {
    // Gmail localizes BOTH the marker AND the header keys per the
    // account's UI language. A real Spanish forward contains only
    // "De:" — no "From:" anywhere — so the regex must accept either.
    const parsed: ParsedEmail = {
      from: 'Family Member <family@gmail.com>',
      subject: 'Fwd: Tu código de acceso único para Disney+',
      text: [
        '',
        '---------- Mensaje reenviado ---------',
        'De: Disney+ <disneyplus@trx.mail2.disneyplus.com>',
        'Fecha: vie, 27 mar 2026 a las 16:03',
        'Asunto: Tu código de acceso único para Disney+',
        'Para: <codes@example.com>',
        '',
        'Tu código de verificación es 887766. Expira en 15 minutos.',
      ].join('\n'),
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result).toEqual({
      service: 'disney',
      type: 'code',
      value: '887766',
      validForMinutes: 15,
    });
  });

  it('returns null when the forwarded block exists but the inner From is not a recognized service', () => {
    const parsed: ParsedEmail = {
      from: 'Family Member <family@gmail.com>',
      subject: 'Fwd: newsletter',
      text: [
        '---------- Forwarded message ---------',
        'From: News <news@example.org>',
        '',
        'Today in tech: 123456 amazing things happened.',
      ].join('\n'),
      html: '',
    };
    expect(matchEmail(parsed)).toBeNull();
  });

  it('returns null when no forwarded-message marker is present and the outer sender is unrecognized', () => {
    const parsed: ParsedEmail = {
      from: 'Family Member <family@gmail.com>',
      subject: 'Your Netflix sign-in code',
      text: 'This body would have matched if the outer From were info@account.netflix.com, but it is not.',
      html: '',
    };
    expect(matchEmail(parsed)).toBeNull();
  });

  it('prefers the outer From when it matches a pattern (no false-positive detour through the body)', () => {
    // If the real sender is Netflix and the body also contains a
    // forwarded block (unlikely but possible), the outer sender wins.
    const parsed: ParsedEmail = {
      from: 'Netflix <info@account.netflix.com>',
      subject: 'Your Netflix temporary access code',
      text: [
        'Get Code',
        '[https://www.netflix.com/account/travel/verify?nftoken=OUTER_TOKEN]',
        '',
        '---------- Forwarded message ---------',
        'From: Something Else <other@example.org>',
      ].join('\n'),
      html: '',
    };
    const result = matchEmail(parsed);
    expect(result?.service).toBe('netflix-household');
    expect(result?.value).toContain('OUTER_TOKEN');
  });
});

describe('matchEmail — defensive branches', () => {
  it('handles a missing subject field gracefully (parsed.subject ?? "" fallback)', () => {
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
});
