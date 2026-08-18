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

/** Click the control named `name`, then wait for the sheet it opens. */
export const openSheet = async (page: Page, name: RegExp | string): Promise<Locator> => {
  await page.getByRole('button', { name }).first().click()
  return settleSheet(page)
}
