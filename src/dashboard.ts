// Mobile-first dashboard renderer. Pure function: takes a snapshot of
// per-service entries plus Env-derived config and returns a complete
// HTML document string. No I/O and no Date.now() calls inside —
// `data.now` is injected so the server-rendered countdown text is
// deterministic and testable.
//
// Visual design is the "warm paper dark" direction — background is a
// near-black charcoal biased slightly amber, codes are the brightest
// thing on the page, per-service accent is carried only on the small
// badge + countdown ring. System font stack only (no web fonts) so
// the page has nothing to block on.
//
// Freshness strategy is two-layered:
//   1. Client-side poll of /api every POLL_INTERVAL_MS (5s). When a
//      service's received_at changes (or flips null↔entry) the matching
//      <section data-service="..."> is replaced in place. Scroll, mid-
//      flight copy feedback on other cards, and the 1Hz countdown tick
//      are preserved.
//   2. A widened <meta http-equiv="refresh" content="300"> as a
//      last-ditch fallback for the case where JS silently died (e.g.
//      tab backgrounded for days and the runtime throttled it into
//      oblivion). 300s is long enough not to interrupt normal use and
//      short enough to self-heal within a single sitting.

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
  badge: string;
  accent: string;
  accentSoft: string;
  emptySub: string;
}

// Three muted accents, all at chroma=0.14, lightness=0.72 — the only
// thing that changes is hue. Carried on badges + countdown rings +
// (for netflix-household) the approve-link background.
const SERVICE_META: Record<ServiceKey, ServiceMeta> = {
  'netflix-household': {
    name: 'Netflix',
    badge: 'N',
    accent: 'oklch(0.72 0.14 28)',
    accentSoft: 'oklch(0.72 0.14 28 / 0.18)',
    emptySub: 'no household request pending',
  },
  disney: {
    name: 'Disney+',
    badge: 'D+',
    accent: 'oklch(0.72 0.14 245)',
    accentSoft: 'oklch(0.72 0.14 245 / 0.18)',
    emptySub: 'you’ll see it here when it arrives',
  },
  max: {
    name: 'Max',
    badge: 'M',
    accent: 'oklch(0.72 0.14 310)',
    accentSoft: 'oklch(0.72 0.14 310 / 0.18)',
    emptySub: 'you’ll see it here when it arrives',
  },
};

// Shared red for "expired" countdown text. Same hue as Netflix's
// accent — an expired code is an alarm, and the Netflix accent
// already reads as one.
const EXPIRED_COLOR = 'oklch(0.72 0.14 28)';

/**
 * Gate a URL against the set of schemes safe to put in an `href`.
 * Returns the URL as-is iff it parses and its protocol is `https:`,
 * otherwise returns `"#"`.
 *
 * `escapeHtml` is not sufficient here: `javascript:alert(1)` contains
 * no HTML-special characters, so it would pass escapeHtml unchanged
 * into an href attribute and become a clickable XSS gadget. We can
 * reach this point only if a malformed URL somehow landed in KV
 * (parser regression, compromised trusted forwarder, etc.) — but the
 * check is defense-in-depth, and it's cheap.
 */
export function safeHref(url: string): string {
  try {
    return new URL(url).protocol === 'https:' ? url : '#';
  } catch {
    return '#';
  }
}

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
  if (expired) {
    return (
      `<span data-valid-until="${escapeHtml(validUntil)}" ` +
      `class="text-[12px] tabular-nums font-medium" ` +
      `style="color:${EXPIRED_COLOR}">${escapeHtml(text)}</span>`
    );
  }
  return (
    `<span data-valid-until="${escapeHtml(validUntil)}" ` +
    `class="text-[12px] tabular-nums text-stone-400">${escapeHtml(text)}</span>`
  );
}

function renderReceivedSpan(receivedAt: string, now: Date): string {
  return (
    `<span data-received-at="${escapeHtml(receivedAt)}" ` +
    `class="text-[12px] text-stone-500 tabular-nums">` +
    `${escapeHtml(formatReceivedAgo(receivedAt, now))}</span>`
  );
}

// Tiny service badge — rounded square with the brand initial painted
// in the accent color over a soft-accent background. NOT the brand's
// logo; our own interpretation so we don't need licensed artwork.
function renderServiceBadge(meta: ServiceMeta): string {
  return (
    `<span class="inline-flex shrink-0 items-center justify-center rounded-[6px] ` +
    `font-semibold text-[12px] tabular-nums" ` +
    `style="width:26px;height:26px;background:${meta.accentSoft};color:${meta.accent}">` +
    `${escapeHtml(meta.badge)}</span>`
  );
}

// Small 16px clipboard glyph shown on the right side of code cards.
// Flipped to a "Copied" pill on tap by the inline script.
const COPY_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
  '<path d="M5 15V5a2 2 0 0 1 2-2h10"/>' +
  '</svg>';

// External-link arrow used on the "Approve on Netflix" button.
const EXTERNAL_LINK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';

// Split a digit string in half with a single space so 6-digit codes
// read as two groups of three ("284 193"). For odd lengths the first
// group is the longer one.
function splitCode(value: string): string {
  const mid = Math.ceil(value.length / 2);
  return value.slice(0, mid) + ' ' + value.slice(mid);
}

function renderCodeCard(
  service: ServiceKey,
  entry: Extract<StoredEntry, { type: 'code' }>,
  now: Date,
): string {
  const meta = SERVICE_META[service];
  const display = splitCode(String(entry.value));
  return [
    `<section data-service="${service}" class="contents">`,
    `  <button type="button" data-code="${escapeHtml(entry.value)}" onclick="copy(this)"`,
    `          aria-label="Copy code ${escapeHtml(entry.value)}"`,
    `          class="group text-left w-full rounded-[16px] bg-[oklch(0.22_0.012_55)] px-4 py-3.5 active:scale-[0.995] transition flex flex-col gap-1">`,
    `    <div class="flex items-center gap-2.5">`,
    `      ${renderServiceBadge(meta)}`,
    `      <span class="text-[15px] font-semibold text-stone-100">${escapeHtml(meta.name)}</span>`,
    `      <span class="ml-auto text-stone-500" data-copy-hint>${COPY_ICON_SVG}</span>`,
    `    </div>`,
    `    <div class="flex items-center gap-3">`,
    `      <span class="font-semibold text-[40px] leading-[1.05] tabular-nums tracking-[-0.01em] text-stone-50 flex-1">${escapeHtml(display)}</span>`,
    `    </div>`,
    `    <div class="flex items-center justify-between pt-0.5">`,
    `      ${renderReceivedSpan(entry.received_at, now)}`,
    `      ${renderCountdownSpan(entry.valid_until, now)}`,
    `    </div>`,
    `  </button>`,
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
    `<section data-service="${service}" class="rounded-[16px] bg-[oklch(0.22_0.012_55)] px-4 py-3.5 flex flex-col gap-2">`,
    `  <div class="flex items-center gap-2.5">`,
    `    ${renderServiceBadge(meta)}`,
    `    <span class="text-[15px] font-semibold text-stone-100">${escapeHtml(meta.name)}</span>`,
    `    <span class="ml-auto text-[11px] uppercase tracking-[0.14em] text-stone-500">household</span>`,
    `  </div>`,
    `  <p class="text-stone-300 text-[14px] leading-snug">Someone wants to watch from a new place.</p>`,
    `  <a href="${escapeHtml(safeHref(entry.url))}" target="_blank" rel="noopener noreferrer"`,
    `     class="mt-1 flex items-center justify-between gap-2 rounded-[10px] px-4 py-2.5 font-medium text-[14px] text-stone-950 active:opacity-90 transition"`,
    `     style="background:${meta.accent}">`,
    `    <span>Approve on ${escapeHtml(meta.name)}</span>`,
    `    ${EXTERNAL_LINK_SVG}`,
    `  </a>`,
    `  <div class="flex items-center justify-between pt-0.5">`,
    `    ${renderReceivedSpan(entry.received_at, now)}`,
    `    ${renderCountdownSpan(entry.valid_until, now)}`,
    `  </div>`,
    `</section>`,
  ].join('\n');
}

function renderEmptyCard(service: ServiceKey): string {
  const meta = SERVICE_META[service];
  return [
    `<section data-service="${service}" class="rounded-[16px] border border-stone-800/70 px-4 py-3.5 flex items-center gap-3">`,
    `  ${renderServiceBadge(meta)}`,
    `  <div class="flex flex-col gap-0.5 min-w-0">`,
    `    <span class="text-[15px] font-semibold text-stone-300">${escapeHtml(meta.name)}</span>`,
    `    <span class="text-[12px] text-stone-500 truncate">${escapeHtml(meta.emptySub)}</span>`,
    `  </div>`,
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
//  1. copy(): tap-to-copy feedback on code buttons. Swaps the clipboard
//     glyph for a small "Copied" pill in the service accent for ~1.4s.
//  2. tick(): 1Hz refresh of relative-time strings on countdown /
//     received spans AND of the countdown ring's stroke-dashoffset +
//     center-label, without touching any other DOM state.
//  3. poll(): fetch('/api') every POLL_INTERVAL_MS (5s) and diff each
//     service's received_at against the section's current
//     data-received-at attribute. On change (including null↔entry
//     flip) the matching <section data-service="..."> is replaced via
//     outerHTML. Only cards whose received_at actually changed are
//     touched.
//
// The SERVICE_META object mirrors the server-side constant of the same
// name. We duplicate it here (rather than injecting it via data-*)
// because (a) it's only 3 services × 5 fields and (b) inlining keeps
// the diff surface obvious if the server-side copy ever changes.
const CLIENT_SCRIPT = `
const POLL_INTERVAL_MS = 5000;
const EXPIRED_COLOR = 'oklch(0.72 0.14 28)';
const SERVICE_META = {
  'netflix-household': { name: 'Netflix', badge: 'N', accent: 'oklch(0.72 0.14 28)',  accentSoft: 'oklch(0.72 0.14 28 / 0.18)',  emptySub: 'no household request pending' },
  'disney':            { name: 'Disney+', badge: 'D+', accent: 'oklch(0.72 0.14 245)', accentSoft: 'oklch(0.72 0.14 245 / 0.18)', emptySub: 'you\\u2019ll see it here when it arrives' },
  'max':               { name: 'Max',     badge: 'M', accent: 'oklch(0.72 0.14 310)', accentSoft: 'oklch(0.72 0.14 310 / 0.18)', emptySub: 'you\\u2019ll see it here when it arrives' },
};
const COPY_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const EXTERNAL_LINK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeHref(url) {
  // Mirror of src/dashboard.ts safeHref — only https:// passes; anything
  // else collapses to '#'. Used by the poll re-render path when a
  // fresh household entry replaces an earlier one.
  try {
    return new URL(url).protocol === 'https:' ? url : '#';
  } catch {
    return '#';
  }
}
function splitCode(value) {
  const v = String(value);
  const mid = Math.ceil(v.length / 2);
  return v.slice(0, mid) + ' ' + v.slice(mid);
}
function copy(el) {
  const code = el.dataset.code;
  if (!code) return;
  const hint = el.querySelector('[data-copy-hint]');
  const flash = (html, ms) => {
    if (!hint) return;
    hint.dataset.flash = '1';
    hint.innerHTML = html;
    setTimeout(() => {
      hint.dataset.flash = '0';
      hint.innerHTML = COPY_ICON_SVG;
    }, ms);
  };
  const done = () => flash('<span class="text-[11px] font-medium uppercase tracking-[0.12em]" style="color:oklch(0.78 0.14 150)">Copied</span>', 1400);
  // Red pill mirroring the "Copied" green one so a clipboard rejection
  // (permission denied, insecure context, fenced frame, etc.) is
  // actually visible — silently swallowing the rejection left the
  // button looking idle and the user thinking the copy succeeded.
  const failed = () => flash('<span class="text-[11px] font-medium uppercase tracking-[0.12em]" style="color:oklch(0.72 0.14 28)">Tap &amp; hold</span>', 1800);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(failed);
  } else {
    failed();
  }
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
      el.classList.remove('font-medium');
      el.classList.add('text-stone-400');
      el.style.color = '';
    } else {
      const expiredSec = -deltaSec;
      const m = Math.floor(expiredSec / 60);
      el.textContent = 'expired ' + m + 'm ago';
      el.classList.remove('text-stone-400');
      el.classList.add('font-medium');
      el.style.color = EXPIRED_COLOR;
    }
  });
  document.querySelectorAll('[data-received-at]').forEach((el) => {
    const receivedMs = Date.parse(el.dataset.receivedAt);
    const ageSec = Math.max(0, Math.round((now - receivedMs) / 1000));
    const m = Math.floor(ageSec / 60);
    el.textContent = m === 0 ? 'received just now' : 'received ' + m + 'm ago';
  });
}
function renderBadge(meta) {
  return '<span class="inline-flex shrink-0 items-center justify-center rounded-[6px] font-semibold text-[12px] tabular-nums" style="width:26px;height:26px;background:' + meta.accentSoft + ';color:' + meta.accent + '">' + escapeAttr(meta.badge) + '</span>';
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
function countdownSpan(validUntil, now) {
  const cd = initialCountdownText(validUntil, now);
  if (cd.expired) {
    return '<span data-valid-until="' + escapeAttr(validUntil) + '" class="text-[12px] tabular-nums font-medium" style="color:' + EXPIRED_COLOR + '">' + escapeAttr(cd.text) + '</span>';
  }
  return '<span data-valid-until="' + escapeAttr(validUntil) + '" class="text-[12px] tabular-nums text-stone-400">' + escapeAttr(cd.text) + '</span>';
}
function receivedSpan(receivedAt, now) {
  return '<span data-received-at="' + escapeAttr(receivedAt) + '" class="text-[12px] text-stone-500 tabular-nums">' + escapeAttr(initialReceivedText(receivedAt, now)) + '</span>';
}
function renderCardHTML(service, entry) {
  const meta = SERVICE_META[service];
  if (!meta) return '';
  if (!entry) {
    return '<section data-service="' + service + '" class="rounded-[16px] border border-stone-800/70 px-4 py-3.5 flex items-center gap-3">' +
      renderBadge(meta) +
      '<div class="flex flex-col gap-0.5 min-w-0">' +
        '<span class="text-[15px] font-semibold text-stone-300">' + escapeAttr(meta.name) + '</span>' +
        '<span class="text-[12px] text-stone-500 truncate">' + escapeAttr(meta.emptySub) + '</span>' +
      '</div>' +
    '</section>';
  }
  const now = Date.now();
  if (entry.type === 'code') {
    const display = splitCode(entry.value);
    return '<section data-service="' + service + '" class="contents">' +
      '<button type="button" data-code="' + escapeAttr(entry.value) + '" onclick="copy(this)" aria-label="Copy code ' + escapeAttr(entry.value) + '" class="group text-left w-full rounded-[16px] bg-[oklch(0.22_0.012_55)] px-4 py-3.5 active:scale-[0.995] transition flex flex-col gap-1">' +
        '<div class="flex items-center gap-2.5">' +
          renderBadge(meta) +
          '<span class="text-[15px] font-semibold text-stone-100">' + escapeAttr(meta.name) + '</span>' +
          '<span class="ml-auto text-stone-500" data-copy-hint>' + COPY_ICON_SVG + '</span>' +
        '</div>' +
        '<div class="flex items-center gap-3">' +
          '<span class="font-semibold text-[40px] leading-[1.05] tabular-nums tracking-[-0.01em] text-stone-50 flex-1">' + escapeAttr(display) + '</span>' +
        '</div>' +
        '<div class="flex items-center justify-between pt-0.5">' +
          receivedSpan(entry.received_at, now) +
          countdownSpan(entry.valid_until, now) +
        '</div>' +
      '</button>' +
    '</section>';
  }
  return '<section data-service="' + service + '" class="rounded-[16px] bg-[oklch(0.22_0.012_55)] px-4 py-3.5 flex flex-col gap-2">' +
    '<div class="flex items-center gap-2.5">' +
      renderBadge(meta) +
      '<span class="text-[15px] font-semibold text-stone-100">' + escapeAttr(meta.name) + '</span>' +
      '<span class="ml-auto text-[11px] uppercase tracking-[0.14em] text-stone-500">household</span>' +
    '</div>' +
    '<p class="text-stone-300 text-[14px] leading-snug">Someone wants to watch from a new place.</p>' +
    '<a href="' + escapeAttr(safeHref(entry.url)) + '" target="_blank" rel="noopener noreferrer" class="mt-1 flex items-center justify-between gap-2 rounded-[10px] px-4 py-2.5 font-medium text-[14px] text-stone-950 active:opacity-90 transition" style="background:' + meta.accent + '">' +
      '<span>Approve on ' + escapeAttr(meta.name) + '</span>' + EXTERNAL_LINK_SVG +
    '</a>' +
    '<div class="flex items-center justify-between pt-0.5">' +
      receivedSpan(entry.received_at, now) +
      countdownSpan(entry.valid_until, now) +
    '</div>' +
  '</section>';
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
      const entry = data[service] ?? null;
      const newReceivedAt = entry ? entry.received_at : null;
      if (currentReceivedAt(section) !== newReceivedAt) {
        section.outerHTML = renderCardHTML(service, entry);
        changed = true;
      }
    });
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
      ? `      <p class="text-[12px] text-stone-500 text-center">${escapeHtml(data.footerText)}</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#1a1714">
  <meta http-equiv="refresh" content="300">
  <title>${escapeHtml(data.title)}</title>
  <link rel="icon" type="image/png" href="https://raw.githubusercontent.com/ignaciohermosillacornejo/otp-please/main/assets/logo.png">
  <link rel="apple-touch-icon" href="https://raw.githubusercontent.com/ignaciohermosillacornejo/otp-please/main/assets/logo.png">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-[oklch(0.18_0.008_55)] text-stone-100 antialiased" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <main class="max-w-md mx-auto px-4 pt-8 pb-10 flex flex-col gap-2.5">
    <header class="pb-2 px-1">
      <h1 class="text-[22px] font-semibold tracking-tight text-stone-100">${escapeHtml(data.title)}</h1>
    </header>
    <div class="text-[11px] uppercase tracking-[0.14em] text-stone-500 px-1 pb-0.5">codes</div>
${cards}
    <footer class="mt-6 flex flex-col gap-1.5 items-center">
${footerLine}
      <p class="text-[10px] uppercase tracking-[0.16em] text-stone-600">
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
