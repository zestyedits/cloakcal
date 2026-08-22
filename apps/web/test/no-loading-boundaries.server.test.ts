import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NO ROUTE MAY DECLARE A LOADING FALLBACK.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SOURCE-LEVEL, WHICH IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * The obvious test is a browser one: navigate, poll for a skeleton, assert you never see
 * it. That test does not work, and it fails in the worst way — it PASSES whether or not
 * fallbacks exist. Measured here rather than assumed: with a real `loading.tsx` restored at
 * `app/settings`, a plain 390px navigation from the calendar to Settings, polled every
 * 10ms, observed the fallback exactly zero times. Holding the response is no better, and is
 * worse for being convincing: Next then keeps the previous route painted and never renders
 * the boundary at all, so the harness prevents the very thing it is trying to catch.
 *
 * That is the same conclusion the deleted `loading-continuity.spec.ts` reached about the
 * three ways it tried, and the reason its companion `loading-shell.client.test.ts` was
 * source-level too. This file is that companion inverted: the old pair kept each fallback
 * FAITHFUL to its destination, and a faithful fallback is still a ghost wireframe. So the
 * fallbacks are gone and the assertion is that they stay gone.
 *
 * A `loading.tsx` is a Suspense boundary Next may paint whenever a payload is slow — which
 * on a fast dev machine is never, and on a phone on hotel wifi against a force-dynamic app
 * reading Supabase is exactly when the user is already unhappy. Its absence is a property
 * of the tree, and a property of the tree is worth asserting about the tree.
 *
 * The runtime backstop still exists in `e2e/no-skeleton.spec.ts`, which can catch a
 * fallback that genuinely paints. It cannot prove absence. This can.
 */

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const routeFiles = (dir: string, name: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) routeFiles(full, name, found)
    else if (entry.name === name) found.push(full)
  }
  return found
}

const APP = root('../src/app')
const relative = (file: string) => file.slice(file.indexOf('/src/app/') + 9)

describe('route-level loading fallbacks', () => {
  it('none exist anywhere under app/', () => {
    expect(routeFiles(APP, 'loading.tsx').map(relative)).toEqual([])
  })

  /*
   * THE SWEEP HAS TO PROVE IT LOOKED. A recursive walk that silently found nothing because
   * it was pointed at the wrong directory reports exactly the same green as a clean tree.
   * This repo has already shipped one sweep that passed while inspecting nothing.
   */
  it('is actually walking the route tree', () => {
    expect(routeFiles(APP, 'page.tsx').length).toBeGreaterThan(10)
  })

  /*
   * The shared bars are the other half of the same change: a layout is the only thing Next
   * keeps mounted across a sibling navigation, so without these the settings and people
   * headers unmount and rebuild on every move between siblings — which looks like a flash
   * even when nothing is drawn to replace them.
   */
  it.each(['settings', 'people'])('%s has a persistent layout', (segment) => {
    expect(routeFiles(`${APP}/${segment}`, 'layout.tsx').map(relative)).toEqual([
      `${segment}/layout.tsx`,
    ])
  })
})
