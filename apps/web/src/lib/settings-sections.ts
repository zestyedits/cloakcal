/**
 * THE settings sections — id, label and order — in one copy, for two consumers: the real
 * screen's rail and cards, and the loading fallback's inert chrome. Exactly the shape and
 * exactly the reasoning of `lib/calendar-views.ts`, including why it is a separate module
 * rather than an export from the screen.
 *
 * IT HAS TO LIVE HERE. `settings-screen.tsx` is `'use client'`, and a server component that
 * imports a non-component value from a client module does not get the value — it gets a
 * client-reference proxy, and `SECTIONS.map is not a function` at render time. That was not
 * a theory: exporting it from the screen and importing it into `loading.tsx` threw on every
 * settings load, and because the throw happened inside a Suspense fallback the page came
 * back with the shell rendered twice rather than with an error. Two `<h1>`s and ten
 * `<details>` where five belonged.
 *
 * Five cards, down from seven. Two of the seven held no settings at all: People was a lede
 * and a link across to /people, and "Coming soon" was four rows of things that do not
 * exist — both wearing the same card, chevron and weight as the cards that work. People
 * merged into the card that decides what people see; the deferred list became a footer that
 * is not a card; Security became a signpost to /settings/security.
 */
/**
 * Each card carries a DESCRIPTION as well as a name, and that is hierarchy rather than
 * decoration. A closed page of five rows reading only "APPEARANCE · Month · shortcuts off"
 * gives the eye one weight and no way in: every row looks like every other row, and the
 * state string is the only thing that varies. Name, then what it is for, then its current
 * value gives three levels to scan instead of one.
 */
export const SECTIONS = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, the view your calendar opens on, and the keyboard.',
  },
  {
    id: 'time-region',
    label: 'Time & region',
    description: 'Your timezone, and the day your week starts on.',
  },
  {
    id: 'calendars',
    label: 'Calendars',
    description: 'Names and colours, and adding another one.',
  },
  {
    id: 'sharing',
    label: 'People & sharing',
    description: 'Your contacts, and what the link and each group see by default.',
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Password, passkeys, recovery phrase, and the devices that can open your calendar.',
  },
] as const
