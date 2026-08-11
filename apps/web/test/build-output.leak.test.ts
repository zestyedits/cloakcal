import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Runtime leak tests against the real production build.
 *
 * Covers three of the five surfaces from the review plan — initial HTML, the RSC/Flight
 * payload, and Next's server/data cache — by scanning everything the build emits. The
 * remaining two (client error-reporting payloads and persisted browser storage) need a
 * live browser and arrive with the Playwright suite.
 *
 * This test FAILS rather than skips when there is no build. A privacy gate that quietly
 * skips is worse than no gate: it reports green while checking nothing.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url))
// The production output directory, kept separate from `next dev`'s .next — see the note
// in next.config.ts.
const BUILD = join(WEB, '.next-prod')

/**
 * Plaintext from tools/generate-fixture.ts. If any appears anywhere the server emits,
 * Tier B content has crossed a boundary it must not cross.
 *
 * Every entry is DISTINCTIVE on purpose. Generic words are deliberately excluded:
 *   - 'Private' occurs in our own placeholder copy ("Private event").
 *   - 'Family' occurs inside framework identifiers such as `fontFamily`.
 *   - 'Personal' and 'Work' are common enough to appear in any bundle.
 * A canary that fires on ordinary code is a false alarm, and a security test that cries
 * wolf gets ignored. Calendar-name leakage is instead covered by 'Bramblewick Trust',
 * which exists in the fixture specifically to be unambiguous.
 */
const CANARIES = [
  'Team Standup',
  'Client Meeting',
  'Lunch with Sarah',
  'Legal Call',
  'Project Review',
  'Strategy Session',
  'Dinner with Family',
  '1:1 with Alex',
  'Ivy Cafe',
  'Office — Boardroom',
  'Renewal discussion',
  'Do not sync to any external calendar',
  'Bramblewick Trust',
  'Bramblewick handover',
  'Quarrystone Room',
  'Marchpane clause',
]

/** Placeholders the server IS expected to render, proving the page is not simply empty. */
const EXPECTED_PLACEHOLDERS = ['Private event', 'Calendar']

const IGNORED = new Set(['cache'])

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue
      yield* walk(full)
    } else {
      yield full
    }
  }
}

let files: string[] = []

beforeAll(async () => {
  const exists = await stat(BUILD).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!exists) {
    throw new Error(
      'No production build found at apps/web/.next-prod. Run `pnpm --filter @cloakcal/web build` ' +
        'first. This test fails rather than skips: a privacy gate that skips reports green ' +
        'while checking nothing.',
    )
  }
  for await (const file of walk(BUILD)) files.push(file)
})

const readAll = async (paths: string[]) =>
  (await Promise.all(paths.map((p) => readFile(p, 'utf8').catch(() => '')))).join('\n')

describe('the server emits no Tier B plaintext', () => {
  it('produced a build with pages in it', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('keeps plaintext out of the prerendered HTML', async () => {
    const html = files.filter((f) => f.endsWith('.html'))
    expect(html.length).toBeGreaterThan(0)

    const content = await readAll(html)
    expect(CANARIES.filter((c) => content.includes(c))).toEqual([])
  })

  it('renders placeholders, so the HTML test is not passing on an empty page', async () => {
    // Without this, deleting the calendar entirely would make every leak assertion pass.
    const index = files.find((f) => f.endsWith(`app${sep}index.html`))
    expect(index).toBeDefined()

    const content = await readFile(index!, 'utf8')
    for (const placeholder of EXPECTED_PLACEHOLDERS) {
      expect(content).toContain(placeholder)
    }
  })

  it('keeps plaintext out of the RSC / Flight payload', async () => {
    // The subtlest surface: Flight serializes props across the server/client boundary, so
    // a decrypted value reaching a Server Component's output would land here even though
    // it never appears in the visible HTML.
    const rsc = files.filter((f) => f.endsWith('.rsc'))
    expect(rsc.length).toBeGreaterThan(0)

    const content = await readAll(rsc)
    expect(CANARIES.filter((c) => content.includes(c))).toEqual([])
  })

  it('keeps plaintext out of every client bundle', async () => {
    const js = files.filter((f) => f.endsWith('.js'))
    const content = await readAll(js)
    expect(CANARIES.filter((c) => content.includes(c))).toEqual([])
  })

  it('keeps plaintext out of the entire build output, including caches', async () => {
    const content = await readAll(files)
    const leaked = CANARIES.filter((c) => content.includes(c))
    expect(leaked).toEqual([])
  })

  it('ships ciphertext, confirming content was actually present to leak', async () => {
    // The strongest guard against a vacuous pass: the build must contain the sealed data.
    // If the fixture were empty, every assertion above would pass for the wrong reason.
    const fixture = await readFile(join(WEB, 'src/server/events.fixture.json'), 'utf8')
    expect(fixture).toContain('aes-256-gcm-v1')

    const content = await readAll(files.filter((f) => f.endsWith('.html') || f.endsWith('.rsc')))
    expect(content).toContain('aes-256-gcm-v1')
  })
})

describe('the committed fixture is itself clean', () => {
  it('contains no plaintext', async () => {
    const fixture = await readFile(join(WEB, 'src/server/events.fixture.json'), 'utf8')
    expect(CANARIES.filter((c) => fixture.includes(c))).toEqual([])
  })

  it('carries a nonce and algorithm for every field', async () => {
    const fixture = JSON.parse(
      await readFile(join(WEB, 'src/server/events.fixture.json'), 'utf8'),
    ) as {
      events: { fields: { alg: string; nonce: string; ciphertext: string }[] }[]
      calendars: { fields: { alg: string; nonce: string; ciphertext: string }[] }[]
    }

    const allFields = [
      ...fixture.events.flatMap((e) => e.fields),
      ...fixture.calendars.flatMap((c) => c.fields),
    ]
    expect(allFields.length).toBeGreaterThan(10)

    for (const field of allFields) {
      expect(field.alg).toBe('aes-256-gcm-v1')
      expect(field.nonce).toHaveLength(24) // 12 bytes as hex
      expect(field.ciphertext.length).toBeGreaterThanOrEqual(32) // >= 16 bytes as hex
    }
  })
})

describe('the static import rule still holds for the built app', () => {
  it('has real server modules to check', async () => {
    // The static rule in packages/cloak-store scans apps/. Confirm apps/web now actually
    // contains server modules, so that rule is no longer scanning an empty directory.
    const serverDir = join(WEB, 'src/server')
    const entries = await readdir(serverDir)
    expect(entries).toContain('events.ts')

    // Match IMPORT SYNTAX, not raw text: this file's own doc comment names the packages
    // it must not import, and a substring check would flag that comment as a violation.
    const source = await readFile(join(serverDir, 'events.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]@cloakcal\/crypto/)
    expect(source).not.toMatch(/from\s+['"]@cloakcal\/cloak-store/)
    expect(relative(WEB, serverDir).split(sep).join('/')).toBe('src/server')
  })
})
