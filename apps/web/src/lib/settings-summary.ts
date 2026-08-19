import type { SettingsSummary } from './settings-sections'

/**
 * THE HUB'S FOUR LINES, composed from numbers.
 *
 * Split out of `server/settings.ts` for two reasons, and the second is the important one.
 *
 * FIRST: it could not be run. `loadSettingsSummary` needs a session and a workspace row, and
 * every Playwright project runs against the committed fixture, which has neither — so the hub
 * shows "Demo" on every line and not one character of this composition had ever executed. The
 * strings a signed-in user actually reads were unreachable by every test in the repo. Here
 * they are ordinary input and output.
 *
 * SECOND, and structural: THE PARAMETER TYPE IS THE GUARANTEE THAT NO LABEL REACHES THE HUB.
 * Everything below is a `number`, plus two strings that are Tier A by definition — an IANA
 * timezone, which the server stores in the clear because it frames every render, and a plan
 * name, which comes from the catalog in `lib/plans.ts` and is the same for every account.
 * There is no parameter a calendar name, a contact name or a group label could arrive in.
 *
 * That matters because the hub's whole shape depends on it. It is a plain server component
 * with no CloakProvider and no client JavaScript, which is only possible while it renders
 * nothing sealed. The obvious future request — "make the Calendar line say WHICH calendars" —
 * has two wrong answers (re-add the provider, or ask the server for a name it structurally
 * cannot read) and this signature makes both of them a compile error rather than a review
 * catch.
 */
export interface SettingsCounts {
  /** Active calendars in the workspace. */
  readonly calendars: number
  readonly contacts: number
  /** WORKSPACE-scoped rules only, never per-event ones. See the loader for why. */
  readonly workspaceRules: number
  readonly passkeys: number
  /** An IANA zone, stored in plaintext because it frames every render (rule 1, plan D1). */
  readonly timezone: string
  /** From the catalog, identical for every account on that tier. */
  readonly planName: string
}

const plural = (value: number, one: string, many: string): string =>
  `${value} ${value === 1 ? one : many}`

export function summariseSettings(counts: SettingsCounts): SettingsSummary {
  return {
    /*
     * "Nobody yet" rather than "0 people · 0 default rules". A zero is a true answer to a
     * question nobody asked; the door is there to say whether there is anything to look at.
     */
    privacy:
      counts.contacts === 0
        ? 'Nobody yet'
        : `${plural(counts.contacts, 'person', 'people')} · ${plural(
            counts.workspaceRules,
            'default rule',
            'default rules',
          )}`,
    // Underscores out: `America/New_York` is a database value, "America/New York" is a place.
    calendar: `${plural(counts.calendars, 'calendar', 'calendars')} · ${counts.timezone.replaceAll('_', ' ')}`,
    /*
     * Passkeys are the honest answer to "can I still get in", and the only one on offer.
     * NOTHING RECORDS whether a recovery phrase was ever written down, so this line must not
     * imply it does — "Recovery phrase confirmed" would be a reading of a fact the schema does
     * not hold. It names what exists and counts what can be counted.
     */
    security:
      counts.passkeys === 0
        ? 'Password and recovery phrase, no passkey'
        : `Password, recovery phrase, ${plural(counts.passkeys, 'passkey', 'passkeys')}`,
    plan: counts.planName,
  }
}
