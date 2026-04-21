// Mobile-first dashboard renderer. Pure function: takes a snapshot of
// per-service entries plus Env-derived config and returns a complete
// HTML document string. No I/O and no Date.now() calls inside —
// `data.now` is injected so the server-rendered countdown text is
// deterministic and testable.
//
// Design notes:
//  - Single-file output (no external bundle) so the Worker can serve
//    it directly. The only third-party asset is Tailwind's CDN.
//  - Meta-refresh every 30s so expired rows eventually vanish even if
//    the user never interacts. A per-second JS tick keeps the visible
//    countdowns fresh between full reloads.
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
  'netflix',
  'netflix-household',
  'disney',
  'max',
  'amazon',
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
  netflix: {
    name: 'Netflix',
    accentBorder: 'border-red-600',
    accentText: 'text-red-500',
    emptyMessage: 'no recent code',
  },
  'netflix-household': {
    name: 'Netflix Household',
    accentBorder: 'border-red-800',
    accentText: 'text-red-400',
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
  amazon: {
    name: 'Prime Video',
    accentBorder: 'border-sky-500',
    accentText: 'text-sky-400',
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
    `<section class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm flex flex-col gap-3">`,
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
    `<section class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm flex flex-col gap-3">`,
    `  <h2 class="text-sm uppercase tracking-wide ${meta.accentText} font-semibold">${escapeHtml(meta.name)}</h2>`,
    `  <p class="text-xs text-amber-300 bg-amber-900/30 border border-amber-800 rounded-md p-3 leading-relaxed">`,
    `    This link only works from a device on the home network. If you're traveling, ask someone at home to open this dashboard and tap the link.`,
    `  </p>`,
    `  <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener" `,
    `     class="block text-center font-semibold text-white bg-red-700 hover:bg-red-600 rounded-md py-3 px-4 transition-colors">`,
    `    Open household link`,
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
    `<section class="rounded-lg border-l-4 ${meta.accentBorder} bg-gray-900 p-4 shadow-sm opacity-50 flex flex-col gap-2">`,
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

// Inline client-side script. Kept small and readable — it does only two
// things: (1) tap-to-copy feedback and (2) a 1Hz tick that updates the
// relative time strings. Full-page refresh every 30s (meta http-equiv)
// handles eventual cleanup of expired cards.
const CLIENT_SCRIPT = `
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
tick();
setInterval(tick, 1000);
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
  <meta http-equiv="refresh" content="30">
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
