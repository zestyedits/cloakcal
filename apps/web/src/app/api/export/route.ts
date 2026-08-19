import { getExportBundle } from '@/server/export'

/**
 * The whole account's SEALED events, for the browser to turn into an .ics.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RETURNS CIPHERTEXT AND NOT A FILE
 * ---------------------------------------------------------------------------
 *
 * The obvious shape — `GET /api/export` returning `text/calendar` — is the one thing this
 * cannot be. Building the file means reading titles, locations and notes, and the server
 * cannot read them (rule 1, rule 2) and must never be able to. So the route hands over the
 * same sealed bytes the calendar page already serves, and the browser assembles the file
 * after decrypting them with a key that never leaves it.
 *
 * That is exactly what the privacy policy claims — "assembled in your browser from your own
 * decrypted content, so the file will hold things our servers have never seen" — and this
 * route is the half of that sentence which makes it true rather than aspirational.
 *
 * WHY A ROUTE AND NOT PROPS ON /settings. Passing the bundle down from the Settings page
 * would load every event in the account on every visit to a page that is mostly toggles.
 * Fetched on click, it costs nothing until somebody actually exports.
 *
 * NO NEW EXPOSURE. This is the caller's own ciphertext, read under their own session through
 * RLS, and it is the same material already sent to the same browser by the calendar. There is
 * no service-role key here and no way to ask for somebody else's workspace: `getExportBundle`
 * takes no id and resolves the workspace from the session.
 *
 * `middleware.ts` answers 401 for an unauthenticated `/api/*` rather than redirecting, so a
 * signed-out fetch here fails as JSON instead of arriving as a page of HTML — see the
 * `guardFor()` note in CLAUDE.md.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const bundle = await getExportBundle()

  return Response.json(bundle, {
    headers: {
      // Never cached, anywhere. A shared cache holding one account's ciphertext keyed by a
      // path with no user in it is the shape of a cross-account leak, even though the bytes
      // are sealed.
      'Cache-Control': 'no-store, private',
    },
  })
}
