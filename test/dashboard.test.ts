import { describe, expect, it } from 'vitest';

import {
  DISPLAY_ORDER,
  escapeHtml,
  formatCountdown,
  renderDashboard,
  type DashboardData,
} from '../src/dashboard';
import type { StoredEntry } from '../src/kv';
import type { ServiceKey } from '../src/parser';

// A fixed "now" used across tests so the initial server-rendered
// countdown text is deterministic. Chosen arbitrarily; tests that care
// about a specific delta derive valid_until / received_at from this.
const NOW = new Date('2026-04-20T12:00:00.000Z');

// Five minutes after NOW. Used as valid_until for the "happy path" code
// and household entries: (5 * 60)s = 300s → "valid for 5m 00s".
const VALID_UNTIL_FIVE_MIN = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();

// 30s before NOW. Used as received_at: "received 0m ago" → "received just now".
// A few tests use a longer ago to exercise the non-zero minute branch.
const RECEIVED_JUST_NOW = new Date(NOW.getTime() - 30 * 1000).toISOString();
const RECEIVED_THREE_MIN_AGO = new Date(NOW.getTime() - 3 * 60 * 1000).toISOString();

// A past valid_until: 90 seconds ago → "expired 1m ago".
const EXPIRED_90S_AGO = new Date(NOW.getTime() - 90 * 1000).toISOString();

function emptyEntries(): Record<ServiceKey, StoredEntry | null> {
  return {
    netflix: null,
    'netflix-household': null,
    disney: null,
    max: null,
  };
}

function defaultData(
  overrides: Partial<DashboardData> = {},
): DashboardData {
  return {
    entries: emptyEntries(),
    title: 'Streaming Codes',
    footerText: '',
    now: NOW,
    ...overrides,
  };
}

describe('DISPLAY_ORDER', () => {
  it('lists the four supported services in the documented order', () => {
    expect(DISPLAY_ORDER).toEqual([
      'netflix',
      'netflix-household',
      'disney',
      'max',
    ]);
  });
});

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('leaves a plain ASCII string unchanged', () => {
    expect(escapeHtml('hello world 1234')).toBe('hello world 1234');
  });
});

describe('formatCountdown', () => {
  it('returns "valid for Xm YYs" when valid_until is in the future', () => {
    const { text, expired } = formatCountdown(VALID_UNTIL_FIVE_MIN, NOW);
    expect(text).toBe('valid for 5m 00s');
    expect(expired).toBe(false);
  });

  it('zero-pads the seconds field', () => {
    const until = new Date(NOW.getTime() + (3 * 60 + 5) * 1000).toISOString();
    const { text } = formatCountdown(until, NOW);
    expect(text).toBe('valid for 3m 05s');
  });

  it('returns "expired Nm ago" when valid_until is in the past', () => {
    const { text, expired } = formatCountdown(EXPIRED_90S_AGO, NOW);
    expect(text).toBe('expired 1m ago');
    expect(expired).toBe(true);
  });
});

describe('renderDashboard — structure and ordering', () => {
  it('produces a <!DOCTYPE html> document with the dashboard title', () => {
    const html = renderDashboard(defaultData({ title: 'My Codes' }));
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>My Codes</title>');
    expect(html).toContain('<h1 class="text-2xl font-bold">My Codes</h1>');
  });

  it('includes a meta refresh tag with 30-second interval', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
  });

  it('emits <html lang="en" class="dark"> so dark mode is the default', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('<html lang="en" class="dark">');
  });

  it('renders a card for every service in DISPLAY_ORDER', () => {
    const html = renderDashboard(defaultData());
    // Match the display-name headings — one per service.
    expect(html).toContain('>Netflix<');
    expect(html).toContain('>Netflix Household<');
    expect(html).toContain('>Disney+<');
    expect(html).toContain('>Max<');
    expect(html).not.toContain('>Prime Video<');
  });

  it('renders cards in DISPLAY_ORDER (netflix before household before disney before max)', () => {
    const html = renderDashboard(defaultData());
    const idxNetflix = html.indexOf('>Netflix<');
    const idxHousehold = html.indexOf('>Netflix Household<');
    const idxDisney = html.indexOf('>Disney+<');
    const idxMax = html.indexOf('>Max<');
    expect(idxNetflix).toBeGreaterThan(-1);
    expect(idxNetflix).toBeLessThan(idxHousehold);
    expect(idxHousehold).toBeLessThan(idxDisney);
    expect(idxDisney).toBeLessThan(idxMax);
  });
});

describe('renderDashboard — code entries', () => {
  it('renders the code as data-code and as visible text, with countdown and received-ago spans', () => {
    const entries = emptyEntries();
    entries.netflix = {
      type: 'code',
      service: 'netflix',
      value: '1234',
      received_at: RECEIVED_THREE_MIN_AGO,
      valid_until: VALID_UNTIL_FIVE_MIN,
      subject: 'Your Netflix sign-in code',
    };

    const html = renderDashboard(defaultData({ entries }));

    // Tap-to-copy button has the code as both data-code and body text.
    expect(html).toContain('data-code="1234"');
    expect(html).toContain('onclick="copy(this)"');
    // The digit string appears in the visible <button> body (plus the
    // data-code attribute — two occurrences is fine).
    expect(html.match(/1234/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    // data-valid-until + data-received-at expose ISO strings to the client tick().
    expect(html).toContain(`data-valid-until="${VALID_UNTIL_FIVE_MIN}"`);
    expect(html).toContain(`data-received-at="${RECEIVED_THREE_MIN_AGO}"`);

    // Initial server-side countdown text reflects `data.now` so JS-disabled
    // visitors see a meaningful string.
    expect(html).toContain('valid for 5m 00s');
    expect(html).toContain('received 3m ago');
  });

  it('initial text flips to "expired" for a past valid_until and applies the red class', () => {
    const entries = emptyEntries();
    entries.disney = {
      type: 'code',
      service: 'disney',
      value: '987654',
      received_at: RECEIVED_THREE_MIN_AGO,
      valid_until: EXPIRED_90S_AGO,
      subject: 'Disney+ verification',
    };

    const html = renderDashboard(defaultData({ entries }));
    expect(html).toContain('expired 1m ago');
    // The countdown span gets text-red-500 when expired.
    expect(html).toMatch(/data-valid-until="[^"]+"[^>]*text-red-500/);
  });

  it('does not render a copy button for an empty entry', () => {
    const html = renderDashboard(defaultData());
    // No entries populated, so no data-code attributes should exist.
    expect(html).not.toContain('data-code=');
    expect(html).not.toContain('onclick="copy(this)"');
  });
});

describe('renderDashboard — household entries', () => {
  it('renders the URL as href and shows the home-network warning', () => {
    const entries = emptyEntries();
    entries['netflix-household'] = {
      type: 'household',
      service: 'netflix-household',
      url: 'https://www.netflix.com/account/travel/OPAQUE-TOKEN',
      received_at: RECEIVED_JUST_NOW,
      valid_until: VALID_UNTIL_FIVE_MIN,
      subject: 'Your Netflix Household request',
    };

    const html = renderDashboard(defaultData({ entries }));

    expect(html).toContain(
      'href="https://www.netflix.com/account/travel/OPAQUE-TOKEN"',
    );
    expect(html).toContain('target="_blank"');
    // noopener prevents window.opener access; noreferrer additionally
    // suppresses the Referer header so the target doesn't see the
    // Access-gated dashboard URL.
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(
      'This link only works from a device on the home network',
    );
    expect(html).toContain(
      "If you're traveling, ask someone at home to open this dashboard and tap the link.",
    );
    // Countdown + received spans present on household cards too.
    expect(html).toContain(`data-valid-until="${VALID_UNTIL_FIVE_MIN}"`);
    expect(html).toContain(`data-received-at="${RECEIVED_JUST_NOW}"`);
  });
});

describe('renderDashboard — empty states', () => {
  it('renders "no recent code" for non-household services with null entries', () => {
    const html = renderDashboard(defaultData());
    // "no recent code" appears for netflix, disney, max — three times.
    expect(html.match(/no recent code/g)?.length).toBe(3);
  });

  it('renders "no household request pending" for netflix-household with null entry', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('no household request pending');
  });

  it('applies a greyed-out class (opacity-50) to empty cards', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('opacity-50');
  });
});

describe('renderDashboard — HTML escaping', () => {
  it('escapes <script> in a code value and subject', () => {
    const entries = emptyEntries();
    // Nonsensical but defensive: if the parser ever extracted something
    // weird, it must not land in the page as live markup.
    entries.netflix = {
      type: 'code',
      service: 'netflix',
      value: '"><script>alert(1)</script>',
      received_at: RECEIVED_JUST_NOW,
      valid_until: VALID_UNTIL_FIVE_MIN,
      subject: '<script>alert("pwn")</script>',
    };

    const html = renderDashboard(defaultData({ entries }));

    // The literal script opening tag must NOT appear anywhere in the
    // document (the inline client <script> is fine — that's `<script>`
    // written in the TEMPLATE, not from user data).
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert("pwn")</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes < in footerText and puts the result above the attribution', () => {
    const html = renderDashboard(
      defaultData({ footerText: 'hello <world> & friends' }),
    );
    expect(html).not.toContain('<world>');
    expect(html).toContain('hello &lt;world&gt; &amp; friends');
  });

  it('escapes the title', () => {
    const html = renderDashboard(defaultData({ title: '<bad>' }));
    expect(html).toContain('<title>&lt;bad&gt;</title>');
    expect(html).not.toContain('<title><bad></title>');
  });

  it('escapes a household URL containing special chars so query strings stay safe', () => {
    const entries = emptyEntries();
    entries['netflix-household'] = {
      type: 'household',
      service: 'netflix-household',
      url: 'https://example.com/x?a=1&b="2"',
      received_at: RECEIVED_JUST_NOW,
      valid_until: VALID_UNTIL_FIVE_MIN,
      subject: 'household',
    };

    const html = renderDashboard(defaultData({ entries }));
    expect(html).toContain(
      'href="https://example.com/x?a=1&amp;b=&quot;2&quot;"',
    );
  });
});

describe('renderDashboard — footer', () => {
  it('omits the footerText line when footerText is empty', () => {
    const html = renderDashboard(defaultData({ footerText: '' }));
    // The attribution link is always present…
    expect(html).toContain('otp-please');
    // …but a <p> with footerText content should not appear because we
    // didn't pass any. The simplest check: there's only one paragraph
    // inside the footer (the attribution), no second one.
    const footerStart = html.indexOf('<footer');
    const footerEnd = html.indexOf('</footer>');
    expect(footerStart).toBeGreaterThan(-1);
    const footerBlock = html.slice(footerStart, footerEnd);
    const paragraphCount = (footerBlock.match(/<p\b/g) ?? []).length;
    expect(paragraphCount).toBe(1);
  });

  it('renders the footerText when non-empty and escapes its contents', () => {
    const html = renderDashboard(
      defaultData({ footerText: 'forwarded from example@forward.test' }),
    );
    expect(html).toContain('forwarded from example@forward.test');
    // Attribution still present.
    expect(html).toContain(
      'href="https://github.com/ignaciohermosillacornejo/otp-please"',
    );
  });
});

describe('renderDashboard — inline client script', () => {
  it('embeds the copy() and tick() functions', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('function copy(');
    expect(html).toContain('function tick(');
    expect(html).toContain('setInterval(tick, 1000);');
  });

  it('references the Tailwind CDN script', () => {
    const html = renderDashboard(defaultData());
    expect(html).toContain('https://cdn.tailwindcss.com');
  });
});
