import { expect, test, type Page } from '@playwright/test'

/**
 * Runtime privacy-leakage suite.
 *
 * IT NOW OWNS THE SERVER-RENDER SURFACES TOO, and that is a recent change worth knowing
 * about. `apps/web/test/build-output.leak.test.ts` used to scan the prerendered HTML and the
 * RSC/Flight payload straight off disk. The CSP nonce made every app route dynamic — a
 * per-request nonce cannot exist in a page rendered once at build time — so the build emits
 * no `.rsc` and one framework `500.html`, and there is nothing on disk left to read.
 *
 * The half of that change worth remembering: one of those two assertions kept PASSING after
 * its input disappeared, because `500.html` still matched its filter. Green, scanning a page
 * that could never hold user content. So the surfaces moved here, where they are read from a
 * live server, and the build-output file now asserts that no app route prerenders at all —
 * which is what fails if anyone makes one static again without restoring a scan.
 *
 * What is left there: every emitted chunk, the caches, and the fixture itself.
 *
 * Plaintext IS expected in the DOM after hydration — that is what a calendar is, and it
 * sits inside the stated client-compromise boundary (ADR 0002). Every assertion below is
 * about plaintext escaping the render path, never about it existing there.
 */

/** Distinctive by construction; see the note in build-output.leak.test.ts. */
const CANARIES = [
  'Legal Call',
  'Lunch with Sarah',
  'Ivy Cafe',
  'Bramblewick Trust',
  'Bramblewick handover',
  'Quarrystone Room',
  'Marchpane clause',
  'Renewal discussion',
  'Do not sync to any external calendar',
]

/** The store only decrypts after hydration, so wait for real content before asserting. */
async function loadDecrypted(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
}

const findCanaries = (haystack: string) => CANARIES.filter((c) => haystack.includes(c))

test.describe('decryption actually happens', () => {
  test('renders Cloaked titles only after hydration', async ({ page }) => {
    // Guards every other assertion in this file: if nothing ever decrypted, the leak
    // tests below would pass for the wrong reason.
    /*
     * URLS ARE COLLECTED IN THE HANDLER; BODIES ARE FETCHED AFTERWARDS.
     *
     * This used to `await response.text()` INSIDE the listener, which is the exact race the
     * sibling test below documents having been rewritten to avoid: reading a body
     * asynchronously from a response event competes with navigation, and Playwright will
     * resolve that promise against a buffer that is no longer the one you asked for.
     *
     * It does not fail loudly. It fails by ATTRIBUTING CONTENT TO THE WRONG RESPONSE, and the
     * shape that took here was worse than useless: a run reported decrypted event titles
     * inside `app/page.css` and `app/loading.css`. Those strings are in no stylesheet, in no
     * source file, and not in the fixture, which stores ciphertext only and says so on its
     * first line. The same run passed on retry with nothing changed.
     *
     * A privacy gate that cries leak about a CSS file is a gate nobody believes the third
     * time, which is how a real one eventually gets waved through. Collecting the URL
     * synchronously and fetching each body afterwards removes the race, and costs one extra
     * request per asset on a page that has already loaded them.
     */
    const urls: string[] = []
    page.on('response', (response) => {
      if (response.url().startsWith('http')) urls.push(response.url())
    })

    await loadDecrypted(page)

    await expect(page.getByText('Bramblewick handover')).toBeVisible()
    await expect(page.getByText('Lunch with Sarah')).toBeVisible()

    const bodies = await Promise.all(
      [...new Set(urls)].map((url) =>
        page.request
          .get(url)
          .then((response) => response.text())
          .catch(() => ''),
      ),
    )

    // ...and none of it came from the server.
    expect(findCanaries(bodies.join('\n'))).toEqual([])
  })

  /**
   * The server-render scans, rehomed from build-output.leak.test.ts.
   *
   * Every route the app serves, not just the calendar: making them dynamic means each one is
   * rendered per request now, and a Server Component that accidentally awaited a decrypted
   * value would put it in that route's HTML and in its Flight payload. The build scan used to
   * catch that for the prerendered ones; nothing did once they stopped being prerendered.
   */
  test('no route serves plaintext in its HTML or its Flight payload', async ({ page }) => {
    /*
     * SLOW, for the same reason csp.spec.ts is, and here it matters more.
     *
     * This walk makes two requests per route -- the HTML and the Flight payload -- against
     * a `next dev` server that compiles on first request and is shared by eight workers.
     * At eight routes that is sixteen possible cold compiles inside one 30s budget, and it
     * started expiring the moment /contact added a ninth route for the workers to fight
     * over. It passes in isolation every time.
     *
     * The thing that makes this worth a comment rather than a bigger number: a privacy
     * gate that times out is a gate that DID NOT RUN, and it reports identically to a
     * broken product. Twenty-one failures in one full-suite run were all this class, and
     * the tempting reading of them is "the suite is flaky" rather than "the leak scan
     * stopped executing". Trimming the list would be worse still: it would drop exactly
     * the routes this test exists to cover.
     */
    test.slow()
    /*
     * /settings/privacy IS THE HIGHEST-VALUE ENTRY IN THIS LIST. It renders contact
     * ciphertext, group labels and engine decisions, and it would have been silently absent
     * — the settings accordion that used to hold all of that was covered by `/settings`, and
     * splitting the page moved the sealed material to a route nothing here named.
     */
    const ROUTES = [
      '/',
      '/settings',
      '/settings/privacy',
      '/settings/calendar',
      '/settings/security',
      '/settings/plan',
      '/settings/availability',
      '/people',
    ]

    // Fetched directly rather than collected from a `response` listener. Reading bodies
    // asynchronously inside that event races navigation — the page can close underneath the
    // await — and the first version of this test failed that way rather than on its subject.
    const bodies: string[] = []

    for (const path of ROUTES) {
      const html = await page.request.get(path).then((r) => r.text())
      // `RSC: 1` is how Next is asked for the Flight payload of a route. Deterministic, and
      // it needs no client navigation to provoke — which is the other thing that made the
      // first version flaky.
      const flight = await page.request
        .get(path, { headers: { RSC: '1' } })
        .then((r) => r.text())
      bodies.push(html, flight)
    }

    // THE GUARD, and it is the whole reason these assertions were rehomed rather than
    // deleted. Without it this passes vacuously the day the routes move — which is exactly
    // how the assertion it replaced ended up green while reading a framework error page.
    expect(bodies.length).toBe(ROUTES.length * 2)
    for (const [index, body] of bodies.entries()) {
      expect(body.length, `empty response for ${ROUTES[Math.floor(index / 2)]}`).toBeGreaterThan(
        500,
      )
    }

    expect(findCanaries(bodies.join('\n'))).toEqual([])
  })

  test('serves ciphertext, proving there was content to leak', async ({ page }) => {
    // The other half of the guard above: no canaries is only meaningful if the sealed values
    // were actually present in what the server sent. Mirrors the build scan's
    // "ships ciphertext in the build" assertion, which covered this before the routes went
    // dynamic.
    const html = await page.goto('/').then((r) => r?.text() ?? '')
    // Base64 GCM payloads from the fixture. Their presence means the page really did carry
    // this account's event content, sealed.
    expect(html).toMatch(/"ciphertext":"[A-Za-z0-9+/=]{16,}"|\\"ciphertext\\":\\"[A-Za-z0-9+/=]{16,}/)
    expect(findCanaries(html)).toEqual([])
  })

  test('shows placeholders before the store unlocks', async ({ page }) => {
    // Block the JS bundles so hydration never completes: what remains is what the server
    // sent, which must be placeholders.
    await page.route('**/*.js', (route) => route.abort())
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    const html = await page.content()
    expect(findCanaries(html)).toEqual([])
    expect(html).toContain('Private event')
  })
})

test.describe('nothing reaches persisted browser storage', () => {
  test('localStorage and sessionStorage stay clean', async ({ page }) => {
    await loadDecrypted(page)

    const stored = await page.evaluate(() => {
      const dump = (storage: Storage) =>
        Object.keys(storage)
          .map((k) => `${k}=${storage.getItem(k) ?? ''}`)
          .join('\n')
      return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`
    })

    expect(findCanaries(stored)).toEqual([])
  })

  test('IndexedDB holds no decrypted content', async ({ page }) => {
    await loadDecrypted(page)

    const dumped = await page.evaluate(async () => {
      if (!('databases' in indexedDB)) return ''
      const databases = await indexedDB.databases()
      const out: string[] = []

      for (const meta of databases) {
        if (!meta.name) continue
        const db = await new Promise<IDBDatabase | null>((resolve) => {
          const request = indexedDB.open(meta.name!)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
        })
        if (!db) continue

        for (const storeName of Array.from(db.objectStoreNames)) {
          const rows = await new Promise<unknown[]>((resolve) => {
            const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
            request.onsuccess = () => resolve(request.result as unknown[])
            request.onerror = () => resolve([])
          })
          out.push(JSON.stringify(rows))
        }
        db.close()
      }
      return out.join('\n')
    })

    expect(findCanaries(dumped)).toEqual([])
  })

  test('cookies carry no content', async ({ page, context }) => {
    await loadDecrypted(page)
    const cookies = await context.cookies()
    expect(findCanaries(JSON.stringify(cookies))).toEqual([])
  })

  test('the Cache API holds no decrypted content', async ({ page }) => {
    await loadDecrypted(page)

    const cached = await page.evaluate(async () => {
      if (!('caches' in window)) return ''
      const names = await caches.keys()
      const out: string[] = []
      for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) {
          const response = await cache.match(request)
          if (response) out.push(await response.text().catch(() => ''))
        }
      }
      return out.join('\n')
    })

    expect(findCanaries(cached)).toEqual([])
  })
})

test.describe('nothing reaches an error report', () => {
  test('a thrown error carries no decrypted content', async ({ page }) => {
    await loadDecrypted(page)

    // Simulates what a reporter (Sentry and friends) actually captures: the error, its
    // stack, and a serialized snapshot of surrounding context.
    const captured = await page.evaluate(() => {
      const reports: string[] = []
      try {
        throw new Error('Simulated failure while rendering the calendar')
      } catch (error) {
        const e = error as Error
        reports.push(
          JSON.stringify({
            message: e.message,
            stack: e.stack,
            url: window.location.href,
            title: document.title,
          }),
        )
      }
      return reports.join('\n')
    })

    expect(findCanaries(captured)).toEqual([])
  })

  test('the URL never carries content, so it cannot reach a Referer header or a log', async ({
    page,
  }) => {
    await loadDecrypted(page)
    const url = page.url()
    expect(findCanaries(url)).toEqual([])
    expect(url).not.toContain('Legal')
  })

  test('console output carries no decrypted content', async ({ page }) => {
    const messages: string[] = []
    page.on('console', (message) => messages.push(message.text()))
    page.on('pageerror', (error) => messages.push(`${error.message}\n${error.stack ?? ''}`))

    await loadDecrypted(page)
    await page.waitForTimeout(500)

    expect(findCanaries(messages.join('\n'))).toEqual([])
  })

  test('performance entries expose no content', async ({ page }) => {
    // Resource names and marks are routinely shipped to analytics.
    await loadDecrypted(page)
    const entries = await page.evaluate(() =>
      JSON.stringify(performance.getEntries().map((e) => e.name)),
    )
    expect(findCanaries(entries)).toEqual([])
  })
})

test.describe('nothing leaves over the network', () => {
  test('no request body or URL carries decrypted content', async ({ page }) => {
    const outbound: string[] = []
    page.on('request', (request) => {
      outbound.push(request.url())
      const body = request.postData()
      if (body) outbound.push(body)
    })

    await loadDecrypted(page)
    // Exercise the nav, since a client-side transition is where a careless implementation
    // would put state into a query string.
    // exact: the view bookmark beside the segments is named "Agenda is your default
    // view", so a substring match now resolves to two controls. Tightening the locator,
    // not loosening the test.
    await page.getByRole('button', { name: 'Agenda', exact: true }).click()
    await page.waitForTimeout(300)

    expect(findCanaries(outbound.join('\n'))).toEqual([])
  })

  test('server responses carry ciphertext, confirming there was content to leak', async ({
    page,
  }) => {
    // The anti-vacuous guard: if the server sent nothing at all, every assertion above
    // would pass while proving nothing.
    const bodies: string[] = []
    page.on('response', async (response) => {
      if (response.request().resourceType() === 'document') {
        bodies.push(await response.text().catch(() => ''))
      }
    })

    await loadDecrypted(page)
    expect(bodies.join('\n')).toContain('aes-256-gcm-v1')
  })
})
