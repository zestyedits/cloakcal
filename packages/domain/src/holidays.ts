import { Temporal } from '@js-temporal/polyfill'

/**
 * Public holidays and widely-marked observances, computed from rules. No I/O, ever.
 *
 * WHY THIS IS COMPUTED AND NOT FETCHED. Every off-the-shelf answer here is a network call:
 * Nager.Date, Calendarific, or subscribing to Google's holiday ICS feeds. All three would
 * have this product's browser tell a third party "somebody opened their calendar, they are
 * in this country, at this moment", on every render. That is a beacon, and shipping one from
 * an app whose whole claim is "the server cannot read your calendar" is indefensible for the
 * same reason `tools/email-templates.ts` refuses a remote <img>: the tracking pixel does not
 * become acceptable because we promise not to read the logs. A holiday table is small, it
 * changes about once a decade, and the rules are public. So it lives here, it works offline,
 * and it costs one function call.
 *
 * WHY IT IS NOT AN EVENT. A holiday is not stored, not owned, not shared and not cloaked.
 * It never touches `events`, `cloaked_fields`, the CloakStore or `packages/policy` — it is a
 * decoration the view computes for itself. That is a deliberate boundary, and it buys two
 * things. Rule 5 stays intact (no plaintext content row appears anywhere), and a holiday can
 * never carry a privacy level, which it must not: the four privacy inks are learned meaning
 * in this product and Christmas Day is public by definition. There is nothing to redact.
 *
 * DATES ARE DATES. Everything here is `YYYY-MM-DD` and Temporal.PlainDate. No instant, no
 * zone, no `new Date()` on a local value — the same rule the rest of the domain package
 * follows, and doubly load-bearing here: a holiday rendered from a midnight timestamp drifts
 * to the previous day for half the planet, which is the single most common bug in this class
 * of feature.
 *
 * WHAT IS VERIFIED AND WHAT IS NOT, stated rather than implied:
 *   - US federal holidays and their weekend observation rule: confident.
 *   - GB is ENGLAND AND WALES. Scotland (2 Jan, St Andrew's Day) and Northern Ireland
 *     (St Patrick's Day, the Twelfth) differ, and are NOT modelled. Labelled accordingly.
 *   - AU is the NATIONAL set. States add their own (Melbourne Cup, Labour Day, and a
 *     King's Birthday that Queensland and WA hold on other dates) and vary the Easter
 *     Saturday/Sunday rules. Not modelled.
 *   - CA is the FEDERAL set. Provinces differ substantially, notably Quebec.
 *   - NZ's Matariki is not rule-computable — it follows the lunar calendar and is fixed by
 *     statute year by year. It is a table, the table ends, and after it ends the holiday is
 *     OMITTED rather than guessed. See MATARIKI below.
 *
 * Regional variation is why the surface says "Holidays in <region>" and not "your holidays".
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export const HOLIDAY_REGIONS = [
  { id: 'US', label: 'United States' },
  { id: 'GB', label: 'United Kingdom', note: 'England and Wales' },
  { id: 'CA', label: 'Canada', note: 'Federal' },
  { id: 'AU', label: 'Australia', note: 'National' },
  { id: 'IE', label: 'Ireland' },
  { id: 'NZ', label: 'New Zealand' },
] as const

export type HolidayRegion = (typeof HOLIDAY_REGIONS)[number]['id']

const REGION_IDS: readonly string[] = HOLIDAY_REGIONS.map((r) => r.id)

export function isHolidayRegion(value: unknown): value is HolidayRegion {
  return typeof value === 'string' && REGION_IDS.includes(value)
}

/**
 * `public` is a day off. `observance` is a day people mark without closing the office.
 *
 * The split exists because they deserve different weight on screen and, more importantly,
 * different honesty: calling Halloween a public holiday would be wrong, and burying
 * Christmas Day at the same weight as Valentine's Day would be useless.
 */
export type HolidayKind = 'public' | 'observance'

export interface Holiday {
  /** `YYYY-MM-DD`. The date this entry renders on. */
  readonly date: string
  readonly name: string
  readonly kind: HolidayKind
  readonly region: HolidayRegion
  /**
   * True when this is the substitute day for a holiday that fell on a weekend.
   *
   * Both entries are emitted — Christmas Day on Saturday the 25th AND "Christmas Day
   * (observed)" on Monday the 27th — because they answer different questions. One is when
   * the thing is, the other is when the office is shut.
   */
  readonly observed: boolean
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

type Rule =
  /** A calendar date that does not move. */
  | { readonly on: 'fixed'; readonly month: number; readonly day: number }
  /**
   * The nth given weekday of a month. `nth: -1` is the last one.
   * Weekday is ISO: 1 = Monday through 7 = Sunday, matching Temporal.PlainDate.dayOfWeek.
   */
  | { readonly on: 'nth-weekday'; readonly month: number; readonly weekday: number; readonly nth: number }
  /** Offset in days from Easter Sunday. Good Friday is -2, Easter Monday is +1. */
  | { readonly on: 'easter'; readonly offset: number }
  /** The last given weekday falling on or before month/day. Victoria Day is the shape. */
  | { readonly on: 'weekday-on-or-before'; readonly month: number; readonly day: number; readonly weekday: number }
  /** Dates that no rule generates, fixed by statute. Absent year means absent holiday. */
  | { readonly on: 'table'; readonly dates: Readonly<Record<number, string>> }

/**
 * How a holiday behaves when it lands on a weekend.
 *
 * `none`     — nothing happens. Every observance, and holidays that simply are what they are.
 * `us`       — Saturday moves back to Friday, Sunday forward to Monday. The US federal rule.
 * `forward`  — moves to the next weekday not already taken. Covers the UK/IE substitute-day
 *              rule and NZ/AU Mondayisation, which agree on everything except vocabulary.
 *              "Not already taken" is what makes Christmas-on-Saturday and Boxing-Day-on-
 *              Sunday resolve to Monday and TUESDAY rather than both piling onto Monday.
 */
type WeekendRule = 'none' | 'us' | 'forward'

interface HolidaySpec {
  readonly name: string
  readonly kind: HolidayKind
  readonly rule: Rule
  readonly weekend?: WeekendRule
  /** Year this holiday came into existence. Before it, it is not emitted. */
  readonly from?: number
}

/* -------------------------------------------------------------------------- */
/* Easter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gregorian Easter, by the anonymous algorithm (Meeus/Jones/Butcher).
 *
 * Integer arithmetic only, valid for any Gregorian year, and it is the reason five of the
 * six regions here need no lookup table at all. Pinned by test against known dates rather
 * than trusted, because a transcription slip in one of these lines is silent and moves five
 * holidays at once.
 */
export function easterSunday(year: number): Temporal.PlainDate {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return Temporal.PlainDate.from({ year, month: Math.floor(n / 31), day: (n % 31) + 1 })
}

/**
 * Matariki, the Māori new year, fixed by the Te Kāhui o Matariki Public Holiday Act 2022.
 *
 * It tracks a lunar rising, so there is no arithmetic that produces it — the Act simply
 * lists dates. This table is the dates through 2032. **After that the holiday is omitted,
 * deliberately**: an absent holiday is a gap somebody notices and reports, whereas a guessed
 * one is wrong on a day people plan around and nothing ever says so. Extend the table from
 * the Act when it matters; do not interpolate it.
 */
const MATARIKI: Readonly<Record<number, string>> = {
  2022: '2022-06-24',
  2023: '2023-07-14',
  2024: '2024-06-28',
  2025: '2025-06-20',
  2026: '2026-07-10',
  2027: '2027-06-25',
  2028: '2028-07-14',
  2029: '2029-07-06',
  2030: '2030-06-21',
  2031: '2031-07-11',
  2032: '2032-07-02',
}

/* -------------------------------------------------------------------------- */
/* The tables                                                                 */
/* -------------------------------------------------------------------------- */

/** Observances shared by every region here. Kept in one place so they cannot drift apart. */
const COMMON_OBSERVANCES: readonly HolidaySpec[] = [
  { name: "Valentine's Day", kind: 'observance', rule: { on: 'fixed', month: 2, day: 14 } },
  { name: 'Easter Sunday', kind: 'observance', rule: { on: 'easter', offset: 0 } },
  { name: "Father's Day", kind: 'observance', rule: { on: 'nth-weekday', month: 6, weekday: 7, nth: 3 } },
  { name: 'Halloween', kind: 'observance', rule: { on: 'fixed', month: 10, day: 31 } },
  { name: 'Christmas Eve', kind: 'observance', rule: { on: 'fixed', month: 12, day: 24 } },
  { name: "New Year's Eve", kind: 'observance', rule: { on: 'fixed', month: 12, day: 31 } },
]

/** US Mother's Day, and everyone here except the UK follows it. */
const MOTHERS_DAY_MAY: HolidaySpec = {
  name: "Mother's Day",
  kind: 'observance',
  rule: { on: 'nth-weekday', month: 5, weekday: 7, nth: 2 },
}

const TABLES: Readonly<Record<HolidayRegion, readonly HolidaySpec[]>> = {
  US: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'us' },
    { name: 'Martin Luther King Jr. Day', kind: 'public', rule: { on: 'nth-weekday', month: 1, weekday: 1, nth: 3 } },
    { name: "Presidents' Day", kind: 'public', rule: { on: 'nth-weekday', month: 2, weekday: 1, nth: 3 } },
    { name: 'Memorial Day', kind: 'public', rule: { on: 'nth-weekday', month: 5, weekday: 1, nth: -1 } },
    // Federal since 2021. Emitting it for 2019 would be inventing a day off that did not exist.
    { name: 'Juneteenth', kind: 'public', rule: { on: 'fixed', month: 6, day: 19 }, weekend: 'us', from: 2021 },
    { name: 'Independence Day', kind: 'public', rule: { on: 'fixed', month: 7, day: 4 }, weekend: 'us' },
    { name: 'Labor Day', kind: 'public', rule: { on: 'nth-weekday', month: 9, weekday: 1, nth: 1 } },
    { name: 'Columbus Day', kind: 'public', rule: { on: 'nth-weekday', month: 10, weekday: 1, nth: 2 } },
    { name: 'Veterans Day', kind: 'public', rule: { on: 'fixed', month: 11, day: 11 }, weekend: 'us' },
    { name: 'Thanksgiving', kind: 'public', rule: { on: 'nth-weekday', month: 11, weekday: 4, nth: 4 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'us' },
    MOTHERS_DAY_MAY,
    { name: "St Patrick's Day", kind: 'observance', rule: { on: 'fixed', month: 3, day: 17 } },
    ...COMMON_OBSERVANCES,
  ],

  GB: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'forward' },
    { name: 'Good Friday', kind: 'public', rule: { on: 'easter', offset: -2 } },
    { name: 'Easter Monday', kind: 'public', rule: { on: 'easter', offset: 1 } },
    { name: 'Early May Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 5, weekday: 1, nth: 1 } },
    { name: 'Spring Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 5, weekday: 1, nth: -1 } },
    { name: 'Summer Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 8, weekday: 1, nth: -1 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'forward' },
    { name: 'Boxing Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 26 }, weekend: 'forward' },
    // Mothering Sunday, not the May date. It is the fourth Sunday of Lent, so Easter-relative.
    { name: "Mother's Day", kind: 'observance', rule: { on: 'easter', offset: -21 } },
    { name: 'Bonfire Night', kind: 'observance', rule: { on: 'fixed', month: 11, day: 5 } },
    { name: 'Remembrance Sunday', kind: 'observance', rule: { on: 'nth-weekday', month: 11, weekday: 7, nth: 2 } },
    ...COMMON_OBSERVANCES,
  ],

  CA: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'forward' },
    { name: 'Good Friday', kind: 'public', rule: { on: 'easter', offset: -2 } },
    // The Monday on or before 24 May. The one rule here that no other region shares.
    { name: 'Victoria Day', kind: 'public', rule: { on: 'weekday-on-or-before', month: 5, day: 24, weekday: 1 } },
    { name: 'Canada Day', kind: 'public', rule: { on: 'fixed', month: 7, day: 1 }, weekend: 'forward' },
    { name: 'Labour Day', kind: 'public', rule: { on: 'nth-weekday', month: 9, weekday: 1, nth: 1 } },
    {
      name: 'National Day for Truth and Reconciliation',
      kind: 'public',
      rule: { on: 'fixed', month: 9, day: 30 },
      weekend: 'forward',
      from: 2021,
    },
    { name: 'Thanksgiving', kind: 'public', rule: { on: 'nth-weekday', month: 10, weekday: 1, nth: 2 } },
    { name: 'Remembrance Day', kind: 'public', rule: { on: 'fixed', month: 11, day: 11 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'forward' },
    { name: 'Boxing Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 26 }, weekend: 'forward' },
    MOTHERS_DAY_MAY,
    ...COMMON_OBSERVANCES,
  ],

  AU: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'forward' },
    { name: 'Australia Day', kind: 'public', rule: { on: 'fixed', month: 1, day: 26 }, weekend: 'forward' },
    { name: 'Good Friday', kind: 'public', rule: { on: 'easter', offset: -2 } },
    { name: 'Easter Saturday', kind: 'public', rule: { on: 'easter', offset: -1 } },
    { name: 'Easter Monday', kind: 'public', rule: { on: 'easter', offset: 1 } },
    // Anzac Day is NOT Mondayised in every state, and the states that do differ. Left on its
    // date, which is the one thing all of them agree on.
    { name: 'Anzac Day', kind: 'public', rule: { on: 'fixed', month: 4, day: 25 } },
    { name: "King's Birthday", kind: 'public', rule: { on: 'nth-weekday', month: 6, weekday: 1, nth: 2 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'forward' },
    { name: 'Boxing Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 26 }, weekend: 'forward' },
    MOTHERS_DAY_MAY,
    ...COMMON_OBSERVANCES,
  ],

  IE: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'forward' },
    // St Brigid's Day, new in 2023: the first Monday in February, except when 1 February is
    // itself a Friday. That exception is handled in `resolve`, not expressible as a Rule.
    { name: "St Brigid's Day", kind: 'public', rule: { on: 'nth-weekday', month: 2, weekday: 1, nth: 1 }, from: 2023 },
    { name: "St Patrick's Day", kind: 'public', rule: { on: 'fixed', month: 3, day: 17 }, weekend: 'forward' },
    { name: 'Easter Monday', kind: 'public', rule: { on: 'easter', offset: 1 } },
    { name: 'May Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 5, weekday: 1, nth: 1 } },
    { name: 'June Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 6, weekday: 1, nth: 1 } },
    { name: 'August Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 8, weekday: 1, nth: 1 } },
    { name: 'October Bank Holiday', kind: 'public', rule: { on: 'nth-weekday', month: 10, weekday: 1, nth: -1 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'forward' },
    { name: "St Stephen's Day", kind: 'public', rule: { on: 'fixed', month: 12, day: 26 }, weekend: 'forward' },
    { name: "Mother's Day", kind: 'observance', rule: { on: 'easter', offset: -21 } },
    ...COMMON_OBSERVANCES,
  ],

  NZ: [
    { name: "New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 1 }, weekend: 'forward' },
    { name: "Day after New Year's Day", kind: 'public', rule: { on: 'fixed', month: 1, day: 2 }, weekend: 'forward' },
    { name: 'Waitangi Day', kind: 'public', rule: { on: 'fixed', month: 2, day: 6 }, weekend: 'forward' },
    { name: 'Good Friday', kind: 'public', rule: { on: 'easter', offset: -2 } },
    { name: 'Easter Monday', kind: 'public', rule: { on: 'easter', offset: 1 } },
    { name: 'Anzac Day', kind: 'public', rule: { on: 'fixed', month: 4, day: 25 }, weekend: 'forward' },
    { name: "King's Birthday", kind: 'public', rule: { on: 'nth-weekday', month: 6, weekday: 1, nth: 1 } },
    { name: 'Matariki', kind: 'public', rule: { on: 'table', dates: MATARIKI }, from: 2022 },
    { name: 'Labour Day', kind: 'public', rule: { on: 'nth-weekday', month: 10, weekday: 1, nth: 4 } },
    { name: 'Christmas Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 25 }, weekend: 'forward' },
    { name: 'Boxing Day', kind: 'public', rule: { on: 'fixed', month: 12, day: 26 }, weekend: 'forward' },
    MOTHERS_DAY_MAY,
    ...COMMON_OBSERVANCES,
  ],
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/** The nth given weekday of a month; `nth: -1` means the last one. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): Temporal.PlainDate {
  const first = Temporal.PlainDate.from({ year, month, day: 1 })
  if (nth < 0) {
    const last = first.with({ day: first.daysInMonth })
    const back = (last.dayOfWeek - weekday + 7) % 7
    return last.subtract({ days: back + (-nth - 1) * 7 })
  }
  const forward = (weekday - first.dayOfWeek + 7) % 7
  return first.add({ days: forward + (nth - 1) * 7 })
}

/** The date a spec falls on in a given year, before any weekend substitution. */
function resolve(spec: HolidaySpec, year: number, region: HolidayRegion): Temporal.PlainDate | null {
  const rule = spec.rule
  switch (rule.on) {
    case 'fixed':
      return Temporal.PlainDate.from({ year, month: rule.month, day: rule.day })
    case 'nth-weekday': {
      const date = nthWeekday(year, rule.month, rule.weekday, rule.nth)
      // The one statutory exception that is not worth a rule variant of its own: Ireland's
      // St Brigid's Day is the first Monday in February UNLESS 1 February is a Friday, in
      // which case it is that Friday.
      if (region === 'IE' && spec.name === "St Brigid's Day") {
        const first = Temporal.PlainDate.from({ year, month: 2, day: 1 })
        if (first.dayOfWeek === 5) return first
      }
      return date
    }
    case 'easter':
      return easterSunday(year).add({ days: rule.offset })
    case 'weekday-on-or-before': {
      const target = Temporal.PlainDate.from({ year, month: rule.month, day: rule.day })
      return target.subtract({ days: (target.dayOfWeek - rule.weekday + 7) % 7 })
    }
    case 'table': {
      const iso = rule.dates[year]
      return iso === undefined ? null : Temporal.PlainDate.from(iso)
    }
  }
}

const isWeekend = (d: Temporal.PlainDate): boolean => d.dayOfWeek >= 6

/**
 * Every holiday a region has in one calendar year, substitutes included.
 *
 * Two passes, and the order matters. The actual dates are resolved first and claimed in a
 * set; only then are substitutes placed, each walking forward to the first weekday nobody
 * has taken. Without that set, Christmas Day on a Saturday and Boxing Day on a Sunday both
 * resolve to the same Monday and one of them silently disappears.
 */
export function holidaysForYear(region: HolidayRegion, year: number): Holiday[] {
  const specs = TABLES[region]
  const out: Holiday[] = []
  const taken = new Set<string>()

  const resolved: { spec: HolidaySpec; date: Temporal.PlainDate }[] = []
  for (const spec of specs) {
    if (spec.from !== undefined && year < spec.from) continue
    const date = resolve(spec, year, region)
    if (date === null) continue
    resolved.push({ spec, date })
    out.push({
      date: date.toString(),
      name: spec.name,
      kind: spec.kind,
      region,
      observed: false,
    })
    if (spec.kind === 'public') taken.add(date.toString())
  }

  for (const { spec, date } of resolved) {
    const weekend = spec.weekend ?? 'none'
    if (weekend === 'none' || !isWeekend(date)) continue

    let moved: Temporal.PlainDate
    if (weekend === 'us') {
      // Saturday back to Friday, Sunday forward to Monday. No collision handling, because
      // the US set has no two federal holidays close enough to collide.
      moved = date.dayOfWeek === 6 ? date.subtract({ days: 1 }) : date.add({ days: 1 })
    } else {
      moved = date.add({ days: 1 })
      while (isWeekend(moved) || taken.has(moved.toString())) moved = moved.add({ days: 1 })
    }

    taken.add(moved.toString())
    out.push({
      date: moved.toString(),
      name: `${spec.name} (observed)`,
      kind: spec.kind,
      region,
      observed: true,
    })
  }

  return out.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)))
}

/**
 * Holidays landing in `[from, to)` — half-open, matching expandSeries.
 *
 * Neighbouring years are computed too, and that is not defensive padding: a US New Year's
 * Day falling on a Saturday is observed on 31 December of the PREVIOUS year, so asking only
 * for the year in the range loses a real day off at exactly the boundary people look at.
 */
export function holidaysInRange(region: HolidayRegion, from: string, to: string): Holiday[] {
  const start = Temporal.PlainDate.from(from)
  const end = Temporal.PlainDate.from(to)
  if (Temporal.PlainDate.compare(end, start) < 0) return []

  const out: Holiday[] = []
  for (let year = start.year - 1; year <= end.year + 1; year += 1) {
    for (const holiday of holidaysForYear(region, year)) {
      if (holiday.date >= from && holiday.date < to) out.push(holiday)
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)))
}

/** Holidays in a range, grouped by date, for the views that render per-day. */
export function holidaysByDate(
  region: HolidayRegion,
  from: string,
  to: string,
): ReadonlyMap<string, readonly Holiday[]> {
  const map = new Map<string, Holiday[]>()
  for (const holiday of holidaysInRange(region, from, to)) {
    const bucket = map.get(holiday.date)
    if (bucket === undefined) map.set(holiday.date, [holiday])
    else bucket.push(holiday)
  }
  return map
}

/** Dates to holidays, `YYYY-MM-DD` keyed. A Record, because it crosses the RSC boundary. */
export type HolidayMap = Readonly<Record<string, readonly Holiday[]>>

/**
 * The one label for a day, for the surfaces that have room for exactly one.
 *
 * Public outranks observance, because "the office is shut" is the fact worth the pixels when
 * only one fits — Christmas Day beats Christmas Eve on the rare years they collide, and
 * Boxing Day beats nothing at all. Ties keep the caller's order, which the functions above
 * have already sorted by name, so the choice is stable across renders rather than depending
 * on map iteration order.
 *
 * Lives here rather than beside the view that needs it because it is pure and because
 * `apps/web/src/server/holidays.ts` is `server-only`: the client components that render a
 * day heading could not import it from there.
 */
export function primaryHoliday(holidays: readonly Holiday[] | undefined): Holiday | undefined {
  if (holidays === undefined || holidays.length === 0) return undefined
  return holidays.find((h) => h.kind === 'public') ?? holidays[0]
}

/* -------------------------------------------------------------------------- */
/* Guessing a region                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Canadian zones, listed because they share the `America/` prefix with the US.
 *
 * Without this the prefix test below would hand every Canadian a US calendar, which is the
 * single most likely wrong answer this function could give.
 */
const CANADA_ZONES: ReadonlySet<string> = new Set([
  'America/St_Johns',
  'America/Halifax',
  'America/Glace_Bay',
  'America/Moncton',
  'America/Goose_Bay',
  'America/Toronto',
  'America/Nipigon',
  'America/Thunder_Bay',
  'America/Iqaluit',
  'America/Pangnirtung',
  'America/Winnipeg',
  'America/Rainy_River',
  'America/Resolute',
  'America/Rankin_Inlet',
  'America/Regina',
  'America/Swift_Current',
  'America/Edmonton',
  'America/Cambridge_Bay',
  'America/Yellowknife',
  'America/Inuvik',
  'America/Creston',
  'America/Dawson_Creek',
  'America/Fort_Nelson',
  'America/Vancouver',
  'America/Whitehorse',
  'America/Dawson',
  'America/Montreal',
])

/**
 * A best guess at the region from an IANA zone, used only as the DEFAULT.
 *
 * Deliberately narrow and deliberately nullable. A zone is not a country — Europe/London is
 * one, America/New_York is one, and Europe/Dublin genuinely is Ireland, but plenty of zones
 * map to nothing here and a wrong guess puts the wrong country's days off on somebody's
 * calendar. Null means "we do not know", which the settings screen turns into an explicit
 * question rather than a silent assumption.
 */
/**
 * What a workspace has chosen, which is deliberately three states in ONE value.
 *
 * `auto` — follow the timezone, and show nothing if the timezone maps to no region here.
 * `off`  — the user said no.
 * a code — the user said which, and it outranks the timezone.
 *
 * A boolean-plus-region pair would be the obvious alternative and is strictly worse: it can
 * represent "enabled, region null" and "disabled, region US", two states that mean nothing
 * and that every reader would then have to decide about independently. Same argument as the
 * plan table's "absence means Free" — make the bad state unrepresentable rather than
 * handling it in four places.
 *
 * `auto` is the default because a calendar with the local public holidays already on it is
 * the thing people expect, and `off` is one click away in the sidebar.
 */
export type HolidayPreference = 'auto' | 'off' | HolidayRegion

export const HOLIDAY_PREFERENCE_DEFAULT: HolidayPreference = 'auto'

export function isHolidayPreference(value: unknown): value is HolidayPreference {
  return value === 'auto' || value === 'off' || isHolidayRegion(value)
}

/**
 * The region actually rendered, or null for "show none".
 *
 * The one place `auto` is interpreted. Everything downstream takes a `HolidayRegion | null`
 * and never sees the preference, so no view has to know the tri-state exists.
 */
export function resolveHolidayRegion(
  preference: HolidayPreference,
  timezone: string,
): HolidayRegion | null {
  if (preference === 'off') return null
  if (preference === 'auto') return regionFromTimezone(timezone)
  return preference
}

export function regionFromTimezone(timezone: string): HolidayRegion | null {
  if (timezone === 'Europe/London') return 'GB'
  if (timezone === 'Europe/Dublin') return 'IE'
  if (timezone.startsWith('Australia/')) return 'AU'
  if (timezone.startsWith('Pacific/Auckland') || timezone.startsWith('Pacific/Chatham')) return 'NZ'
  if (CANADA_ZONES.has(timezone)) return 'CA'
  if (timezone.startsWith('America/') || timezone.startsWith('US/') || timezone === 'Pacific/Honolulu') {
    return 'US'
  }
  return null
}
