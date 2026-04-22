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

// Anchor to real wall-clock time so the server-rendered text agrees
// with the in-browser tick() for ~seconds after load — otherwise the
// "valid for 15m 00s" text gets overwritten by whatever the browser
// computes against a frozen ISO baseline, showing nonsense like "448m".
const NOW = new Date();
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

// "valid for" times are kept at round minute values (no 3m42s oddities)
// so each bezel reads as one clean snapshot of the state, not a frozen
// moment from some larger timeline.
const MIN = 60;
const HR = 60 * MIN;

const STATES: State[] = [
  {
    key: 'hero',
    label: 'netflix 20m · disney expired 5m ago · max 22m',
    entries: {
      'netflix-household': household(-2 * MIN, 20 * MIN),
      disney: code('disney', '284193', -20 * MIN, -5 * MIN),
      max: code('max', '619027', -3 * MIN, 22 * MIN),
    },
  },
  {
    key: 'all-fresh',
    label: 'all three fresh — 15m remaining',
    entries: {
      'netflix-household': household(-1 * MIN, 15 * MIN),
      disney: code('disney', '284193', -1 * MIN, 15 * MIN),
      max: code('max', '619027', -1 * MIN, 15 * MIN),
    },
  },
  {
    key: 'code-dwindling',
    label: 'disney at 5m left',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -10 * MIN, 5 * MIN),
    },
  },
  {
    key: 'about-to-expire',
    label: 'max at 45s — countdown in seconds',
    entries: {
      ...empty(),
      max: code('max', '619027', -14 * MIN - 15, 45),
    },
  },
  {
    key: 'just-expired',
    label: 'disney expired 1m ago — red timer',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -16 * MIN, -1 * MIN),
    },
  },
  {
    key: 'deep-in-grace',
    label: 'disney expired 45m ago — still within grace',
    entries: {
      ...empty(),
      disney: code('disney', '284193', -60 * MIN, -45 * MIN),
    },
  },
  {
    key: 'past-grace',
    label: 'disney expired 2h ago — filtered out',
    entries: {
      ...empty(),
      // KV still has it; filterStaleEntries below drops it and the
      // dashboard renders the empty state. This is the "no sense
      // showing expired 600m ago" scenario.
      disney: code('disney', '284193', -3 * HR, -2 * HR),
    },
  },
  {
    key: 'household-solo',
    label: 'netflix household alone — 15m to approve',
    entries: {
      ...empty(),
      'netflix-household': household(-2 * MIN, 15 * MIN),
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
