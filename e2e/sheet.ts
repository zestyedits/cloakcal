import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The event sheet, and waiting for it to finish arriving.
 *
 * This was written three times — compose, edit, and then delete when deleting moved into
 * the sheet — with the same body and the same reasoning copied alongside it. By the third
 * copy the first line had already drifted: two specs located the dialog as
 * `dialog[open]` and one as `getByRole('dialog')`. This repo has paid for that shape
 * before (`lib/calendar-links.ts` exists because three nav builders disagreed about one
 * query param), so the helper lands before a fourth caller does.
 *
 * NOT a `.spec.ts` file, deliberately: the device projects match specs by an explicit
 * `testMatch` allowlist, and a helper collected as a suite would be a file with no tests.
 *
 * WHY THE WAIT IS ON `getAnimations()` AND NOT A SLEEP. The sheet rises over
 * --duration-base, and axe measures COMPOSITED colour — analysing mid-animation reports
 * every label in it as a contrast failure against a box that is not painted yet, which
 * reads exactly like a palette bug. Waiting on the animations is also correct under
 * prefers-reduced-motion, where the same animation collapses to 1ms and a fixed sleep
 * would just be wasted time.
 */
export const sheet = (page: Page): Locator => page.locator('dialog[open]')

/** Wait for the open sheet to exist and stop moving. */
export const settleSheet = async (page: Page): Promise<Locator> => {
  const dialog = sheet(page)
  await expect(dialog).toHaveCount(1)
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return dialog
}

/**
 * The Cloak door's accessible name, in one place, matching CLOAK_DOOR_LABEL in
 * calendar-screen.tsx.
 *
 * Two buttons carry it -- the desktop header door and the phone bar's centre tile -- and CSS
 * shows exactly one per viewport, which is what `.filter({ visible: true })` resolves. Five
 * specs used to spell out `{ name: 'Cloak', exact: true }` themselves; that copy-paste is the
 * thing that made the label expensive to improve, so the string lives here now and the next
 * change to it is one line.
 *
 * `exact: true` is load-bearing in the other direction too: `getByRole` matches an accessible
 * name as a case-insensitive SUBSTRING, so without it this would also match anything else on
 * the page whose name happens to contain these words.
 */
export const CLOAK_DOOR_NAME = 'Cloak, who can see what'

/** The Cloak door, on whichever chrome this project renders. */
export const cloakDoor = (page: Page): Locator =>
  page.getByRole('button', { name: CLOAK_DOOR_NAME, exact: true }).filter({ visible: true })

/** Click the control named `name`, then wait for the sheet it opens. */
export const openSheet = async (page: Page, name: RegExp | string): Promise<Locator> => {
  await page.getByRole('button', { name }).first().click()
  return settleSheet(page)
}

/**
 * "Which audience is this calendar redacted for?", asked of whichever surface the viewport
 * actually has.
 *
 * The phone stopped having a `<select>` in the 2026-08-20 mobile pass: a 100px labelled
 * card above the calendar became a 44px row that states the mode and opens the Cloak sheet,
 * which is a better picker than the select ever was because it shows each audience's level
 * and the engine's own sentence. Four assertions in view-as.spec.ts were written against
 * the select and failed on the mobile project only.
 *
 * They are updated rather than skipped, because what they assert is real on both devices --
 * only the control carrying the answer differs. On a phone: the owner's row says "Viewing
 * as Me" and exists only for the owner, and `PreviewBar` says "Previewing as {name}" and
 * exists only while previewing, so the PRESENCE of one of the two is the state.
 */
export async function expectAudience(
  page: Page,
  isMobile: boolean,
  expected: 'owner' | { previewing: true },
): Promise<void> {
  const budget = { timeout: 15_000 }
  if (expected === 'owner') {
    if (isMobile) {
      await expect(page.getByRole('button', { name: /^Viewing as Me/ })).toBeVisible(budget)
      await expect(page.getByText('Previewing as')).toHaveCount(0, budget)
      return
    }
    await expect(page.getByRole('combobox', { name: /viewing as/i })).toHaveValue('owner', budget)
    return
  }

  if (isMobile) {
    await expect(page.getByText('Previewing as')).toBeVisible(budget)
    // The owner's row stands down while previewing, so the two can never both be on screen.
    await expect(page.getByRole('button', { name: /^Viewing as Me/ })).toHaveCount(0, budget)
    return
  }
  await expect(page.getByRole('combobox', { name: /viewing as/i })).not.toHaveValue('owner', budget)
}
