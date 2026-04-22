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
  // `string | undefined`, not `string`, because Worker secrets that
  // were never `wrangler secret put`'d arrive as literal `undefined`
  // at runtime. Modeling it honestly pushes the guard requirement up
  // to every call site that the compiler can see, rather than relying
  // on a comment inside verifyForwarder.
  TRUSTED_FORWARDER: string | undefined;
}
