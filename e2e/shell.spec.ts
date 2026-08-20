import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { CLOAK_DOOR_NAME, cloakDoor } from './sheet'

/**
 * The shell: five-item nav with Cloak in the centre, the Today link, the mobile week
 * strip, the sidebar compose button and mini month. Controls that appear on interaction
 * (the Cloak sheet) get opened and scanned here, because a control behind a click is a
 * control nobody tested — the delete-confirmation lesson.
 */

const settle = async (page: import('@playwright/test').Page) => {
  await expect(page.getByText('Legal Call')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
}

test('the bottom nav has five slots with Cloak in the centre', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom bar is phone chrome; desktop has the header control')
  await page.goto('/')
  await settle(page)

  const nav = page.getByRole('navigation', { name: 'Calendar views' })
  const labels = await nav.locator('button, a').allTextContents()
  expect(labels).toEqual(['Day', 'Week', 'Cloak', 'Agenda', 'Month'])

  // Agenda/Week are instant toggles over the shared fetch; Day/Month are navigations.
  await expect(nav.getByRole('link', { name: 'Day', exact: true })).toHaveAttribute(
    'href',
    /view=day/,
  )
  await expect(nav.getByRole('link', { name: 'Month', exact: true })).toHaveAttribute(
    'href',
    /view=month/,
  )
  await expect(nav.getByRole('button', { name: 'Week', exact: true })).toBeEnabled()
  await expect(nav.getByRole('button', { name: 'Agenda', exact: true })).toBeEnabled()
})

test('desktop gets the segmented view control instead of the phone bar', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the segmented control is desktop chrome')
  await page.goto('/')
  await settle(page)

  // Two navs exist with this name; the phone bar is display:none here, so the visible
  // one is the header's segmented control.
  const controls = page.getByRole('navigation', { name: 'Calendar views' })
  const header = controls.first()
  await expect(header).toBeVisible()
  await expect(controls.nth(1)).toBeHidden()

  await expect(header.getByRole('button', { name: 'Agenda', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(header.getByRole('link', { name: 'Month', exact: true })).toBeVisible()
  // The compact Cloak door lives beside it.
  await expect(cloakDoor(page)).toBeVisible()
})

/*
 * THE DOOR'S ACCESSIBLE CONTRACT, pinned on both chromes.
 *
 * This spec runs on the mobile and desktop projects, and CSS shows a different one of the two
 * Cloak buttons on each, so the assertions below cover both instances across the matrix rather
 * than testing one and hoping the other matches.
 *
 * The button used to be named by the bare word "Cloak", which is brand vocabulary rather than
 * a description -- and nothing pinned anything about it beyond the word itself. What follows
 * protects the improved contract, not the old label.
 */
test('the Cloak door says what it opens, and still answers to its visible name', async ({
  page,
}) => {
  await page.goto('/')
  await settle(page)

  const door = cloakDoor(page)
  await expect(door).toBeVisible()

  /*
   * WCAG 2.5.3, LABEL IN NAME, AS TWO HALVES THAT MUST AGREE.
   *
   * Somebody driving the browser by voice says "click Cloak" -- the words they can SEE -- and
   * their software matches that against the ACCESSIBLE name. So the printed label has to be
   * contained in the accessible one. Asserting only the accessible name would let a future
   * change rename the visible text to "Privacy" and leave the control unreachable by voice
   * while every other test, and the page itself, looked entirely correct.
   *
   * The visible half is also pinned independently by the five-slot nav test above, which reads
   * textContent via allTextContents() and is blind to ARIA. This is the pairing.
   */
  await expect(door).toHaveText('Cloak')
  await expect(door).toHaveAccessibleName(CLOAK_DOOR_NAME)
  expect(CLOAK_DOOR_NAME.startsWith('Cloak')).toBe(true)

  // It opens a dialog, and says so before it is pressed.
  await expect(door).toHaveAttribute('aria-haspopup', 'dialog')

  /*
   * TWO ATTRIBUTES ASSERTED ABSENT, because each is a plausible-looking thing to add back in
   * a review and neither would fail anything else.
   *
   * `aria-expanded` was here and was removed on measurement. A native <dialog> opened with
   * showModal() goes into the top layer and makes the rest of the document inert, which takes
   * this button OUT of the accessibility tree entirely while the sheet is open -- confirmed by
   * dumping Chromium's tree across the full cycle, where the button had zero nodes in the open
   * state. So `aria-expanded="true"` is unreachable, the attribute only ever exposes "false",
   * and "collapsed" becomes permanent speech on every focus that can never contrast with
   * anything. The W3C modal-dialog pattern does not ask for it on a trigger.
   *
   * `aria-controls` was never here. The sheet is conditionally mounted, so there is no element
   * to reference until the button has already been pressed, and its <dialog> carries no id in
   * any case. An IDREF to a missing element is precisely the defect the skip link shipped --
   * `href="#main"` on two pages that rendered no `#main`.
   */
  await expect(door).not.toHaveAttribute('aria-expanded', /.*/)
  await expect(door).not.toHaveAttribute('aria-controls', /.*/)

  /*
   * The native element carries what the removed attribute was standing in for: modality, and
   * focus that goes into the dialog and comes back to the opener. That is the behaviour to
   * protect, so it is asserted directly rather than through a state flag.
   */
  await door.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(
    page.evaluate(() => document.activeElement?.closest('dialog') !== null),
  ).resolves.toBe(true)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(cloakDoor(page)).toBeFocused()
})

test('the Cloak sheet opens, says who sees what, and passes axe', async ({ page }) => {
  await page.goto('/')
  await settle(page)

  await cloakDoor(page).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Cloak' })).toBeVisible()
  // The fixture's restricted audiences appear with engine copy, not restated prose.
  await expect(dialog.getByText(/They will/).first()).toBeVisible()

  // NO audience picker in here. The sheet used to render the sidebar's ViewAsBar, so with
  // the sheet open two live "Viewing as" selects sat in the DOM bound to the same state.
  // The rows themselves are the way into a preview now.
  await expect(dialog.getByRole('combobox', { name: /viewing as/i })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /^View as / }).first()).toBeVisible()

  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('Today is a link home that keeps the audience', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Today is tablet-and-up chrome; the week strip owns "now" on phones')
  await page.goto('/?as=contact:alex')
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    /as=contact%3Aalex|as=contact:alex/,
  )
})

test('Today keeps the week view instead of falling to the agenda', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Today is tablet-and-up chrome')
  await page.goto('/')
  await settle(page)

  // On the agenda, Today names the agenda. It used to omit the param entirely, on the
  // reasoning that the server fell back to agenda anyway — which stopped being true when
  // 0022 gave the workspace a stored default view, and made Agenda unreachable for anyone
  // whose default was something else.
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    /view=agenda/,
  )

  // The regression this pins: `view` here is the CLIENT view, and the old builder
  // dropped it for the whole week fetch — Today from Week view landed on the agenda.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    /view=week/,
  )
})

test('the week strip jumps to a day', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the strip is mobile chrome; the mini month covers desktop')
  await page.goto('/')
  await settle(page)

  const strip = page.getByRole('navigation', { name: 'Jump to a day' })
  await expect(strip.locator('a')).toHaveCount(7)
  await strip.locator('a').nth(2).click()
  await expect(page).toHaveURL(/#day-\d{4}-\d{2}-\d{2}$/)
})

test('the sidebar shows the calendars but not the add row in demo mode', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the calendar list is desktop chrome')
  await page.goto('/')
  await settle(page)

  // The list itself renders now (its base hide finally has a desktop counterpart)...
  await expect(page.getByRole('heading', { name: 'My calendars' })).toBeVisible()
  // ...but the add row is a WRITE door with no demo mode: composing is demoable in the
  // fixture now, creating a calendar is not, so this stays absent on purpose.
  await expect(page.getByRole('button', { name: /Add calendar/ })).toHaveCount(0)
})

// The mini month shares its nav name with the mobile week strip, but never its
// breakpoint: this test is desktop-only, so the role query can only match the grid.
test('the sidebar mini month opens a day', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the mini month is desktop chrome; the strip covers mobile')
  await page.goto('/')
  await settle(page)

  const month = page.getByRole('navigation', { name: 'Jump to a day' })
  await expect(month.locator('a')).toHaveCount(42)
  await month.locator('a').first().click()
  await expect(page).toHaveURL(/view=day/)
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/)
})

test('the mini month carries the audience into its day links', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the mini month is desktop chrome; the strip covers mobile')
  await page.goto('/?as=contact:alex')
  // Alex's redacted view has no "Legal Call" to settle on; any visible day link will do.
  const month = page.getByRole('navigation', { name: 'Jump to a day' })
  await expect(month.locator('a').first()).toHaveAttribute('href', /view=day/)
  await expect(month.locator('a').first()).toHaveAttribute(
    'href',
    /as=contact%3Aalex|as=contact:alex/,
  )
})
