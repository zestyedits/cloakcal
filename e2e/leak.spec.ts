import { expect, test, type Page } from '@playwright/test'

/**
 * Runtime privacy-leakage suite — the two surfaces the build-output scan cannot reach.
 *
 * apps/web/test/build-output.leak.test.ts already covers initial HTML, the RSC/Flight
 * payload and every emitted chunk. What it cannot see is what happens once a browser is
 * actually running: what lands in storage, what a network response carries, and what an
 * error reporter would capture. Those need a real page, so they live here.
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
    const responses: string[] = []
    page.on('response', async (response) => {
      if (response.url().startsWith('http')) {
        responses.push(await response.text().catch(() => ''))
      }
    })

    await loadDecrypted(page)

    await expect(page.getByText('Bramblewick handover')).toBeVisible()
    await expect(page.getByText('Lunch with Sarah')).toBeVisible()

    // ...and none of it came from the server.
    expect(findCanaries(responses.join('\n'))).toEqual([])
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
    await page.getByRole('button', { name: 'Agenda' }).click()
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
