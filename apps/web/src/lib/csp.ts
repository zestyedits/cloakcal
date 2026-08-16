/**
 * The Content-Security-Policy, as a pure function.
 *
 * WHY THIS MATTERS MORE HERE THAN IN A NORMAL APP. CloakCal decrypts in the browser: the root
 * key, every derived field key and every plaintext title exist only on the client. So an XSS
 * is not a defacement or a session theft, it is total compromise of the one thing rule 1
 * promises — an attacker running script in this origin reads everything the user can read,
 * and the server-side guarantees (RLS, the policy engine, the leak tests) are all irrelevant
 * to them. A per-response nonce is ASVS V3.4.3's L3 requirement and it is the right bar.
 *
 * IT IS A FUNCTION, NOT A STRING IN MIDDLEWARE, so the PRODUCTION policy can be asserted
 * without running a server. That is not tidiness: the e2e suite exercises the DEV policy
 * (Playwright runs `next dev`), and dev has to be looser — React Refresh needs `unsafe-eval`
 * and HMR needs a websocket. Without a unit-testable production string, the only policy any
 * test ever saw would be the one that is deliberately weaker.
 */

/** Where the nonce rides from middleware to the root layout. */
export const NONCE_HEADER = 'x-nonce'

/**
 * 128 bits, base64. `getRandomValues` and `btoa` rather than Node's `crypto`/`Buffer`,
 * because middleware runs on the Edge runtime where neither exists.
 */
export function createNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

export interface CspOptions {
  /** Dev needs `unsafe-eval` for React Refresh and a websocket for HMR. Production gets neither. */
  readonly dev: boolean
  /** `NEXT_PUBLIC_SUPABASE_URL`. Absent on CI, where no Supabase variables are set. */
  readonly supabaseUrl: string | undefined
}

export function buildCsp(nonce: string, { dev, supabaseUrl }: CspOptions): string {
  /*
   * connect-src IS THE ONE THAT BREAKS EVERYTHING, and it breaks quietly.
   *
   * Every read and write in this product goes to Supabase from the BROWSER — rule 4 means
   * there is no server-side service client to fall back to. Omit the origin here and the app
   * still renders, still hydrates, and then every query fails as an opaque network error with
   * no mention of CSP outside the console. No test in this repo can catch it either: the
   * fixture never calls Supabase at all, so the whole e2e suite passes against a policy that
   * would break every real account. Only a live-account pass sees it.
   *
   * Both schemes, because `wss:` is a separate origin to CSP and Supabase Realtime would
   * otherwise be blocked the day anything starts using it.
   */
  const supabaseOrigins: string[] = []
  if (supabaseUrl !== undefined && supabaseUrl !== '') {
    try {
      const { origin, host } = new URL(supabaseUrl)
      supabaseOrigins.push(origin, `wss://${host}`)
    } catch {
      // A malformed URL degrades to 'self' rather than emitting a broken directive, which
      // would fail the whole policy open in some browsers and closed in others.
    }
  }

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],

    /*
     * 'strict-dynamic' is what makes the nonce worth having. Without it, `script-src 'self'`
     * trusts every path on this origin, and any endpoint that reflects attacker input into a
     * .js response becomes a bypass. With it, host allowlists are IGNORED in supporting
     * browsers and only the nonced root scripts plus what they themselves load can execute.
     * `'self'` stays for browsers that do not implement strict-dynamic.
     */
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // React Refresh compiles with eval. Dev only, asserted absent in production.
      ...(dev ? ["'unsafe-eval'"] : []),
    ],

    /*
     * 'unsafe-inline' for STYLE, stated plainly rather than buried.
     *
     * Next inlines critical CSS into the document and next/font emits an inline <style>, and
     * neither is nonce-able from here. This is a real weakening and it is the standard trade:
     * style injection can reskin a page and can exfiltrate some data through selectors, but
     * it cannot read a key out of memory. Script is where the compromise lives.
     *
     * Do NOT "fix" a broken page by moving this pattern into script-src.
     */
    'style-src': ["'self'", "'unsafe-inline'"],

    // data: because every brand asset is a data URI (see docs/brand.md); blob: for canvas.
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],

    'connect-src': [
      "'self'",
      ...supabaseOrigins,
      // HMR's socket. `ws:` unqualified, because the dev host varies (localhost, 127.0.0.1,
      // and whatever Playwright picks).
      ...(dev ? ['ws:', 'wss:'] : []),
    ],

    // Nothing here is ever framed, and clickjacking a calendar that reveals content on hover
    // is a real attack rather than a theoretical one.
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],

    // Stops an injected <base> silently repointing every relative script URL.
    'base-uri': ["'self'"],
    // A form that POSTs a password somewhere else is the one thing worth pinning on the auth
    // pages specifically.
    'form-action': ["'self'"],

    'manifest-src': ["'self'"],
    // blob: — Next emits worker bundles from blobs.
    'worker-src': ["'self'", 'blob:'],
  }

  const serialised = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')

  // Not in dev: it would rewrite http://localhost to https and make the dev server
  // unreachable. Production is HTTPS-only behind Vercel anyway, so this is belt and braces
  // for any absolute http:// URL that sneaks into a bundle.
  return dev ? serialised : `${serialised}; upgrade-insecure-requests`
}

/**
 * The other headers worth setting while we are here.
 *
 * Deliberately short. `X-XSS-Protection` is omitted because it is deprecated and its legacy
 * filter introduced vulnerabilities of its own, and `X-Frame-Options` is omitted because
 * `frame-ancestors` above supersedes it in every browser this app supports.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // The MIME-sniffing guard. Relevant here because ciphertext is served as JSON and a sniffed
  // content type is one way a response becomes executable.
  ['X-Content-Type-Options', 'nosniff'],
  // Referrers leak. A calendar URL carries `?as=` audience ids and will carry booking tokens.
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  // Nothing in this product needs any of these, and saying so is cheap.
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
]
