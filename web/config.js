// Public settings of the site. Nothing secret here: a Turnstile site key is public by design.
// The production values are filled in after the Worker is deployed (docs/architecture.md, «Развёртывание сервера»).
const local = globalThis.location?.hostname === 'localhost';

export const API_BASE = local ? 'http://localhost:8787' : '';

// On localhost: Cloudflare's test key, the check always passes.
export const TURNSTILE_SITE_KEY = local ? '1x00000000000000000000AA' : '';
