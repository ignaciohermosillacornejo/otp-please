import type { KVNamespace } from '@cloudflare/workers-types';

// Shape of the Worker's `env` object. Matches [[kv_namespaces]] + [vars]
// in wrangler.toml. Keep this in sync with the toml — there is no
// runtime check that the two agree, so a mismatch manifests as a
// TypeScript error at the first `env.X` access.
export interface Env {
  OTP_STORE: KVNamespace;
  TIMEZONE: string;
  DASHBOARD_TITLE: string;
  FOOTER_TEXT: string;
  TRUSTED_FORWARDER: string;
}
