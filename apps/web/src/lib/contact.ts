/**
 * The one way in, as data.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO CONTACT FORM, WRITTEN DOWN SO NOBODY HAS TO REDERIVE IT.
 *
 * A form is the default answer and it is the wrong one for this product, for four reasons
 * that are specific rather than stylistic:
 *
 *   1. IT IS A PLAINTEXT INGESTION POINT ON A PRODUCT WHOSE ARCHITECTURE IS THAT THERE ARE
 *      NONE. Every other free-text field a user types into is sealed in the browser before it
 *      leaves (rule 2). A form body arrives at our server readable, and the first thing
 *      somebody types into it is the thing they came here to hide: "my event 'oncology 3pm
 *      Tuesday' will not save". A mailto never touches our servers at all, and the message
 *      sits in a mailbox the user already chose.
 *
 *   2. SPAM HANDLING WOULD COST THE CSP. A public POST endpoint needs a captcha or a rate
 *      limiter. Every captcha is a third-party script, and `script-src` carries neither
 *      'unsafe-inline' nor an external origin on purpose, in a product whose threat model is
 *      that XSS equals reading somebody's calendar. Widening that policy to keep robots out
 *      of an inbox is the worst trade available. A rate limiter needs shared state, and the
 *      only store here is Postgres, where the alternative is an `anon`-insertable table on a
 *      database whose entire posture is that `anon` can write nothing (see 0025).
 *
 *   3. IT WOULD MAKE DELETION REQUESTS LESS VERIFIABLE, NOT MORE. `auth.users` is unreachable
 *      in-band, so deletion is a human acting on a request, and the only evidence a request is
 *      yours is that it came FROM the address you sign in with. A form's email field is a
 *      free-text claim anybody can type. The mailto is the stronger authentication of the two,
 *      which is the opposite of how it looks.
 *
 *   4. A FORM IMPLIES A TICKET. People expect a submission to enter a queue that something
 *      tracks and answers. There is one person here. An email leaves the sender holding a copy
 *      in their own Sent folder and a thread they can chase, which is more accountability than
 *      a POST that returns "thanks" and vanishes.
 *
 * THE ONE REAL WEAKNESS OF A MAILTO IS THAT IT CAN DO NOTHING on a machine with no mail client
 * registered, which is most webmail users on a desktop: the link is clicked and the page just
 * sits there. The fix for that is not an endpoint, it is TYPOGRAPHY — the address is rendered
 * as the link's own text, so select-and-copy always works even when the click does not, and
 * the contact page says so in a sentence. Zero infrastructure, and it closes the only gap.
 *
 * If a form is ever built anyway, the hard constraint is in the task that wrote this file and
 * in `legal-claims.server.test.ts`: what it collects, where that goes and how long it is kept
 * has to land in `lib/legal.ts` in the SAME change.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * NOT `lib/legal.ts`, deliberately, even though the address used to live there. That module is
 * PROSE — `legal-claims.server.test.ts` excludes it from the source sweep by name, precisely so
 * a claim can never be its own evidence. An address and a route are facts the app acts on, so
 * they have to sit somewhere a capability check is allowed to look. legal.ts imports from here.
 */

/**
 * THE support address, in one place, because four surfaces print it now.
 *
 * Deletion is by email and has to stay that way. That makes this address the whole mechanism
 * behind a statutory obligation, and an address that drifts between the terms, the contact
 * page and the settings page is a deletion request sent somewhere nobody reads.
 */
export const SUPPORT_EMAIL = 'hello@cloakcal.com'

/**
 * Named once and used in four places: the route, the page's own metadata, `PUBLIC_PATHS`, and
 * every link into it. Same shape as `WEBHOOK_PATH` in middleware.ts, and for the same reason —
 * a path spelled by hand in five files is a 404 waiting for a rename.
 */
export const CONTACT_PATH = '/contact'

/**
 * A mailto with the subject line filled in.
 *
 * ENCODED, which the one hand-rolled call site this replaced was not. Bare spaces in a
 * `mailto:` query survive most clients and are still wrong per RFC 6068; the moment a subject
 * gains an ampersand it silently truncates.
 *
 * SUBJECTS ARE DELIBERATELY GENERIC AND CARRY NOTHING ABOUT THE SENDER. A subject line is the
 * one part of an email that is readable at every hop and is what shows in a notification on a
 * lock screen, so it never gets an account id, an address or anything about what the message
 * is really concerning.
 *
 * Every link fills one in, including the plain address, and that is for the RECEIVING end: one
 * person with one inbox and no helpdesk gets a filterable tag on arrival at no cost to the
 * sender, who can still overwrite it. It is the closest thing to routing this design has, and
 * it needs no software.
 */
export function mailtoFor(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`
}

/** The subject `/settings/security` pre-fills, and the one the contact page repeats. */
export const DELETE_ACCOUNT_SUBJECT = 'Delete my account'
