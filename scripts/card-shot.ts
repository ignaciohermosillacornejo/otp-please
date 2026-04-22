// Render a single card (by default the first one — the Netflix household
// approve link) on a matching dashboard background. Used to produce
// tight social-post screenshots of an individual card.
//
// Mechanism: call renderDashboard() with only one entry populated, then
// extract the first card's <section> via a literal substring match on
// the `data-service="..."` anchor. Wrapping the section in the same
// max-w-md container + warm-paper-dark background gives a pixel-
// identical rendering to what the card looks like in the live page.
//
// Run: npx tsx scripts/card-shot.ts
import { writeFileSync, mkdirSync } from 'node:fs';

import { renderDashboard, type DashboardData } from '../src/dashboard';
import type { StoredEntry } from '../src/kv';

const NOW = new Date();
const at = (sec: number) => new Date(NOW.getTime() + sec * 1000).toISOString();

const householdEntry: StoredEntry = {
  type: 'household',
  service: 'netflix-household',
  url: 'https://www.netflix.com/account/travel/AbC123_exampleToken',
  received_at: at(-2 * 60),
  valid_until: at(20 * 60),
  subject: 'Your Netflix household',
};

const data: DashboardData = {
  title: 'Family Codes',
  footerText: '',
  now: NOW,
  entries: {
    'netflix-household': householdEntry,
    disney: null,
    max: null,
  },
};

// Find the first card's <section>…</section>. The renderer always
// stamps data-service="<key>" on each card, so this anchor is stable.
const fullHtml = renderDashboard(data);
const sectionMatch = fullHtml.match(
  /<section data-service="netflix-household"[\s\S]*?<\/section>/,
);
if (!sectionMatch) throw new Error('could not locate first-card section');
const cardHtml = sectionMatch[0];

// Minimal page: same background, same padding as the real dashboard,
// but no header / eyebrow / footer so the card stands alone.
const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#1a1714">
  <title>Netflix household card</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[oklch(0.18_0.008_55)] text-stone-100 antialiased" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px">
  <div class="max-w-md mx-auto">
    ${cardHtml}
  </div>
</body>
</html>`;

mkdirSync('/tmp/otp-preview/shots', { recursive: true });
writeFileSync('/tmp/otp-preview/card.html', page);
console.log('wrote /tmp/otp-preview/card.html');
