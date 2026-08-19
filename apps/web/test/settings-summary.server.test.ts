import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { summariseSettings } from '@/lib/settings-summary'
import { SETTINGS_DOORS } from '@/lib/settings-sections'

/**
 * THE FOUR LINES A SIGNED-IN USER READS, AND THE RULE THAT THEY ARE ONLY EVER COUNTS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Every Playwright project runs against the committed fixture, which has no session and no
 * workspace row, so the hub prints "Demo" on all four doors and `loadSettingsSummary` returns
 * null before it composes anything. The strings below — the ones an actual account sees, the
 * entire point of the hub — were unreachable by every test in the repo. That is the same shape
 * as the contact-name ingest bug and the bytea spelling bug: fixture-only green is not
 * evidence for a path the fixture cannot take.
 *
 * `summariseSettings` is pure, so the composition is now ordinary input and output. What is
 * still NOT covered here is the wire: whether PostgREST returns the counts these queries ask
 * for, under RLS, for a real user. Nothing local can see that — it needs the throwaway-account
 * recipe in CLAUDE.md, and until someone runs it this file proves the sentences and not the
 * numbers behind them.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const SETTINGS_SERVER = read('../src/server/settings.ts')

/** The body of `loadSettingsSummary`, up to the next top-level export. */
const SUMMARY_LOADER = (() => {
  const from = SETTINGS_SERVER.indexOf('export async function loadSettingsSummary')
  const to = SETTINGS_SERVER.indexOf('\n/** /settings/privacy', from)
  expect(from, 'loadSettingsSummary was renamed or removed').toBeGreaterThan(-1)
  expect(to, 'the slice markers no longer bracket the function').toBeGreaterThan(from)
  return SETTINGS_SERVER.slice(from, to)
})()

const base = {
  calendars: 2,
  contacts: 3,
  workspaceRules: 1,
  passkeys: 1,
  timezone: 'America/New_York',
  planName: 'Free',
}

describe('what each door says to a real account', () => {
  it('states people and rules once there is anybody', () => {
    expect(summariseSettings(base).privacy).toBe('3 people · 1 default rule')
  })

  it('says "Nobody yet" rather than a pair of zeroes', () => {
    /*
     * A zero is a true answer to a question nobody asked. The door exists to say whether there
     * is anything in there to look at, and "0 people · 0 default rules" makes an empty account
     * read as a broken one — which is most of what the old four-figure readout band did wrong.
     */
    const line = summariseSettings({ ...base, contacts: 0, workspaceRules: 0 }).privacy
    expect(line).toBe('Nobody yet')
    expect(line).not.toMatch(/\b0\b/)
  })

  it('keeps saying "Nobody yet" when rules somehow exist without contacts', () => {
    // A rule for the public link needs no contact at all, so this is reachable rather than
    // theoretical. The line still leads with the people, because that is what it is about.
    expect(summariseSettings({ ...base, contacts: 0, workspaceRules: 2 }).privacy).toBe('Nobody yet')
  })

  it('counts a calendar and a place, with the underscore taken out', () => {
    // `America/New_York` is a database value; "America/New York" is a place. The hub is the
    // one surface that shows the zone without a picker beside it to explain the format.
    expect(summariseSettings(base).calendar).toBe('2 calendars · America/New York')
    expect(summariseSettings({ ...base, calendars: 1 }).calendar).toBe(
      '1 calendar · America/New York',
    )
  })

  it('never claims a recovery phrase was confirmed, because nothing records that', () => {
    /*
     * The tempting line here is "Recovery phrase confirmed", and it would be a reading of a
     * fact the schema does not hold — there is no column, anywhere, saying the 24 words were
     * ever written down. Same family as the export claim and the reminders claim: copy cashing
     * a cheque on a capability that does not exist.
     */
    for (const passkeys of [0, 1, 4]) {
      const line = summariseSettings({ ...base, passkeys }).security
      expect(line).not.toMatch(/confirm|verified|backed up|safe/i)
    }
    expect(summariseSettings({ ...base, passkeys: 0 }).security).toBe(
      'Password and recovery phrase, no passkey',
    )
    expect(summariseSettings({ ...base, passkeys: 1 }).security).toBe(
      'Password, recovery phrase, 1 passkey',
    )
    expect(summariseSettings({ ...base, passkeys: 4 }).security).toBe(
      'Password, recovery phrase, 4 passkeys',
    )
  })

  it('names the tier for the plan line, not a price', () => {
    expect(summariseSettings({ ...base, planName: 'Pro' }).plan).toBe('Pro')
    expect(summariseSettings(base).plan).not.toMatch(/\$/)
  })

  it('gives every door a line, so none can render blank', () => {
    // `SettingsSummary` is a total record, so this is really a check that the door list and the
    // summariser have not drifted apart — a door with no line prints nothing at all.
    const summary = summariseSettings(base)
    for (const door of SETTINGS_DOORS) {
      expect(summary[door.id], `${door.id} has no summary line`).toBeTruthy()
    }
  })

  it('carries no em dash, on any branch', () => {
    for (const counts of [base, { ...base, contacts: 0, passkeys: 0, calendars: 1 }]) {
      for (const line of Object.values(summariseSettings(counts))) {
        expect(line).not.toContain('—')
      }
    }
  })
})

describe('the hub reads counts and nothing else', () => {
  /**
   * THE INVARIANT THE WHOLE PAGE RESTS ON. The hub is a plain server component with no
   * CloakProvider and no client JavaScript, which is only possible while it renders nothing
   * sealed. The type of `summariseSettings` already forbids a label arriving; this guards the
   * other half, which is the query.
   */
  it('asks PostgREST for head counts, never for rows', () => {
    // Five counts: calendars, contacts, visibility_rules, root_key_wraps, and the helper.
    expect(SUMMARY_LOADER).toContain("select('id', { count: 'exact', head: true })")
    // `head: true` is what makes it a count rather than a fetch. Every select in this function
    // goes through the one `count` helper, so there is exactly one place for this to be true.
    const selects = SUMMARY_LOADER.match(/\.select\(/g) ?? []
    expect(selects, 'a second select shape appeared in the summary loader').toHaveLength(1)
  })

  it('never names a column that carries ciphertext or a label', () => {
    /*
     * `cloaked_fields` is where every sealed value lives, and `ciphertext`/`nonce` are its
     * columns. A summary line that wanted to be friendlier would reach for exactly these.
     */
    for (const forbidden of ['cloaked_fields', 'ciphertext', 'nonce', 'key_version', 'field_name']) {
      expect(SUMMARY_LOADER, `the summary loader names ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('keeps the wrap select to an id, because a wrap row is key material', () => {
    // The passkey count reads `root_key_wraps`, which holds wrapped root keys. Counting them is
    // fine; widening that select is not, and it is one word away.
    expect(SUMMARY_LOADER).toContain("count('root_key_wraps')")
    for (const forbidden of ['wrapped_key', 'prf_salt', 'credential_id', 'kdf']) {
      expect(SUMMARY_LOADER, `the summary loader selects ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('scopes the rule count to the workspace, not to every rule the user can see', () => {
    /*
     * `.is('event_id', null)` is the same split `partitionRules` makes. Without it the count
     * folds in every per-event rule as well, and the hub prints a number the Privacy page's own
     * list contradicts — a disagreement between two surfaces about one fact, which is worse
     * than either being absent.
     */
    expect(SUMMARY_LOADER).toContain("is('event_id', null)")
  })

  it('is rendered by a tree that cannot decrypt', () => {
    /*
     * Rule 2's static gate already stops a server module importing the crypto packages. This is
     * narrower and about the hub specifically: it must not become a client component, because
     * the moment it does, the cheapest way to improve a summary line is to open the store.
     */
    for (const path of [
      '../src/components/settings/settings-hub.tsx',
      '../src/components/settings/settings-doors.tsx',
      '../src/app/settings/page.tsx',
    ]) {
      const source = read(path)
      expect(source, `${path} became a client component`).not.toMatch(/^\s*['"]use client['"]/)
      for (const forbidden of ['cloak-provider', 'cloak-store', '@cloakcal/crypto', 'use-cloaked-labels']) {
        expect(source, `${path} imports ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('reads a real function, so none of the above can pass vacuously', () => {
    expect(SUMMARY_LOADER.length).toBeGreaterThan(400)
    expect(SUMMARY_LOADER).toContain('summariseSettings(')
  })
})
