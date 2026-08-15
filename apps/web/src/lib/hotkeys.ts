/**
 * THE keyboard bindings, in one place, because two surfaces have to agree about them.
 *
 * The `?` overlay on the calendar and the Settings control both describe this list. They
 * described it separately until now, and Settings described it worst: its only account of
 * the feature was an option reading "On: t, arrows, j/k, 1-4, n, ?", which names the keys
 * and not one of the things they do. Somebody deciding whether to turn shortcuts on could
 * not learn from it what they would be turning on.
 *
 * "Period" rather than "week": the step keys move by whatever the current view measures in,
 * which is a day on Day and a month on Month. Naming a week would be wrong on half the
 * views.
 */
export const HOTKEYS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['t', 'Jump to today'],
  ['← or k', 'Back one period'],
  ['→ or j', 'Forward one period'],
  ['1', 'Agenda view'],
  ['2', 'Week view'],
  ['3', 'Day view'],
  ['4', 'Month view'],
  ['n', 'New event'],
  ['?', 'Show this list'],
]

/**
 * The two conditions worth stating wherever the list appears.
 *
 * Both are the reason single keys are safe to offer at all: they are ignored while you are
 * typing (WCAG 2.1.4's text-entry condition) and while anything modal is open, and they
 * take no modifier, which is what makes them worth having and also why they are opt-in.
 */
export const HOTKEY_CAVEAT =
  'Single keys, no Ctrl or Cmd. They do nothing while you are typing in a field, or while a dialog is open.'
