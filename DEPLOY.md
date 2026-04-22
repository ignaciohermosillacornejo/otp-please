# Deploy runbook

Instructions for anyone (Claude included) picking up `otp-please` and
shipping a change. Deliberately manual — this Worker has no CI deploy
step, because a personal OTP relay doesn't justify the complexity of a
push-to-main pipeline plus API-token secret management.

## What's already wired up for you

- **`.claude/settings.json`** enables the `cloudflare@cloudflare` plugin
  bundle. Launching Claude Code in this directory auto-loads these MCP
  servers (after the one-time "allow plugin?" prompt):
  - `cloudflare-observability` — query the Worker's structured logs.
    The single most useful MCP here; see the query recipe below.
  - `cloudflare-bindings` — inspect KV namespaces / other bindings
    without leaving the session.
  - `cloudflare-api` — one-shot reads against the REST API (Access
    policies, Email Routing rules, zone DNS, etc.).
  - `cloudflare-docs` — docs search grounded in Cloudflare's current
    reference. Prefer it over recalled-from-training answers for
    anything Workers- or Email-Routing-specific.
  - `cloudflare-builds` — returns empty for this Worker (no Workers
    Builds config; we deploy via `wrangler` CLI). Still enabled in
    case the project migrates later.
- **`wrangler.toml`** holds the public config: name, routes, KV binding
  id, observability, non-secret vars. Secrets are NOT in this file.
- **`.dev.vars.example`** documents the env vars `wrangler dev` needs.
  Copy to `.dev.vars` locally for dev; never commit real values.

## Local dev

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in TRUSTED_FORWARDER etc.
npm run test                     # vitest, ~300ms
npm run typecheck
npx wrangler dev                 # local Worker, no KV/email triggers
```

`wrangler dev` cannot receive real inbound mail — Email Routing only
runs in production. For email-handler changes, unit tests (which drive
`ForwardableEmailMessage` test doubles) are the fast-feedback loop.

## Shipping a change

1. Branch: `git checkout -b <type>/<slug>`. **Do not edit on `main`.**
2. Write the change + tests. Keep coverage ~100% on `src/index.ts`
   (the email handler is the load-bearing path).
3. `npm test && npx tsc --noEmit` — both must be green.
4. Push, open a PR. The `.github/workflows/claude-review.yml` action
   will run AI review; if the repo owner opens it, auto-approve +
   auto-merge fire after the review comments land.
5. `gh pr merge <n> --squash --delete-branch` once reviews clear.
6. **Deploy manually** (there is no post-merge deploy workflow):

   ```sh
   git checkout main && git pull
   npx wrangler deploy
   ```

   Expected output names the bindings, the uploaded size, the custom
   domain trigger, and a new `Current Version ID`. Note that ID — it's
   how you correlate the next smoke test's logs to this deploy.

7. Smoke test: forward a real OTP email (HBO Max / Disney+ / Netflix)
   from the configured Gmail account. The dashboard at
   `codes.ignaciohermosilla.com` should refresh within seconds.
   Verify via the observability query below that an `info: stored …`
   event landed under the new version id.

## Secrets

All secrets live as Worker secrets, not in `wrangler.toml` or the
repo.

- `TRUSTED_FORWARDER` — the Gmail address the owner's filter forwards
  from. Gmail dot-normalization means `foo.bar@gmail.com` and
  `foobar@gmail.com` compare equal, but setting the canonical form the
  account actually sends as (check the Email Routing Activity tab for
  recent envelope-from values) keeps logs readable.

  ```sh
  npx wrangler secret put TRUSTED_FORWARDER
  ```

No other secrets are required.

## Confirming a deploy via logs

Structured log events are queryable through the
`cloudflare-observability` MCP. Useful recipe for "did my deploy land
and is it ingesting mail cleanly?":

- `view: events`
- filter `$metadata.service = otp-please`
- filter `$metadata.message regex ^(info:|skip:|err:)`
- timeframe `-30m`

`info: stored …` = mail ingested + KV write succeeded. `skip: …` =
envelope rejected or no parser matched (verbose diagnostics are
attached — envelope-from, configured-forwarder, the parsed subject).
`err: …` = KV outage path. Zero `skip:` / `err:` in a 30-min window
after a smoke test means the deploy is healthy.

The `scriptVersion.id` on each event matches the `Current Version ID`
printed by `wrangler deploy` — use it to tell post-deploy events apart
from pre-deploy ones.

## Threat-model reminder

The Worker trusts `message.from` (the SMTP envelope-from) directly,
after Gmail-dot / case normalization, against `TRUSTED_FORWARDER`.
**Cloudflare's receiving MTA has already verified SPF** for that
envelope — CF would not have delivered the message otherwise. We do
**not** parse `Authentication-Results` in the Worker, because CF Email
Routing does not surface a fresh Authentication-Results header. An
earlier iteration of the Worker did, and silently rejected every
legitimate forward. If you find yourself reaching for header parsing,
re-read the JSDoc on `verifyForwarder` in `src/index.ts`.

## Operator pitfalls seen in the field

- **Low-traffic private Worker → aggressive logs are fine.** The
  `skip:` path dumps raw + normalized envelope values and all inbound
  header names. Only the extracted OTP code and the Netflix household
  URL token are ever redacted. Do not dial this back "for safety" —
  the owner has explicitly chosen this tradeoff, and diagnosing a
  parser-drift bug without it is painful.
- **Gmail canonical-form drift.** The owner's envelope-from alternates
  between `hermosillaignacio@` and `hermosilla.ignacio@` forms. If a
  forward ever stops flowing, check the Email Routing Activity tab for
  the current envelope — if it's shifted to a form outside the
  configured dot-normalization (e.g. a `+alias` tag), update
  `TRUSTED_FORWARDER`.
- **`wrangler dev` cannot exercise the email handler.** It has no
  `ForwardableEmailMessage` shim. Trust the unit tests and deploy to
  production to smoke-test real mail flow.
- **`workers_builds_list_builds` returns empty** on this Worker. Not a
  bug — there's no Workers Builds config. The deploy-is-healthy signal
  is the observability query above, not Workers Builds.
