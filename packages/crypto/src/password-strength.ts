/**
 * How good is this password, and is it good enough to protect a calendar with?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO EXIST HERE, AND WHY NOTHING ELSE CATCHES IT
 * ---------------------------------------------------------------------------
 *
 * CloakCal never sends the real password anywhere. `deriveMasterSecret` runs Argon2id and
 * only the derived `authSecret` reaches Supabase. That is the right design, and it has a
 * consequence nobody had written down: **every server-side password protection Supabase
 * offers is inert here.** Its leaked-password check compares against HaveIBeenPwned, and what
 * it would be comparing is a 256-bit Argon2id output that appears in no breach corpus. It
 * will pass, always, for any password including "password".
 *
 * So the only gate was `minLength={10}` on an HTML input — bypassable from devtools, and
 * absent entirely for any non-form caller of `initializeCloak`.
 *
 * That matters more here than in an ordinary app. Elsewhere a weak password risks one
 * account, and the server can rate-limit, lock out and alert. Here the password derives the
 * key that decrypts the content, so a weak one is not a weak lock on a strong box — it IS
 * the strength of the encryption. An attacker with the ciphertext can grind offline at their
 * own pace, and Argon2id buys a work factor, not a miracle.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT zxcvbn
 * ---------------------------------------------------------------------------
 *
 * It is the right tool for scoring passwords and it is ~800KB with its dictionaries. This
 * package is loaded on the sign-up path of a privacy app where the whole point is that
 * cryptography happens before anything is sent, so page weight is real. What is implemented
 * below is deliberately cruder and honest about it: it catches the failures that actually
 * happen — too short, one repeated character, a keyboard run, a single dictionary-ish word,
 * the site's own name — and it does not pretend to estimate guess counts.
 *
 * A crude check that ships beats an accurate one that does not.
 */

export type PasswordVerdict = 'unusable' | 'weak' | 'fair' | 'strong'

export interface PasswordAssessment {
  readonly verdict: PasswordVerdict
  /** Plain-language, addressed to the person typing. Empty when strong. */
  readonly problems: readonly string[]
  /** False blocks sign-up. `weak` and above is allowed through with a warning. */
  readonly acceptable: boolean
}

/**
 * Twelve, not eight.
 *
 * Eight is the number people cite because NIST 800-63B sets it as an absolute floor for
 * server-verified secrets — where the server can rate-limit and lock out. Neither is
 * available against an offline attack on a wrap, so the floor has to be higher.
 */
const MINIMUM_LENGTH = 12

/** Rows as typed, including shifted digits, so "qwerty" and "1qaz" both get caught. */
const KEYBOARD_RUNS = [
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '1234567890',
  'abcdefghijklmnopqrstuvwxyz',
]

/**
 * Not a dictionary — a short list of what people actually type into a calendar app's sign-up
 * form. A real wordlist belongs in zxcvbn; this catches the cases that would be embarrassing.
 */
const OBVIOUS = [
  'password',
  'passw0rd',
  'letmein',
  'welcome',
  'admin',
  'qwerty',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'trustno1',
  'cloakcal',
  'calendar',
  'changeme',
  'secret',
]

const hasRun = (lower: string): boolean => {
  for (const row of KEYBOARD_RUNS) {
    for (let i = 0; i + 4 <= row.length; i += 1) {
      const run = row.slice(i, i + 4)
      if (lower.includes(run) || lower.includes([...run].reverse().join(''))) return true
    }
  }
  return false
}

export function assessPassword(password: string, email = ''): PasswordAssessment {
  const problems: string[] = []
  const lower = password.toLowerCase()

  if (password.length < MINIMUM_LENGTH) {
    problems.push(`Use at least ${MINIMUM_LENGTH} characters. Longer beats complicated.`)
  }

  // A single repeated character passes any length check and has almost no entropy.
  if (password.length > 0 && new Set(password).size <= Math.max(2, password.length / 6)) {
    problems.push('This repeats the same few characters.')
  }

  if (hasRun(lower)) {
    problems.push('This contains a run of keys straight off the keyboard.')
  }

  for (const word of OBVIOUS) {
    if (lower.includes(word)) {
      problems.push(`"${word}" is one of the first things anyone guesses.`)
      break
    }
  }

  // The email is the KDF salt, so an attacker targeting this account already has it. A
  // password built from it adds nothing they do not already know.
  const localPart = email.split('@')[0]?.toLowerCase() ?? ''
  if (localPart.length >= 4 && lower.includes(localPart)) {
    problems.push('This contains your email address, which an attacker already knows.')
  }

  if (password.length === 0) {
    return { verdict: 'unusable', problems: ['A password is required.'], acceptable: false }
  }

  // Length is the dominant term and nothing else comes close, so the scale is mostly length
  // with the specific failures above able to knock it back down.
  const verdict: PasswordVerdict =
    problems.length > 0
      ? password.length < MINIMUM_LENGTH
        ? 'unusable'
        : 'weak'
      : password.length >= 20
        ? 'strong'
        : password.length >= 16
          ? 'strong'
          : 'fair'

  return {
    verdict,
    problems,
    // `weak` passes. This blocks the genuinely broken and warns about the rest, because a
    // strength meter that refuses a password the user has already chosen and written down
    // teaches people to add "1!" to the end, which helps nobody.
    acceptable: verdict !== 'unusable',
  }
}
