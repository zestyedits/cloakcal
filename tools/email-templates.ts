/**
 * The transactional emails, branded.
 *
 * Supabase ships plain unstyled defaults — a bare sentence and a naked link. They work, and
 * they look exactly like the phishing they will be mistaken for.
 *
 * ---------------------------------------------------------------------------
 * NO REMOTE IMAGES. NOT EVEN THE LOGO.
 * ---------------------------------------------------------------------------
 *
 * The obvious way to brand an email is an `<img>` pointing at cloakcal.com. Two reasons not
 * to, and the second is the real one:
 *
 *   1. Most clients block remote images by default, so the header would usually render as a
 *      broken box — worse branding than none.
 *   2. A remote image in an email IS a tracking pixel. Loading it tells the sender the
 *      message was opened, from roughly where, and on what. That is the standard read-receipt
 *      mechanism, and shipping one from a privacy product would be indefensible even though
 *      we would not look at the logs.
 *
 * So the mark is a text wordmark. It always renders, it cannot be blocked, and it phones
 * nobody. Colour does the brand work.
 *
 * ---------------------------------------------------------------------------
 * TABLES AND INLINE STYLES
 * ---------------------------------------------------------------------------
 *
 * Email clients are not browsers. No external stylesheet, no custom properties, no flexbox
 * worth relying on, and Outlook drops `background-color` on a `<div>` — hence `bgcolor` on
 * tables. This looks like 2005 HTML because that is what renders in Outlook in 2026.
 *
 * Dark-first, matching the app, with explicit colours everywhere so a client that tries to
 * auto-invert has nothing to guess at.
 */

const NAVY = '#0b0d14'
const CARD = '#161a25'
const BORDER = '#2a2f45'
const TEXT = '#f5f6fa'
const MUTED = '#b4b7c4'
const LAVENDER = '#b8b0ff'
/** The accessible accent, not brand indigo: white sits on this button. */
const ACCENT = '#6152e6'

interface Shell {
  readonly preheader: string
  readonly heading: string
  /** Paragraphs of HTML, already escaped. */
  readonly body: string
  readonly buttonLabel: string
  readonly footnote: string
}

/**
 * `{{ .ConfirmationURL }}` is substituted by GoTrue, so it is written literally rather than
 * interpolated here. Anything else in these templates is a constant.
 */
const shell = ({ preheader, heading, body, buttonLabel, footnote }: Shell): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>CloakCal</title>
</head>
<body style="margin:0;padding:0;background-color:${NAVY};">
<!-- Preheader: the grey line a client shows next to the subject. Hidden in the body itself,
     because otherwise it reads as a duplicated first sentence. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NAVY}" style="background-color:${NAVY};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr>
          <td style="padding:0 0 24px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:${TEXT};">
            Cloak<span style="color:${LAVENDER};">Cal</span>
          </td>
        </tr>
        <tr>
          <td bgcolor="${CARD}" style="background-color:${CARD};border:1px solid ${BORDER};border-radius:14px;padding:32px;">
            <h1 style="margin:0 0 16px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:24px;line-height:1.25;font-weight:600;color:${TEXT};">${heading}</h1>
            ${body}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px 0;">
              <tr>
                <td bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:10px;">
                  <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:14px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${buttonLabel}</a>
                </td>
              </tr>
            </table>
            <p style="margin:16px 0 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${MUTED};">
              Button not working? Paste this into your browser:<br>
              <span style="color:${LAVENDER};word-break:break-all;">{{ .ConfirmationURL }}</span>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0 4px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${MUTED};">
            ${footnote}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

const p = (html: string) =>
  `<p style="margin:0 0 14px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:${MUTED};">${html}</p>`

const strong = (text: string) => `<strong style="color:${TEXT};">${text}</strong>`

/**
 * Password reset.
 *
 * TWO WARNINGS THAT ARE NOT BOILERPLATE, both learned from someone hitting them:
 *
 *   The recovery phrase. CloakCal cannot reset a password the way an ordinary app can — the
 *   password derives the key that opens your events, so a reset re-wraps that key rather than
 *   overwriting a hash. Without the 24 words there is nothing to re-wrap. Somebody who clicks
 *   through and only then discovers they need a phrase they never wrote down has been failed
 *   by this email, not by the form.
 *
 *   The same-browser rule. The link is PKCE, so completing it needs a verifier stored in the
 *   browser that asked. Opening it on a phone after requesting it on a laptop cannot work.
 *   Better said here than discovered on the landing page.
 */
export const RECOVERY_SUBJECT = 'Reset your CloakCal password'

export const RECOVERY_HTML = shell({
  preheader: 'You will need your 24-word recovery phrase to finish.',
  heading: 'Reset your password',
  body:
    p('Someone asked to reset the password for this CloakCal account. If that was not you, ignore this email and nothing changes.') +
    p(
      `You will need your ${strong('24-word recovery phrase')}, the words you wrote down when you set up your calendar. ` +
        'CloakCal cannot reset your password without them: your password unlocks your events, so we are re-wrapping that key rather than resetting a login. We do not have a copy.',
    ) +
    p(`Open this link ${strong('in the same browser you requested it from')}. It expires in an hour and works once.`),
  buttonLabel: 'Set a new password',
  footnote:
    'CloakCal encrypts your event details in your browser. We store times in the clear, because a calendar cannot place, repeat or lay out an event without them, and we say so plainly: we are not zero-knowledge. If you did not request this, no action is needed.',
})

/** Sign-up confirmation. */
export const CONFIRMATION_SUBJECT = 'Confirm your email for CloakCal'

export const CONFIRMATION_HTML = shell({
  preheader: 'One click, then your keys are created on your device.',
  heading: 'Confirm your email',
  body:
    p('Welcome to CloakCal. Confirm this address to finish setting up your calendar.') +
    p(
      `After you sign in, your encryption keys are created ${strong('on your device')} and you will be shown a 24-word recovery phrase. ` +
        'Write it down somewhere safe before you go any further. It is the only way back into your calendar if you forget your password, and we cannot send you another copy.',
    ),
  buttonLabel: 'Confirm email',
  footnote:
    'If you did not sign up for CloakCal, ignore this email and no account will be created.',
})
