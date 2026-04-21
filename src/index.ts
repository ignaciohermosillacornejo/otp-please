// TODO(index): wire email handler + fetch handler (dashboard) against Env bindings.
export default {
  async email(_message: ForwardableEmailMessage, _env: unknown, _ctx: ExecutionContext): Promise<void> {
    // TODO(index): parse incoming email, extract OTP, write to KV.
    return;
  },
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    // TODO(index): serve the Access-gated dashboard.
    return new Response('Not Implemented', { status: 501 });
  },
} satisfies ExportedHandler;
