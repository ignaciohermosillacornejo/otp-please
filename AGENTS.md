# AGENTS.md

Entry point for AI coding agents (Claude Code, Copilot CLI, etc.) picking
up this repo. If you are a human, start with [README.md](./README.md); if
you are shipping a change, follow [DEPLOY.md](./DEPLOY.md).

## What this is

A Cloudflare Email Worker + dashboard that relays streaming-service OTPs
from the account owner's Gmail to family members, gated by Cloudflare
Access. See [README.md](./README.md) for the product story.

- **Runtime**: Cloudflare Workers (TypeScript, `postal-mime` for MIME parsing)
- **Storage**: Workers KV (`OTP_STORE` binding), 1h grace TTL per entry
- **Inbound path**: Gmail filter → CF Email Routing → Email Worker → KV
- **Outbound path**: `fetch()` → dashboard HTML, gated by CF Access
- **Deploy**: manual `npx wrangler deploy` (no Workers Builds, no CI deploy)

## MCP servers already wired up

`.claude/settings.json` is committed and enables the `cloudflare@cloudflare`
plugin bundle. Launching Claude Code in this directory auto-loads these MCP
servers after the one-time "allow plugin?" prompt:

| MCP | Use for |
| --- | --- |
| `cloudflare-observability` | Query the Worker's structured logs. Primary signal for "did it work?". |
| `cloudflare-bindings` | Create/inspect KV namespaces (and R2, D1, etc.) without leaving the session. |
| `cloudflare-api` | One-shot REST reads — Access policies, Email Routing rules, DNS, zones. |
| `cloudflare-docs` | Docs search grounded in current Cloudflare reference. Prefer over training. |
| `cloudflare-builds` | Empty for this Worker (no Workers Builds config). Kept enabled in case we migrate later. |

Bias toward retrieval from these MCPs over pre-trained knowledge —
Cloudflare product surfaces move faster than model cutoffs.

## Bootstrapping infra from scratch

If you're standing the whole thing up in a clean Cloudflare account:

1. **Log in** — `npx wrangler login`. Requires browser OAuth; ask the
   operator to complete if running headless.
2. **Create the KV namespace** — either `npx wrangler kv namespace create
   OTP_STORE` from the CLI, or via the `cloudflare-bindings` MCP. Paste the
   returned id into `wrangler.toml` (`kv_namespaces[0].id`).
3. **Set the `TRUSTED_FORWARDER` secret** — `npx wrangler secret put
   TRUSTED_FORWARDER`, value = the owner's Gmail address. This is the
   single load-bearing secret; no other `wrangler secret put` is needed.
4. **Deploy** — `npx wrangler deploy`. Note the `Current Version ID` it
   prints; you'll correlate smoke-test logs to this id.
5. **Email Routing** (Cloudflare dashboard or `cloudflare-api` MCP):
   - Enable Email Routing on the zone (provisions MX records).
   - Route `codes@<zone>` → Worker `otp-please`.
   - Route `*@<zone>` → personal inbox as a catch-all safety net.
6. **Gmail** — the forwarding filter is a manual operator step; agents
   cannot automate Gmail settings. Point the operator at
   [README.md steps 7–8](./README.md#setup).
7. **Cloudflare Access** (dashboard or `cloudflare-api` MCP):
   - Self-hosted app on the Worker hostname.
   - Google OAuth IdP; policy = email allowlist of family Gmail addresses.
   - **Bypass rule**: path `/healthz` — uptime probes must not need a cookie.

Full human-facing walkthrough: [README.md §Setup](./README.md#setup).
Ongoing deploy runbook: [DEPLOY.md](./DEPLOY.md).

## Anti-patterns — do not revive

These have been tried. They failed. The reasons are in the code comments
and commit history; do not re-introduce them without reading that context.

- **Do NOT parse `Authentication-Results` in the Worker.** CF Email Routing
  does not forward a fresh Authentication-Results header; an earlier
  version of `verifyForwarder` parsed it and silently rejected every
  legitimate forward. The load-bearing signal is CF's pre-delivery SPF,
  asserted by the fact that `email()` was invoked at all. See the JSDoc on
  `verifyForwarder` in `src/index.ts`.
- **Do NOT dial back the `skip:` path logs.** This is a low-traffic
  private Worker; aggressive envelope/header logging is a deliberate
  tradeoff for debuggability. Only the extracted OTP code and the Netflix
  household URL token are ever redacted.
- **Do NOT retry on failed KV writes.** CF does not re-invoke `email()` on
  a Worker exception, and that's intentional — we drop a code rather than
  risk double-delivering one after a partial put.
- **Do NOT commit secrets to `wrangler.toml`.** Only `TRUSTED_FORWARDER`
  is a secret; it lives as a Worker secret, not in a `[vars]` block.
- **Do NOT enable "Skip the Inbox" on the Gmail filter.** The original
  email must stay in the inbox as an audit trail and manual fallback.

## Testing

```sh
npm ci
npm test            # vitest, ~300ms
npm run typecheck   # checks both tsconfig.json and tsconfig.test.json
```

Unit tests drive `ForwardableEmailMessage` test doubles — `wrangler dev`
cannot exercise the email handler, so tests are the fast-feedback loop.
Keep coverage on `src/index.ts` near 100%; it's the load-bearing path.

When adding a new service, follow
[README.md §Adding a new service](./README.md#adding-a-new-service). Drop a
sanitized `.eml` fixture into `test/fixtures/` (obviously-fake values like
`123456` or `FAKE_TRAVEL_TOKEN_0002`) and add a parser test.

## Confirming a change via logs

Structured events are queryable through the `cloudflare-observability` MCP.
Useful filter for "did my deploy land and is it ingesting mail cleanly?":

- `view: events`
- `$metadata.service = otp-please`
- `$metadata.message regex ^(info:|skip:|err:)`
- timeframe `-30m`

- `info: stored …` — mail ingested, KV write succeeded.
- `skip: …` — envelope rejected or no parser matched; verbose diagnostics
  attached (envelope-from, configured-forwarder, parsed subject).
- `err: …` — KV outage path.

The `scriptVersion.id` on each event matches the `Current Version ID`
printed by `wrangler deploy` — use it to tell post-deploy events apart
from pre-deploy ones.
