import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LEGAL_DOCUMENTS,
  NEVER_READABLE_TO_US,
  PRIVACY,
  READABLE_TO_US,
  TERMS,
} from '../src/lib/legal'

/**
 * The privacy policy, checked against the database rather than against itself.
 *
 * A privacy policy is the one document in this product that can rot silently. Code that
 * drifts from its comments fails a test eventually; a policy that drifts from the schema just
 * becomes false, and the only person who finds out is a regulator or a journalist. So the
 * test that matters here is the one driven off the migrations: **add a plaintext column and
 * forget to disclose it, and this goes red.**
 *
 * It cannot check that the prose is well written or legally sufficient. It checks the two
 * things that are mechanically checkable — that every readable column is covered, and that
 * the document never makes the one claim CloakCal is not allowed to make.
 */

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url))

/** Every word of both documents, lowercased, for claim scanning. */
const allProse = LEGAL_DOCUMENTS.flatMap((doc) => [
  doc.title,
  doc.lede,
  ...doc.sections.flatMap((s) => [s.heading, ...s.body, ...(s.list ?? [])]),
])
  .join('\n')
  .toLowerCase()

describe('the privacy policy cannot overclaim', () => {
  it('never says zero-knowledge except to deny it', () => {
    // Rule 1. The phrase is allowed exactly once, in the sentence that refuses it. Anything
    // else is the marketing claim this product is forbidden from making.
    const mentions = allProse.split('zero-knowledge').length - 1
    expect(mentions).toBe(1)

    const denial = PRIVACY.sections
      .flatMap((s) => s.body)
      .find((p) => p.includes('zero-knowledge'))
    expect(denial).toBeDefined()
    expect(denial?.toLowerCase()).toMatch(/not zero-knowledge/)
  })

  it('never claims we cannot see times', () => {
    // The specific false sentence someone would write while trying to make this page sound
    // better. Times, durations and recurrence are plaintext and always will be (plan D1).
    for (const phrase of [
      'we cannot see when',
      'we do not know when',
      'we cannot read your calendar',
      'we see nothing',
      'end-to-end encrypted calendar',
    ]) {
      expect(allProse, `overclaim: "${phrase}"`).not.toContain(phrase)
    }
  })

  it('states plainly that times are readable', () => {
    // The positive form of the assertion above: it is not enough to avoid the false claim,
    // the true one has to be present and findable.
    const readable = READABLE_TO_US.join('\n').toLowerCase()
    expect(readable).toMatch(/when your events happen/)
    expect(readable).toMatch(/how they repeat/)
  })
})

describe('the disclosure matches the schema', () => {
  /** Every `add column` and `create table` column across all migrations, roughly. */
  const migrationSql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(`${MIGRATIONS}${f}`, 'utf8'))
    .join('\n')

  it('found the migrations, so nothing below passes vacuously', () => {
    expect(migrationSql.length).toBeGreaterThan(10_000)
  })

  /**
   * Plaintext facts that exist in the schema and MUST appear in the policy.
   *
   * Each entry is a schema token plus the words the policy has to contain if that token is
   * present. Adding a Tier A column means adding a line here and a line to the document —
   * which is the friction this test exists to create.
   */
  const DISCLOSURES: ReadonlyArray<{ readonly column: string; readonly must: RegExp }> = [
    { column: 'holiday_region', must: /holidays/i },
    { column: 'availability_windows', must: /availability/i },
    { column: 'week_start', must: /week starts/i },
    { column: 'default_view', must: /view you open on/i },
    { column: 'timezone', must: /timezone/i },
    { column: 'provider_customer_id', must: /payment processor gives us|customer id/i },
    { column: 'visibility_rules', must: /visibility rules/i },
    { column: 'contact_group_members', must: /who belongs to which group/i },
  ]

  it.each(DISCLOSURES)('discloses $column', ({ column, must }) => {
    // Only asserts the disclosure if the column actually exists — so this file does not have
    // to be edited in lockstep with a migration being reverted.
    if (!migrationSql.includes(column)) return
    expect(READABLE_TO_US.join('\n')).toMatch(must)
  })

  it('lists every Cloaked field as unreadable', () => {
    // The other direction: anything the crypto layer seals has to appear in the "cannot read"
    // list, or the policy undersells the protection and reads as though titles are plaintext.
    const sealed = NEVER_READABLE_TO_US.join('\n').toLowerCase()
    for (const field of ['title', 'location', 'note', 'attend']) {
      expect(sealed, `${field} is Cloaked but not listed as unreadable`).toContain(field)
    }
  })

  it('admits what the readable half still leaks', () => {
    // The honest limit. A policy that lists plaintext columns without saying what a pattern
    // of busy blocks reveals is technically complete and practically misleading.
    const metadata = PRIVACY.sections.find((s) => s.id === 'metadata')
    expect(metadata).toBeDefined()
    expect(metadata?.body.join(' ')).toMatch(/recurring|pattern|busy/i)
    // Ciphertext length is unpadded today; CLAUDE.md records it as a known gap, so the policy
    // has to record it too rather than waiting for the fix.
    expect(metadata?.body.join(' ')).toMatch(/length/i)
  })
})

describe('the documents are well formed', () => {
  it('gives every section a unique anchor', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const ids = doc.sections.map((s) => s.id)
      expect(new Set(ids).size, `${doc.slug} has duplicate anchors`).toBe(ids.length)
      // Anchors are linked from Settings and from emails; a space or capital breaks the link.
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('uses no em dash anywhere', () => {
    // The house rule, and these are the longest prose in the product.
    for (const doc of LEGAL_DOCUMENTS) {
      const prose = [doc.lede, ...doc.sections.flatMap((s) => [...s.body, ...(s.list ?? [])])]
      expect(prose.filter((p) => p.includes('—'))).toEqual([])
    }
  })

  it('tells people how to leave, in both documents', () => {
    // Export and delete are legal obligations, not features, and a policy that describes
    // rights without naming the buttons is the usual way of technically complying.
    expect(PRIVACY.sections.map((s) => s.id)).toContain('your-rights')
    const rights = PRIVACY.sections.find((s) => s.id === 'your-rights')?.body.join(' ') ?? ''
    expect(rights).toMatch(/export/i)
    expect(rights).toMatch(/delete your account/i)
    expect(TERMS.sections.map((s) => s.id)).toContain('ending')
  })

  it('states the unrecoverable-by-design trade in the terms', () => {
    // The single most surprising thing about this product, and the one a user is most likely
    // to be angry about later if it was buried.
    const section = TERMS.sections.find((s) => s.id === 'the-important-one')
    expect(section?.body.join(' ')).toMatch(/permanently unreadable|cannot recover/i)
  })

  it('gives a contact address', () => {
    expect(allProse).toMatch(/@cloakcal\.com/)
  })
})

describe('the documents are actually reachable', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

  /**
   * The consent line, asserted HERE rather than in e2e, and the reason matters.
   *
   * `/sign-up` renders a "not open yet" notice unless NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN=1.
   * That flag is `NEXT_PUBLIC_`, so it is inlined at BUILD time and Playwright cannot toggle
   * it — the sign-up form does not exist in any environment the e2e suite can reach. A spec
   * that skipped when the form was absent would report green forever while checking nothing,
   * which is exactly the failure mode this repo keeps paying for. So it is checked against
   * the source, where it runs on every commit.
   */
  it('asks for consent on the sign-up form, beside the button', () => {
    const form = read('../src/components/auth-form.tsx')

    expect(form).toMatch(/By creating an account you agree/)
    expect(form).toContain('href="/terms"')
    expect(form).toContain('href="/privacy"')
    // Gated to sign-up: the same sentence on the sign-in form would be claiming someone
    // agreed to something by returning to an account they already have.
    expect(form).toMatch(/mode === 'sign-up' && \(\s*<p className=\{styles\.consent\}/)
  })

  it('puts the links on all three auth pages, which had no footer at all', () => {
    for (const route of ['sign-in', 'sign-up', 'recover']) {
      const page = read(`../src/app/${route}/page.tsx`)
      expect(page, `${route} has no LegalFooter`).toContain('<LegalFooter />')
    }
  })

  it('keeps both documents public in the middleware', () => {
    // Restated from middleware-paths.server.test.ts on purpose. That file is about the two
    // path lists; this one is about the legal pages being usable, and losing that guarantee
    // should fail in the file a reader of the policy would look at.
    const middleware = read('../src/middleware.ts')
    expect(middleware).toContain("'/privacy'")
    expect(middleware).toContain("'/terms'")
  })
})
