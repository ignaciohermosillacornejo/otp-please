// Local preview generator — renders the dashboard at every interesting
// lifecycle state so the visual can be eyeballed without deploying.
// Run with: npx tsx scripts/preview.ts
//
// Each bezel in the gallery pairs a state name with a one-line
// description of what you're looking at. States run the full
// code-lifetime arc: fresh → dwindling → about-to-expire → expired-in-
// grace → past-grace (filtered) plus household and mixed variants.
import { writeFileSync, mkdirSync } from 'node:fs';

import { renderDashboard, type DashboardData } from '../src/dashboard';
import { filterStaleEntries } from '../src/kv';
import type { ServiceKey } from '../src/parser';
import type { StoredEntry } from '../src/kv';

const NOW = new Date('2026-04-22T14:30:00Z');
const at = (sec: number) => new Date(NOW.getTime() + sec * 1000).toISOString();

type EntryMap = Record<ServiceKey, StoredEntry | null>;

function code(
  service: ServiceKey,
  value: string,
  receivedOffsetSec: number,
  validUntilOffsetSec: number,
): StoredEntry {
  return {
    type: 'code',
    service,
    value,
    received_at: at(receivedOffsetSec),
    valid_until: at(validUntilOffsetSec),
    subject: 'verification code',
  };
}

function household(
  receivedOffsetSec: number,
  validUntilOffsetSec: number,
): StoredEntry {
  return {
    type: 'household',
    service: 'netflix-household',
    url: 'https://www.netflix.com/account/travel/AbC123_exampleToken',
    received_at: at(receivedOffsetSec),
    valid_until: at(validUntilOffsetSec),
    subject: 'Your Netflix household',
  };
}

function empty(): EntryMap {
  return { 'netflix-household': null, disney: null, max: null };
}

interface State {
  key: string;
  label: string;
  entries: EntryMap;
  footerText?: string;
}

const STATES: State[] = [
  {
    key: 'all-fresh',
    label: 'all three fresh — rings full',
    entries: {
      'netflix-household': household(-60, 14 * 60),
      disney: code('disney', '284193', -30, 13 * 60 + 42),
      max: code('max', '619027', -90, 12 * 60 + 5),
    },
  },
  {
    key: 'code-dwindling',
    label: 'disney at ~4m left — ring draining',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -11 * 60, 4 * 60 + 12),
    },
  },
  {
    key: 'about-to-expire',
    label: 'max at 45s — countdown in seconds, ring nearly empty',
    entries: {
      ...empty(),
      max: code('max', '619027', -14 * 60 - 15, 45),
    },
  },
  {
    key: 'just-expired',
    label: 'disney expired 1m ago — ring gone, red timer',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -16 * 60, -60),
    },
  },
  {
    key: 'deep-in-grace',
    label: 'disney expired 45m ago — still shown, still within grace',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -60 * 60, -45 * 60),
    },
  },
  {
    key: 'past-grace',
    label: 'disney expired 2h ago — filtered out, card empty',
    entries: {
      ...empty(),
      // KV still has it; filterStaleEntries below drops it and the
      // dashboard renders the empty state. This is the "no sense
      // showing expired 600m ago" scenario.
      disney: code('disney', '284193', -3 * 60 * 60, -2 * 60 * 60),
    },
  },
  {
    key: 'household-solo',
    label: 'netflix household alone — approval link, no codes',
    entries: {
      ...empty(),
      'netflix-household': household(-120, 11 * 60 + 18),
    },
  },
  {
    key: 'mixed-lifecycle',
    label: 'fresh + dwindling + expired — one of each',
    entries: {
      'netflix-household': household(-60, 13 * 60),
      disney: code('disney', '284193', -12 * 60, 2 * 60 + 40),
      max: code('max', '619027', -16 * 60, -50),
    },
  },
  {
    key: 'empty',
    label: 'nothing waiting — quiet home state',
    entries: empty(),
    footerText: 'para la familia Hermosilla',
  },
];

mkdirSync('/tmp/otp-preview', { recursive: true });

const panels = STATES.map((state) => {
  // Route through the same grace-window filter the Worker fetch
  // handler uses, so the preview reflects what a real client would
  // see — not what KV literally holds.
  const entries = filterStaleEntries(state.entries, NOW);
  const data: DashboardData = {
    title: 'Family Codes',
    footerText: state.footerText ?? 'para la familia Hermosilla',
    now: NOW,
    entries,
  };
  const html = renderDashboard(data);
  const path = `/tmp/otp-preview/${state.key}.html`;
  writeFileSync(path, html);
  return { key: state.key, label: state.label, path };
});

const gallery = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Family Codes — lifecycle gallery</title>
  <style>
    html, body { margin: 0; background: #e9e4dc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #2a2520; }
    header { padding: 48px 40px 8px; max-width: 1800px; margin: 0 auto; }
    h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.3px; }
    p.sub { margin: 6px 0 0; color: #6b625a; font-size: 14px; }
    .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #6b625a; margin-bottom: 10px; }
    .row { display: grid; grid-template-columns: repeat(auto-fill, minmax(410px, 1fr)); gap: 36px 32px; padding: 32px 40px 64px; max-width: 1800px; margin: 0 auto; }
    .panel { display: flex; flex-direction: column; gap: 12px; align-items: center; }
    .bezel {
      width: 390px; height: 780px; border-radius: 44px; padding: 12px;
      background: #0c0a08; box-shadow: 0 30px 80px -30px rgba(0,0,0,0.45), 0 2px 0 rgba(255,255,255,0.04) inset;
    }
    .bezel iframe { width: 100%; height: 100%; border: 0; border-radius: 32px; background: #1a1714; }
    .meta { text-align: center; max-width: 380px; }
    .key { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #8a7f74; text-transform: uppercase; letter-spacing: 0.08em; }
    .label { font-size: 14px; color: #2a2520; font-weight: 500; margin-top: 2px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">Family Codes — lifecycle gallery</div>
    <h1>codes.ignaciohermosilla.com</h1>
    <p class="sub">every state the dashboard cycles through as a code ages — rendered by src/dashboard.ts @ ${NOW.toISOString()}</p>
  </header>
  <div class="row">
    ${panels
      .map(
        (p) => `
    <div class="panel">
      <div class="bezel"><iframe src="file://${p.path}"></iframe></div>
      <div class="meta">
        <div class="key">${p.key}</div>
        <div class="label">${p.label}</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>
</body>
</html>`;

writeFileSync('/tmp/otp-preview/gallery.html', gallery);
console.log('wrote', panels.length, 'states →', '/tmp/otp-preview/gallery.html');
