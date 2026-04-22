// Mobile-first dashboard renderer. Pure function: takes a snapshot of
// per-service entries plus Env-derived config and returns a complete
// HTML document string. No I/O and no Date.now() calls inside —
// `data.now` is injected so the server-rendered countdown text is
// deterministic and testable.
//
// Design notes:
//  - Single-file output (no external bundle) so the Worker can serve
//    it directly. The only third-party asset is Tailwind's CDN.
//  - Freshness strategy is two-layered:
//      1. Client-side poll of /api every POLL_INTERVAL_MS (5s). When a
//         service's received_at changes (or flips null↔entry) the
//         matching <section data-service="..."> is replaced in place.
//         Scroll, mid-flight copy() feedback on the other cards, and
//         the 1Hz countdown tick are preserved.
//      2. A widened <meta http-equiv="refresh" content="300"> as a
//         last-ditch fallback for the case where JS silently died
//         (e.g. tab backgrounded for days and the runtime throttled it
//         into oblivion). 300s is long enough not to interrupt normal
//         use and short enough to self-heal within a single sitting.
//  - All user-controlled values flow through escapeHtml() before they
//    hit the template. Attribute values are always double-quoted.

import type { StoredEntry } from './kv';
import type { ServiceKey } from './parser';

export interface DashboardData {
  entries: Record<ServiceKey, StoredEntry | null>;
  title: string;
  footerText: string;
  now: Date;
}

// Fixed service display order. Exported so tests can assert ordering
// against the same source of truth the renderer uses.
export const DISPLAY_ORDER: readonly ServiceKey[] = [
  'netflix-household',
  'disney',
  'max',
] as const;

interface ServiceMeta {
  name: string;
  // Tailwind utility used on the card's accent stripe/border. Must be a
  // class Tailwind's CDN can see literally in the output (no dynamic
  // composition at runtime) so JIT picks it up.
  accentBorder: string;
  accentText: string;
  emptyMessage: string;
}

const SERVICE_META: Record<ServiceKey, ServiceMeta> = {
  'netflix-household': {
    name: 'Netflix',
    accentBorder: 'border-red-600',
    accentText: 'text-red-500',
    emptyMessage: 'no household request pending',
  },
  disney: {
    name: 'Disney+',
    accentBorder: 'border-blue-600',
    accentText: 'text-blue-400',
    emptyMessage: 'no recent code',
  },
  max: {
    name: 'Max',
    accentBorder: 'border-purple-600',
    accentText: 'text-purple-400',
    emptyMessage: 'no recent code',
  },
};

/**
 * Escape the five characters that matter for HTML text + double-quoted
 * attributes. Applied to every user-controlled value rendered into the
 * page (codes, URLs, subjects, title, footer text).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Compute the countdown text and whether the window has expired.
 *
 * Pure, deterministic: only depends on the two inputs. Reused by the
 * server-side initial render AND by the test assertions — if we later
 * change the wording it stays consistent across both.
 *
 * Text format matches the client-side tick() function in the inline
 * `<script>` below so the transition between server-render and
 * first-JS-tick is seamless.
 */
export function formatCountdown(
  validUntil: string,
  now: Date,
): { text: string; expired: boolean } {
  const untilMs = Date.parse(validUntil);
  const deltaSec = Math.round((untilMs - now.getTime()) / 1000);
  if (deltaSec > 0) {
    const m = Math.floor(deltaSec / 60);
    const s = deltaSec % 60;
    return {
      text: `valid for ${m}m ${String(s).padStart(2, '0')}s`,
      expired: false,
    };
  }
  const expiredSec = -deltaSec;
  const m = Math.floor(expiredSec / 60);
  return { text: `expired ${m}m ago`, expired: true };
}

/**
 * "received Nm ago" text used below the code/link. Matches the
 * client-side tick() formatting.
 */
function formatReceivedAgo(receivedAt: string, now: Date): string {
  const receivedMs = Date.parse(receivedAt);
  const ageSec = Math.max(0, Math.round((now.getTime() - receivedMs) / 1000));
  const m = Math.floor(ageSec / 60);
  return m === 0 ? 'received just now' : `received ${m}m ago`;
}

function renderCountdownSpan(validUntil: string, now: Date): string {
  const { text, expired } = formatCountdown(validUntil, now);
  const expiredClass = expired ? ' text-red-500' : '';
  return (
    `<span data-valid-until="${escapeHtml(validUntil)}" ` +
    `class="text-sm text-gray-400${expiredClass}">${escapeHtml(text)}</span>`
  );
}

function renderReceivedSpan(receivedAt: string, now: Date): string {
  return (
    `<span data-received-at="${escapeHtml(receivedAt)}" ` +
    `class="text-xs text-gray-500">${escapeHtml(formatReceivedAgo(receivedAt, now))}</span>`
  );
}

function renderCodeCard(
  service: ServiceKey,
  entry: Extract<StoredEntry, { type: 'code' }>,
  now: Date,
): string {
  const meta = SERVICE_META[service];
  return [
    `<section data-service="${service}" class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm flex flex-col gap-3">`,
    `  <h2 class="text-sm uppercase tracking-wide ${meta.accentText} font-semibold">${escapeHtml(meta.name)}</h2>`,
    `  <button type="button" data-code="${escapeHtml(entry.value)}" onclick="copy(this)" `,
    `          class="font-mono text-4xl tracking-widest text-gray-100 bg-gray-800 rounded-md py-4 px-3 transition-colors">`,
    `    ${escapeHtml(entry.value)}`,
    `  </button>`,
    `  <div class="flex flex-col gap-1">`,
    `    ${renderCountdownSpan(entry.valid_until, now)}`,
    `    ${renderReceivedSpan(entry.received_at, now)}`,
    `  </div>`,
    `</section>`,
  ].join('\n');
}

function renderHouseholdCard(
  service: ServiceKey,
  entry: Extract<StoredEntry, { type: 'household' }>,
  now: Date,
): string {
  const meta = SERVICE_META[service];
  return [
    `<section data-service="${service}" class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm flex flex-col gap-3">`,
    `  <h2 class="text-sm uppercase tracking-wide ${meta.accentText} font-semibold">${escapeHtml(meta.name)}</h2>`,
    `  <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" `,
    `     class="block text-center font-semibold text-white bg-red-700 hover:bg-red-600 rounded-md py-3 px-4 transition-colors">`,
    `    Approve this device on Netflix`,
    `  </a>`,
    `  <div class="flex flex-col gap-1">`,
    `    ${renderCountdownSpan(entry.valid_until, now)}`,
    `    ${renderReceivedSpan(entry.received_at, now)}`,
    `  </div>`,
    `</section>`,
  ].join('\n');
}

function renderEmptyCard(service: ServiceKey): string {
  const meta = SERVICE_META[service];
  return [
    `<section data-service="${service}" class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm opacity-50 flex flex-col gap-2">`,
    `  <h2 class="text-sm uppercase tracking-wide ${meta.accentText} font-semibold">${escapeHtml(meta.name)}</h2>`,
    `  <p class="text-gray-400">${escapeHtml(meta.emptyMessage)}</p>`,
    `</section>`,
  ].join('\n');
}

function renderCard(
  service: ServiceKey,
  entry: StoredEntry | null,
  now: Date,
): string {
  if (entry === null) return renderEmptyCard(service);
  if (entry.type === 'code') return renderCodeCard(service, entry, now);
  return renderHouseholdCard(service, entry, now);
}

// Inline client-side script. Responsibilities:
//  1. copy(): tap-to-copy feedback on code buttons.
//  2. tick(): 1Hz refresh of relative-time strings on the countdown /
//     received-ago spans, without touching any other DOM state.
//  3. poll(): fetch('/api') every POLL_INTERVAL_MS (5s) and diff each
//     service's received_at against the section's current
//     data-received-at attribute. On change (including null↔entry
//     flip) the matching <section data-service="..."> is replaced via
//     outerHTML. Only cards whose received_at actually changed are
//     touched — scroll, focus, and any in-flight copy() animation on
//     other cards are preserved.
//
// The SERVICE_META object mirrors the server-side constant of the same
// name. We duplicate it here (rather than injecting it via data-*)
// because (a) it's only 3 services × 4 fields and (b) inlining keeps
// the diff surface obvious if the server-side copy ever changes.
//
// escapeHtml / initialCountdownText / initialReceivedText mirror the
// server helpers in this file so newly-rendered cards look identical
// to the server-rendered ones. The server is still the source of
// truth for the initial paint; the client copies exist only for the
// replacement path.
const CLIENT_SCRIPT = `
const POLL_INTERVAL_MS = 5000;
const SERVICE_META = {
  'netflix-household': { name: 'Netflix', accentBorder: 'border-red-600', accentText: 'text-red-500', emptyMessage: 'no household request pending' },
  'disney': { name: 'Disney+', accentBorder: 'border-blue-600', accentText: 'text-blue-400', emptyMessage: 'no recent code' },
  'max': { name: 'Max', accentBorder: 'border-purple-600', accentText: 'text-purple-400', emptyMessage: 'no recent code' },
};
function copy(el) {
  const code = el.dataset.code;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const prev = el.textContent;
    el.textContent = 'copied!';
    el.classList.add('bg-green-500/20');
    setTimeout(() => {
      el.textContent = prev;
      el.classList.remove('bg-green-500/20');
    }, 1500);
  }).catch(() => {
    // Clipboard API unavailable (HTTP context?) — silent.
  });
}
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-valid-until]').forEach((el) => {
    const until = Date.parse(el.dataset.validUntil);
    const deltaSec = Math.round((until - now) / 1000);
    if (deltaSec > 0) {
      const m = Math.floor(deltaSec / 60);
      const s = deltaSec % 60;
      el.textContent = 'valid for ' + m + 'm ' + String(s).padStart(2, '0') + 's';
      el.classList.remove('text-red-500');
    } else {
      const expiredSec = -deltaSec;
      const m = Math.floor(expiredSec / 60);
      el.textContent = 'expired ' + m + 'm ago';
      el.classList.add('text-red-500');
    }
  });
  document.querySelectorAll('[data-received-at]').forEach((el) => {
    const receivedMs = Date.parse(el.dataset.receivedAt);
    const ageSec = Math.max(0, Math.round((now - receivedMs) / 1000));
    const m = Math.floor(ageSec / 60);
    el.textContent = m === 0 ? 'received just now' : 'received ' + m + 'm ago';
  });
}
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function initialCountdownText(validUntil, now) {
  const delta = Math.round((Date.parse(validUntil) - now) / 1000);
  if (delta > 0) {
    const m = Math.floor(delta / 60);
    const s = delta % 60;
    return { text: 'valid for ' + m + 'm ' + String(s).padStart(2, '0') + 's', expired: false };
  }
  const expiredSec = -delta;
  const m = Math.floor(expiredSec / 60);
  return { text: 'expired ' + m + 'm ago', expired: true };
}
function initialReceivedText(receivedAt, now) {
  const ageSec = Math.max(0, Math.round((now - Date.parse(receivedAt)) / 1000));
  const m = Math.floor(ageSec / 60);
  return m === 0 ? 'received just now' : 'received ' + m + 'm ago';
}
function renderCardHTML(service, entry) {
  const meta = SERVICE_META[service];
  if (!meta) return '';
  if (!entry) {
    return '<section data-service="' + service + '" class="rounded-lg border-l-4 ' + meta.accentBorder + ' bg-gray-900 p-4 shadow-sm opacity-50 flex flex-col gap-2">' +
      '<h2 class="text-sm uppercase tracking-wide ' + meta.accentText + ' font-semibold">' + escapeAttr(meta.name) + '</h2>' +
      '<p class="text-gray-400">' + escapeAttr(meta.emptyMessage) + '</p>' +
      '</section>';
  }
  const now = Date.now();
  const cd = initialCountdownText(entry.valid_until, now);
  const expiredCls = cd.expired ? ' text-red-500' : '';
  const countdown = '<span data-valid-until="' + escapeAttr(entry.valid_until) + '" class="text-sm text-gray-400' + expiredCls + '">' + escapeAttr(cd.text) + '</span>';
  const received = '<span data-received-at="' + escapeAttr(entry.received_at) + '" class="text-xs text-gray-500">' + escapeAttr(initialReceivedText(entry.received_at, now)) + '</span>';
  const header = '<h2 class="text-sm uppercase tracking-wide ' + meta.accentText + ' font-semibold">' + escapeAttr(meta.name) + '</h2>';
  const shell = '<section data-service="' + service + '" class="rounded-lg border-l-4 ' + meta.accentBorder + ' bg-gray-900 p-4 shadow-sm flex flex-col gap-3">';
  const tail = '<div class="flex flex-col gap-1">' + countdown + received + '</div></section>';
  if (entry.type === 'code') {
    const button = '<button type="button" data-code="' + escapeAttr(entry.value) + '" onclick="copy(this)" class="font-mono text-4xl tracking-widest text-gray-100 bg-gray-800 rounded-md py-4 px-3 transition-colors">' + escapeAttr(entry.value) + '</button>';
    return shell + header + button + tail;
  }
  const link = '<a href="' + escapeAttr(entry.url) + '" target="_blank" rel="noopener noreferrer" class="block text-center font-semibold text-white bg-red-700 hover:bg-red-600 rounded-md py-3 px-4 transition-colors">Approve this device on Netflix</a>';
  return shell + header + link + tail;
}
function currentReceivedAt(section) {
  const el = section.querySelector('[data-received-at]');
  return el ? el.getAttribute('data-received-at') : null;
}
function poll() {
  fetch('/api', { cache: 'no-store' }).then((res) => {
    // 302 to Access login (session expired) lands here too — Access
    // serves HTML so JSON.parse would throw; treat any non-200 as
    // "skip this tick, stale DOM is fine".
    if (!res.ok) return null;
    return res.json();
  }).then((data) => {
    if (!data) return;
    let changed = false;
    Object.keys(SERVICE_META).forEach((service) => {
      const section = document.querySelector('[data-service="' + service + '"]');
      if (!section) return;
      const entry = data[service] || null;
      const newReceivedAt = entry ? entry.received_at : null;
      if (currentReceivedAt(section) !== newReceivedAt) {
        section.outerHTML = renderCardHTML(service, entry);
        changed = true;
      }
    });
    // Only call tick() when something moved — a no-op tick would just
    // rewrite spans to their current text, wasted work but not wrong.
    if (changed) tick();
  }).catch((e) => {
    // Network blip, JSON parse error, etc. Keep polling on the next
    // interval. Stale DOM + ticking countdown is an acceptable state.
    console.warn('poll failed', e);
  });
}
tick();
setInterval(tick, 1000);
setInterval(poll, POLL_INTERVAL_MS);
`.trim();

/**
 * Render the full HTML document for the dashboard.
 *
 * The returned string is a complete, self-contained `<!DOCTYPE html>`
 * document. Fetch handler wraps it in a Response with a
 * `text/html; charset=utf-8` content type and a restrictive CSP header.
 */
export function renderDashboard(data: DashboardData): string {
  const cards = DISPLAY_ORDER.map((service) =>
    renderCard(service, data.entries[service], data.now),
  ).join('\n');

  const footerLine =
    data.footerText.length > 0
      ? `    <p class="text-sm text-gray-400">${escapeHtml(data.footerText)}</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="300">
  <title>${escapeHtml(data.title)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <main class="max-w-md mx-auto px-4 py-6 flex flex-col gap-4">
    <header class="mb-2">
      <h1 class="text-2xl font-bold">${escapeHtml(data.title)}</h1>
    </header>
${cards}
    <footer class="mt-6 text-center">
${footerLine}
      <p class="text-xs text-gray-500 mt-4">
        <a href="https://github.com/ignaciohermosillacornejo/otp-please" class="hover:underline">otp-please</a>
      </p>
    </footer>
  </main>
  <script>
${CLIENT_SCRIPT}
  </script>
</body>
</html>`;
}
