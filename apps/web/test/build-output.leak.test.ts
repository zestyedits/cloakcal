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

  it('emits server code for the calendar route', async () => {
    // The route became DYNAMIC when it started reading searchParams for View As, so there
    // is no prerendered index.html to scan any more. The equivalent assertions moved to
    // the E2E suite, which inspects the actually-rendered HTML: see the placeholder test
    // in leak.spec.ts and the ciphertext assertions in view-as.spec.ts.
    const serverChunks = files.filter((f) => f.includes(`server${sep}`) && f.endsWith('.js'))
    expect(serverChunks.length).toBeGreaterThan(0)
  })

  /**
   * PRERENDER SCANNING MOVED TO THE E2E SUITE, AND THIS TEST IS WHY IT CANNOT MOVE BACK
   * BY ACCIDENT.
   *
   * The CSP nonce made every app route dynamic — a per-request nonce cannot exist in a page
   * rendered once at build time — so the build emits no `.rsc` at all and exactly one `.html`,
   * Next's framework 500 page.
   *
   * The two assertions that used to live here scanned those surfaces. One of them failed
   * loudly when its input vanished, which is what they were designed to do. **The other one
   * did not**: `keeps plaintext out of the prerendered HTML` kept passing, because
   * `500.html` still matched its filter — a fixture canary could never appear in a framework
   * error page, so it was green while checking nothing. That is precisely the failure this
   * file's header calls worse than having no gate, and it is the reason for the assertion
   * below rather than a quiet deletion.
   *
   * If a route is ever made static again, this fails and tells you to restore a real scan of
   * it. Runtime coverage of both surfaces now lives in `e2e/leak.spec.ts`, which reads what
   * the server actually sends.
   */
  it('prerenders no app route, so there is no HTML or Flight payload to scan here', async () => {
    const rsc = files.filter((f) => f.endsWith('.rsc'))
    expect(rsc).toEqual([])

    // `pages/500.html` and `pages/404.html` are framework chrome, built by Next regardless
    // and incapable of holding user content. Anything else is an app route that went static.
    const appHtml = files
      .map((f) => relative(BUILD, f))
      .filter((f) => f.endsWith('.html'))
      .filter((f) => !/pages[\\/](?:404|500)\.html$/.test(f))
    expect(
      appHtml,
      'a route became static again — restore a canary scan of its prerendered HTML',
    ).toEqual([])
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

  it('ships ciphertext in the build, confirming content was present to leak', async () => {
    // Guard against a vacuous pass: if the fixture were empty, every scan above would
    // succeed for the wrong reason. The sealed data must be somewhere in the output.
    const fixture = await readFile(join(WEB, 'src/server/events.fixture.json'), 'utf8')
    expect(fixture).toContain('aes-256-gcm-v1')

    const content = await readAll(files)
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
