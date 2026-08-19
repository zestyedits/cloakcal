'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { todayQuery, viewQuery } from '@/lib/calendar-links'
import { HEADER_VIEWS, NAV_LEADING, NAV_TRAILING, VIEW_LABELS } from '@/lib/calendar-views'
import { wallTimeLabel } from '@/lib/wall-time'
import { savedDateLabel, type DeletedEvent, type SavedEvent } from '@/lib/saved-event'
import { armFirstRun } from '@/lib/first-run'
import { FirstAudiencePrompt } from './first-audience-prompt'
import { CalendarNotice } from './calendar-notice'
import { UndoDelete } from './undo-delete'
import { CalendarHotkeys } from './calendar-hotkeys'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedOccurrence, RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { withViewTransition } from '@/lib/view-transition'
import { CloakProvider, type ExtraSealedField } from './cloak-provider'
import {
  AudienceCover,
  AudienceTransitionProvider,
  AudienceWidening,
  SealableMain,
} from './audience-transition'
import { CloakedText } from './cloaked-text'
import { ViewAsBar } from './view-as-bar'
import { DefaultViewControl } from './default-view-control'
import { NewCalendarButton } from './new-calendar'
import { WeekGrid } from './week-grid'
import { NewEvent, NewEventButton } from './new-event'
import { EditableEvent } from './editable-event'
import { CloakHomeLink, CloakMark } from './cloak-logo'
import { ThemeToggle } from './theme-toggle'
import { MiniMonth } from './mini-month'
import { MonthGrid } from './month-grid'
import { PreviewBar } from './preview-bar'
import { WeekStrip } from './week-strip'
import { CloakSheet } from './cloak-sheet'
import { SeedSampleEvents } from './seed-sample-events'
import { SignOutButton } from './sign-out-button'
import { VisibilitySheet } from './visibility-sheet'
import { ButtonLink } from './ui/button'
import { NavPendingMark } from './ui/nav-pending'
import { PrivacyChip } from './ui/privacy-chip'
import { PlanBadge } from './ui/plan-badge'
import { HolidayToggle } from './holiday-toggle'
import { primaryHoliday, type HolidayMap, type HolidayPreference, type HolidayRegion } from '@cloakcal/domain'
import type { AvailabilityWeek } from '@/server/availability'
import type { PlanId } from '@/lib/plans'
import styles from './calendar-screen.module.css'

/**
 * The M1/M2 shell: agenda view, navigation frame, and View As.
 *
 * Everything rendered here has already been through the policy engine server-side. A
 * `busy` occurrence arrives with no fields and no calendar id at all — there is nothing
 * for this component to withhold, which is the point.
 */

/**
 * Agenda and Week read the SAME page of occurrences — one server fetch, already redacted —
 * so switching between them is a pure presentation choice and stays on the client. Day
 * and Month need a different range, so they are SERVER NAVIGATIONS like the ‹ › steps.
 * The nav therefore renders two kinds of control from one descriptor list: toggles
 * (agenda/week, only while the page holds the week fetch) and links (everything else).
 */
export type CalendarView = 'agenda' | 'week' | 'day' | 'month'

/** The number row bindings the hotkey layer owns; advertised on the controls they mirror. */
const VIEW_KEY_HINTS: Record<CalendarView, string> = {
  agenda: '1',
  week: '2',
  day: '3',
  month: '4',
}

type NavItem =
  | { readonly id: CalendarView; readonly kind: 'toggle'; readonly active: boolean }
  | { readonly id: CalendarView; readonly kind: 'link'; readonly active: boolean; readonly href: WeekLink }

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

const timeOf = wallTimeLabel

export interface WeekLink {
  readonly pathname: '/'
  readonly query: Record<string, string>
}

function groupByDay(occurrences: readonly RedactedOccurrence[]) {
  const days = new Map<string, RedactedOccurrence[]>()
  for (const occurrence of occurrences) {
    const day = occurrence.occurrenceLocal.slice(0, 10)
    const bucket = days.get(day)
    if (bucket === undefined) days.set(day, [occurrence])
    else bucket.push(occurrence)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * A stable empty map, for the same reason `cloak-provider.tsx` has one: an inline `{}` default
 * is a fresh identity on every render, and `holidays` is in the occurrence memo's dependency
 * array. Here that only defeats the memo rather than looping an effect, so it costs a recompute
 * per render and shows no symptom at all — which is why it survived until a sweep went looking.
 */
const NO_HOLIDAYS: HolidayMap = Object.freeze({})

export function CalendarScreen({
  page,
  audiences,
  view: serverView = 'agenda',
  anchorDate,
  heading,
  previousHref,
  nextHref,
  timezone,
  weekStart = 0,
  workspaceRules = [],
  rulesByEvent = {},
  groupsByContact = {},
  email,
  composeDate,
  demoMode = false,
  hotkeysEnabled = false,
  defaultView = 'agenda',
  workspaceId = null,
  plan = 'free',
  holidays = NO_HOLIDAYS,
  holidayRegion = null,
  holidayPreference = 'auto',
  availability = {},
}: {
  page: RedactedPage
  audiences: readonly AudienceOption[]
  /** The view the SERVER fetched for. agenda/week share the week fetch. */
  view?: CalendarView
  /** YYYY-MM-DD the view is anchored on; view links carry it so navigation stays put. */
  anchorDate?: string | undefined
  heading: string
  /* URL objects rather than strings: `typedRoutes` will not accept a computed href string,
     and a UrlObject is the escape hatch Next provides for exactly this — a fixed pathname
     with a query built at request time. */
  previousHref: WeekLink
  nextHref: WeekLink
  timezone: string
  weekStart?: number
  /** Workspace-level rules, for the Cloak sheet's per-audience summaries. */
  workspaceRules?: readonly VisibilityRule[]
  /** Event-scoped rules, keyed by event id. Owner-only; empty for every other audience. */
  rulesByEvent?: Readonly<Record<string, readonly VisibilityRule[]>>
  groupsByContact?: Readonly<Record<string, readonly string[]>>
  email?: string | undefined
  /** YYYY-MM-DD the compose sheet opens on. Absent means composing is unavailable. */
  composeDate?: string | undefined
  /**
   * Fixture mode: the compose sheet opens and cannot write (see NewEvent.demo). The WRITE
   * doors that have no demo mode — the add-calendar row, the sample-event seeder — gate on
   * this separately, because "you can open the form" and "you can change data" stopped
   * being the same fact when the demo gained a compose path.
   */
  demoMode?: boolean
  /** The stored keyboard opt-in. Off unmounts the layer entirely; no listener, no `?`. */
  hotkeysEnabled?: boolean
  /** The stored default view, so the sidebar can say whether this one already is it. */
  defaultView?: CalendarView
  /** Where a preference write goes. Null with demoMode false means it cannot go anywhere. */
  workspaceId?: string | null
  /**
   * The tier this account is on, for the badge in the account cluster. Read server-side by
   * server/plan.ts; absence of a `subscriptions` row means free (migration 0024). Only ever
   * rendered where there is a real session, since the cluster itself is gated on one.
   */
  plan?: PlanId
  /**
   * Public holidays for the window around the anchor, keyed `YYYY-MM-DD`.
   *
   * NOT events, and the type is separate from RedactedOccurrence to keep it that way. These
   * are computed from a rule table (packages/domain/src/holidays.ts), never stored, never
   * owned and never cloaked — so nothing here carries a privacy level, an id, or a door into
   * an edit sheet. A holiday is public by definition and has nothing to redact.
   */
  holidays?: HolidayMap
  /** The region actually drawn, or null for "none". Labels the sidebar row. */
  holidayRegion?: HolidayRegion | null
  /** The stored tri-state, so the row can distinguish "off" from "on, nothing to show". */
  holidayPreference?: HolidayPreference
  /**
   * Weekly availability (0027). Only the week and day grids draw it — the agenda has no
   * time axis to shade and the month grid is far too dense for another layer.
   */
  availability?: AvailabilityWeek
}) {
  // The client half of the view state: only meaningful while the page holds the week
  // fetch, where agenda <-> week is an instant presentation toggle. On a day or month
  // page the server view wins and this is inert.
  const router = useRouter()
  const onWeekFetch = serverView !== 'day' && serverView !== 'month'
  const [clientView, setClientView] = useState<'agenda' | 'week'>(
    serverView === 'week' ? 'week' : 'agenda',
  )
  const view: CalendarView = onWeekFetch ? clientView : serverView
  const [composeOpen, setComposeOpen] = useState(false)
  /** The grid slot a compose was opened from; null = the buttons' anchor-date default. */
  const [composeSlot, setComposeSlot] = useState<{ date: string; time: string } | null>(null)
  const [cloakOpen, setCloakOpen] = useState(false)
  /** Event id whose visibility sheet is open, or null. */
  const [visibilityFor, setVisibilityFor] = useState<string | null>(null)
  /**
   * The last successful write, with the anchor it belongs to.
   *
   * `anchor` is what retires the notice: it is the anchorDate this result is ABOUT, recorded
   * at report time — including the date we are about to navigate to. Clearing on any
   * navigation instead would kill the notice for the one navigation the save itself caused,
   * which is the case it exists for. Any later step, Today or view change moves anchorDate
   * away from it and the strip goes.
   */
  const [saved, setSaved] = useState<{ result: SavedEvent; anchor: string } | null>(null)
  const savedNotice = saved !== null && saved.anchor === anchorDate ? saved.result : null
  /**
   * The last delete, held so it can be undone.
   *
   * Not anchored to a date like `saved` is, and deliberately: a deleted event has no row left
   * to scroll to, so the strip is the ONLY thing standing between the user and a trip to the
   * trash page. It survives stepping between weeks and goes when it is used, dismissed, or
   * replaced. It is also never timed — see undo-delete.tsx.
   */
  const [deleted, setDeleted] = useState<DeletedEvent | null>(null)
  const days = useMemo(() => groupByDay(page.occurrences), [page.occurrences])

  /**
   * What the agenda lists: every day holding an occurrence, PLUS any day in the fetched
   * week that carries a holiday and nothing else.
   *
   * Without the second half the feature is invisible in the default view for most of the
   * holidays worth having — Christmas Day is a day off precisely because nothing is booked
   * on it, so grouping strictly by occurrence hides exactly the days people want to see.
   * Built from the RANGE, the same reasoning as WeekGrid's day columns: an agenda that
   * silently omits a quiet day is not showing the week.
   *
   * The empty-state check below still keys off `days`, deliberately. A week with one
   * holiday and no events has nothing scheduled, and "Nothing scheduled this week" is
   * still the true and useful thing to say.
   *
   * A REJECTED ALTERNATIVE, recorded because it will be proposed again: rendering all
   * seven days with a "Nothing scheduled" line for the empty ones, to give the list a
   * rhythm. Tried and measured rather than argued about, and it costs 74px per empty day
   * on a phone where the calendar already begins several hundred pixels down behind the
   * header, the View As card and the week strip. Two visible rows became one. The rhythm
   * it was meant to supply now comes from the day group being one surface (`.events` in
   * the stylesheet), which costs no height at all. The code below is unchanged by that
   * decision — it always behaved this way.
   */
  const agendaDays = useMemo(() => {
    const merged = new Map(days)
    const labels = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const first = new Date(page.from)
    for (let index = 0; index < 7; index += 1) {
      const day = labels.format(new Date(first.getTime() + index * 86_400_000))
      if (holidays[day] !== undefined && !merged.has(day)) merged.set(day, [])
    }
    return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [days, holidays, page.from, timezone])

  // Running index of each day's first row across the whole agenda, so the entrance
  // stagger flows through the list rather than restarting at every day heading. The cap
  // lives here (not in CSS) so the delay math stays a plain multiplication.
  const staggerBase = useMemo(() => {
    const base = new Map<string, number>()
    let n = 0
    for (const [day, occurrences] of days) {
      base.set(day, n)
      n += occurrences.length
    }
    return base
  }, [days])

  const colorFor = useMemo(() => {
    const map = new Map(page.calendars.map((c) => [c.id, c.colorToken]))
    return (calendarId: string | undefined) =>
      calendarId === undefined ? 'slate' : (map.get(calendarId) ?? 'indigo')
  }, [page.calendars])

  // The audience names, handed to the store so useCloakedLabels can open them — the
  // ingest half of the defect described on CloakProvider.extraFields.
  const audienceNames = useMemo<readonly ExtraSealedField[]>(
    () =>
      audiences.flatMap((option) =>
        option.nameField === undefined
          ? []
          : [
              {
                subjectType: option.kind === 'group' ? ('contact_group' as const) : ('contact' as const),
                subjectId: option.id,
                field: option.nameField,
              },
            ],
      ),
    [audiences],
  )

  /**
   * One href builder for every view link: anchored where the user already is, carrying
   * the audience, and always NAMING its view — including agenda. This used to say
   * "minimal for the agenda default", which is the reasoning calendar-links.ts now spends
   * its header refuting: once a workspace could store a default view, an agenda link with
   * no view param resolved to whatever that default was.
   */
  const hrefFor = (target: CalendarView): WeekLink => ({
    pathname: '/',
    query: viewQuery(target, anchorDate, page.audience),
  })

  /**
   * Hover/focus intent starts the FULL RSC fetch for a navigation the user is about to
   * make. Every page here is force-dynamic, so Next's default viewport prefetch stops at
   * the loading boundary and the data round trip still lands entirely after the click;
   * `router.prefetch` without options is PrefetchKind.FULL, which moves it into the
   * hover-to-click gap instead. Deliberately only on the header's repeat controls, not
   * the mini month or the month grid — sweeping a pointer across 42 cells would fire 42
   * speculative server renders for one click.
   *
   * Staleness is bounded: entries are keyed by the full URL (so ?as= keeps audiences
   * apart — nothing redacted is ever served across audiences), every mutation path ends
   * in router.refresh() which drops the cache, and nothing changes server-side between
   * navs except through those mutations.
   *
   * PRODUCTION-ONLY, and no test here can see it: createPrefetchURL returns null under
   * NODE_ENV=development ("improves compilation performance", in Next's words), which is
   * every dev run, every Playwright project and the fixture. The pending wash below is
   * what those environments verify; this line is verified by reading Next's source, and
   * costs a no-op function call anywhere it is dormant.
   */
  const primeLink = (link: WeekLink) => () => {
    router.prefetch(`/?${new URLSearchParams(link.query)}`)
  }

  /** The hotkey layer's view switch: same semantics as clicking the control. */
  const selectView = (target: CalendarView) => {
    if (onWeekFetch && (target === 'agenda' || target === 'week')) {
      withViewTransition(() => setClientView(target === 'week' ? 'week' : 'agenda'))
    } else if (target !== view) {
      router.push(`/?${new URLSearchParams(viewQuery(target, anchorDate, page.audience))}`)
    }
  }

  /** Agenda/week toggle while the week fetch is on the page; a real navigation otherwise. */
  const navItemFor = (target: CalendarView): NavItem =>
    onWeekFetch && (target === 'agenda' || target === 'week')
      ? { id: target, kind: 'toggle', active: view === target }
      : { id: target, kind: 'link', active: view === target, href: hrefFor(target) }

  const stepUnit = view === 'day' ? 'day' : view === 'month' ? 'month' : 'week'

  /** One compose gate for every trigger: a date to open on, and the owner's own eyes. */
  const canCompose = composeDate !== undefined && page.audience === 'owner'

  /** The wall dates this page is actually showing, as an inclusive `YYYY-MM-DD` pair. */
  const visibleDates = useMemo(() => {
    const labels = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return {
      first: labels.format(new Date(page.from)),
      // `to` is exclusive, so the last visible day is the instant before it.
      last: labels.format(new Date(new Date(page.to).getTime() - 1)),
    }
  }, [page.from, page.to, timezone])

  /**
   * WHAT HAPPENS AFTER A WRITE, and it differs by action because they are different promises.
   *
   * CREATE may move you: you asked for a new thing and a calendar that makes one and then
   * refuses to show it is behaving like a database form. If it landed off this page, go there.
   *
   * EDIT MUST NOT. You were working here, and retiming an event out of the current week is
   * not a request to leave the week — so the strip names where it went and offers a door,
   * and nothing moves unless the door is taken.
   *
   * Either way the row itself wears the ring, which is the actual confirmation; the sentence
   * only names the date, because a title is ciphertext and never crosses into this string.
   */
  const reportDeleted = (info: DeletedEvent) => {
    // One result at a time. Two strips would make two competing claims about what just
    // happened, and the older one is always the less interesting.
    setSaved(null)
    setDeleted(info)
  }

  const reportSaved = (result: SavedEvent) => {
    setDeleted(null)
    // Arms the first-contact invitation. Idempotent, and never cleared: see lib/first-run.
    armFirstRun()
    const offPage = result.date < visibleDates.first || result.date > visibleDates.last
    const goThere = result.kind === 'created' && offPage
    setSaved({ result, anchor: goThere ? result.date : (anchorDate ?? result.date) })
    if (goThere) {
      router.push(`/?${new URLSearchParams(viewQuery(view, result.date, page.audience))}`)
    }
  }

  /** Whether a wall date falls outside what this page is showing. */
  const offPage = (date: string) => date < visibleDates.first || date > visibleDates.last

  /**
   * Bring the saved row into view, and — for a CREATE only — put focus on it.
   *
   * WHY IT WATCHES page.occurrences. A create finishes with router.refresh(), so at the moment
   * `saved` is set the new row does not exist in the DOM yet; querying then finds nothing. The
   * refresh re-renders this component with new occurrences, which re-runs this, and by then it
   * is there. The ref stops it firing twice for the same write and stealing focus back from
   * wherever the user has since moved.
   *
   * FOCUS MOVES ONLY FOR A CREATE, per the split above: you asked for a new object and focus
   * belongs on the object. An edit returns focus to the sheet's trigger, which is what the
   * native <dialog> already does correctly and what someone editing a row in place expects.
   *
   * No `behavior` argument, so the platform decides: nothing in this app sets
   * `scroll-behavior: smooth`, and globals.css forces `auto` under reduced motion anyway.
   * `block: 'nearest'` scrolls the minimum required, so a row already on screen does not move.
   */
  const announced = useRef<string | null>(null)
  useEffect(() => {
    if (savedNotice === null) {
      announced.current = null
      return
    }
    if (announced.current === savedNotice.eventId) return
    const row = document.querySelector('[data-just-saved]')
    if (row === null) return

    announced.current = savedNotice.eventId
    row.scrollIntoView({ block: 'nearest' })
    if (savedNotice.kind === 'created') {
      const target = row.querySelector('button, a')
      if (target instanceof HTMLElement) target.focus()
    }
  }, [savedNotice, page.occurrences])

  /** The door offered when an edit moved an event off the page, rather than moving the user. */
  const savedHref = (date: string): WeekLink => ({
    pathname: '/',
    query: viewQuery(view, date, page.audience),
  })

  /** Open the compose sheet, from a grid slot or (null) from a button's plain default. */
  const composeAt = (slot: { date: string; time: string } | null) => {
    setComposeSlot(slot)
    setComposeOpen(true)
  }

  const navControl = (item: NavItem, className: string | undefined) =>
    item.kind === 'toggle' ? (
      <button
        key={item.id}
        type="button"
        className={className}
        aria-current={item.active ? 'page' : undefined}
        aria-keyshortcuts={VIEW_KEY_HINTS[item.id]}
        // Wrapped in a View Transition so the two layouts cross-fade where the browser
        // supports it; everywhere else this is exactly setClientView.
        onClick={() =>
          withViewTransition(() => setClientView(item.id === 'week' ? 'week' : 'agenda'))
        }
      >
        {VIEW_LABELS[item.id]}
      </button>
    ) : (
      <Link
        key={item.id}
        className={className}
        href={item.href}
        aria-current={item.active ? 'page' : undefined}
        aria-keyshortcuts={VIEW_KEY_HINTS[item.id]}
        onMouseEnter={primeLink(item.href)}
        onFocus={primeLink(item.href)}
      >
        {VIEW_LABELS[item.id]}
        <NavPendingMark />
      </Link>
    )

  return (
    <CloakProvider page={page} email={email} extraFields={audienceNames}>
      {/* Every audience switch goes through this, so the cloak cover cannot be forgotten by a
          fourth door the way three separate router.push calls invited. It renders no DOM, so
          the shell below is still the grid's only parent. */}
      <AudienceTransitionProvider>
      {/* Inside CloakProvider so the `n` binding can honour the lock state, exactly like
          the buttons it mirrors. */}
      {hotkeysEnabled && (
        <CalendarHotkeys
          view={view}
          anchorDate={anchorDate}
          audience={page.audience}
          composeAvailable={canCompose}
          onSelectView={selectView}
          onCompose={() => composeAt(null)}
        />
      )}
      <div className={styles.shell}>
        {/* Three owned clusters, left to right: identity (the lockup, now the door home),
            place (steppers + date + Today, one group), controls (view switch + Cloak +
            theme, pinned right). One flexible gap between place and controls — the old
            layout scattered five separate boxes across the row and the slack pooled in an
            unowned centre. */}
        <header className={styles.header}>
          <CloakHomeLink size="sm" compact />

          <div className={styles.placeCluster}>
            {/* Real links, not buttons: a week is a location, so it should be shareable,
                bookmarkable and reachable with the back button. Server navigation also keeps
                redaction on the server — client-side week switching would mean shipping
                occurrences the audience is not entitled to. */}
            <nav className={styles.weekNav} aria-label={`Change ${stepUnit}`}>
              <Link
                className={styles.weekStep}
                href={previousHref}
                aria-label={`Previous ${stepUnit}`}
                aria-keyshortcuts="ArrowLeft k"
                onMouseEnter={primeLink(previousHref)}
                onFocus={primeLink(previousHref)}
              >
                ‹
                <NavPendingMark />
              </Link>
              <p className={styles.range} aria-live="polite">
                {heading}
              </p>
              <Link
                className={styles.weekStep}
                href={nextHref}
                aria-label={`Next ${stepUnit}`}
                aria-keyshortcuts="ArrowRight j"
                onMouseEnter={primeLink(nextHref)}
                onFocus={primeLink(nextHref)}
              >
                ›
                <NavPendingMark />
              </Link>
            </nav>

            {/* Today is a navigation, so it is a link: the server defaults to today, and the
                view and audience survive via the query exactly as on the steppers. The
                wrapper span owns visibility — hiding the ButtonLink itself would fight the
                Button class's own display in the cascade and lose on import order.

                `view` here is the resolved CLIENT view, so Today from the week toggle keeps
                week view. The old `!onWeekFetch` condition silently dropped it — Today from
                Week landed on the agenda, which read as the button being broken. The query
                now comes from the shared builder, so the fix cannot regress in one caller. */}
            <span className={styles.today}>
              <ButtonLink
                variant="outline"
                size="sm"
                aria-keyshortcuts="t"
                href={{
                  pathname: '/',
                  query: todayQuery(view, page.audience),
                }}
                onMouseEnter={primeLink({ pathname: '/', query: todayQuery(view, page.audience) })}
                onFocus={primeLink({ pathname: '/', query: todayQuery(view, page.audience) })}
              >
                Today
                <NavPendingMark />
              </ButtonLink>
            </span>
          </div>

          <div className={styles.headerEnd}>
            {/* Desktop-only chrome (CSS): the segmented view control and the Cloak door,
                now sharing ONE sunken track instead of sitting as two stray boxes. On
                phones both live in the bottom bar instead — the board draws different
                chrome per device, not one bar stretched across both. The Cloak button
                stays OUTSIDE the "Calendar views" nav: it opens a sheet, it does not
                navigate, and a nav landmark that lies about one of its children is worse
                than a hairline divider. */}
            <div className={styles.headerViews}>
              <nav className={styles.viewSwitch} aria-label="Calendar views">
                {HEADER_VIEWS.map((target) => navControl(navItemFor(target), styles.viewSegment))}
              </nav>
              {/* The bookmark belongs to the view control, so it sits INSIDE the track and
                  before the divider that cuts the views from the Cloak door — a preference
                  about which view you land on is part of the view assembly, not another box
                  beside it. Outside the nav landmark for the same reason Cloak is: it does
                  not navigate. Owner only; previewing as someone else is looking at a
                  calendar whose default view is not yours to set. */}
              {page.audience === 'owner' && (
                <DefaultViewControl
                  variant="segment"
                  current={view}
                  defaultView={defaultView}
                  target={{ demo: demoMode, workspaceId }}
                />
              )}
              <span className={styles.controlDivider} aria-hidden="true" />
              <button
                type="button"
                className={styles.cloakHeaderButton}
                aria-expanded={cloakOpen}
                onClick={() => setCloakOpen(true)}
              >
                <CloakMark size={16} />
                Cloak
              </button>
            </div>

            <ThemeToggle />
          </div>
        </header>

        <aside className={styles.sidebar} aria-label="Calendars">
          {canCompose && (
            <span className={styles.sidebarCompose}>
              <NewEventButton variant="block" onOpen={() => composeAt(null)} />
            </span>
          )}

          <span className={styles.sidebarMonth}>
            <MiniMonth
              from={page.from}
              anchorDate={anchorDate}
              timezone={timezone}
              weekStart={weekStart}
              audience={page.audience}
              holidays={holidays}
            />
          </span>

          <Suspense fallback={null}>
            <ViewAsBar
              audiences={audiences}
              baselineLevel={page.baselineLevel}
              current={page.audience}
            />
          </Suspense>

          {/* The PHONE's copy of the bookmark above, hidden from 900px by its own CSS.
              The bottom bar has five fixed slots and no room for a sixth, and a preference
              does not outrank a view, so on small screens it rides in the sidebar strip —
              after the View As card, which is a trust surface and leads. */}
          {page.audience === 'owner' && (
            <DefaultViewControl
              variant="row"
              current={view}
              defaultView={defaultView}
              target={{ demo: demoMode, workspaceId }}
            />
          )}

          {/* People sits between the audience tools above it and the calendars below: it
              IS the audience list, promoted from a settings card to a place. Owner only,
              same reasoning as View As — no other audience has people to manage. */}
          {page.audience === 'owner' && (
            // UrlObject, not a string: typedRoutes' generated union lags a route added in
            // the same build, and the object form is exactly why WeekLink exists.
            <Link
              className={styles.peopleLink}
              href={{ pathname: '/people' }}
              onMouseEnter={() => router.prefetch('/people')}
              onFocus={() => router.prefetch('/people')}
            >
              People
              <span aria-hidden="true">›</span>
              <NavPendingMark />
            </Link>
          )}

          {/* The add row is a WRITE door with no demo mode, so it needs a real session:
              demoMode excludes the fixture even now that composing itself is demoable.
              A restricted audience keeps seeing no section at all when it has no calendars
              to list. */}
          {(page.calendars.length > 0 || canCompose) && (
            <>
              <h2 className={styles.sidebarHeading}>My calendars</h2>
              <ul className={styles.calendarList}>
                {page.calendars.map((calendar) => (
                  <li key={calendar.id} className={styles.calendarItem}>
                    <span
                      className={styles.swatch}
                      data-color={calendar.colorToken}
                      aria-hidden="true"
                    />
                    <CloakedText
                      subjectType="calendar"
                      subjectId={calendar.id}
                      fieldName="display_name"
                      placeholder="Calendar"
                    />
                  </li>
                ))}
              </ul>
              {/* Holidays sit at the FOOT of the list, under the user's own calendars,
                  because they are the one layer here nobody created. Only for the owner:
                  a restricted audience is previewing someone else's calendar and this is
                  not their setting to make. */}
              {page.audience === 'owner' && (
                <span className={styles.holidayRow}>
                  <HolidayToggle
                    preference={holidayPreference}
                    region={holidayRegion}
                    target={{ demo: demoMode, workspaceId }}
                  />
                </span>
              )}
              {!demoMode && canCompose && (
                <span className={styles.calendarAdd}>
                  <NewCalendarButton />
                </span>
              )}
            </>
          )}

          {/* Only when there is a real account behind it. The dev fixture has no session, so
              linking to a page that immediately redirects to sign-in would be a dead end. */}
          {email !== undefined && email !== '' && (
            <div className={styles.accountCluster}>
              <Link
                className={styles.accountRow}
                href="/settings"
                onMouseEnter={() => router.prefetch('/settings')}
                onFocus={() => router.prefetch('/settings')}
              >
                <span className={styles.accountText}>
                  Settings
                  {/* Which account, and which plan, on ONE line. The badge is a sibling of
                      the email rather than a third row: this row owns 44px, and a third
                      line of 12px type inside it is a cramped row, not a hierarchy. The
                      badge stays inside the link's accessible name deliberately — marking
                      it aria-hidden would make the plan visible to sighted users only. */}
                  <span className={styles.accountMeta}>
                    <span className={styles.accountEmail}>{email}</span>
                    <PlanBadge plan={plan} />
                  </span>
                </span>
                {/* Decorative, so the link's accessible name stays "Settings <email> Free plan". */}
                <span className={styles.accountChevron} aria-hidden="true">
                  ›
                </span>
                <NavPendingMark />
              </Link>
              <SignOutButton className={styles.signOutRow} />
            </div>
          )}
        </aside>

        <SealableMain className={styles.main}>
          {/* Widening has no cover, so it needs a line: the restricted view a user is still
              looking at while the fuller one loads is otherwise indistinguishable from a
              calendar that simply did not answer. */}
          <AudienceWidening />

          {/* The one thing standing between a deletion and a trip to Settings. Above the save
              strip because only one of them can be set at a time; the ordering just fixes
              where it lands. */}
          {deleted !== null && (
            <CalendarNotice
              onDismiss={() => setDeleted(null)}
              action={<UndoDelete info={deleted} onUndone={() => setDeleted(null)} />}
            >
              {/* The TIME, never the title. `label` is the same no-content string
                  EditableEvent builds for every constructed name in the grids. */}
              Deleted {deleted.label}.
            </CalendarNotice>
          )}

          {/* What just happened, stated where it happened. Above the preview bar because a
              result is about the action you took a moment ago and the bar is about the mode
              you are in; the newer fact reads first. */}
          {savedNotice !== null && (
            <CalendarNotice
              onDismiss={() => setSaved(null)}
              action={
                savedNotice.kind === 'edited' && offPage(savedNotice.date) ? (
                  <ButtonLink variant="outline" size="sm" href={savedHref(savedNotice.date)}>
                    Show me
                  </ButtonLink>
                ) : undefined
              }
            >
              {savedNotice.kind === 'created'
                ? `Saved to ${savedDateLabel(savedNotice.date)}.`
                : offPage(savedNotice.date)
                  ? `Moved to ${savedDateLabel(savedNotice.date)}.`
                  : 'Saved.'}
            </CalendarNotice>
          )}

          {/* The product's argument is inert until a person exists: with no audiences no
              row can differ from the baseline, so no privacy chip ever renders. One line,
              after there is something to show someone, opening the sheet where adding a
              person and choosing what they see happen together. */}
          {page.occurrences.length > 0 && (
            <FirstAudiencePrompt
              isOwner={page.audience === 'owner'}
              hasEvents={page.occurrences.length > 0}
              hasAudiences={audiences.some(
                (option) => option.kind === 'individual' || option.kind === 'group',
              )}
              onOpen={() => setVisibilityFor(page.occurrences[0]!.eventId)}
            />
          )}

          {/* The mode, at the top of the thing it applies to. Owner sees nothing here, which
              is why it is not a permanently reserved row: a bar that is always present but
              usually empty trains people to stop reading it. */}
          {page.audience !== 'owner' && (
            <Suspense fallback={null}>
              <PreviewBar audiences={audiences} current={page.audience} />
            </Suspense>
          )}

          {/* Mobile only (CSS): the board's week strip. On the agenda it is seven in-page
              anchors into the list below (one fetch, no roundtrip); on the day view the
              other six days' data is NOT on the page, so it becomes seven day links. The
              sidebar's mini month does this job from 900px. */}
          {view === 'agenda' && days.length > 0 && (
            <WeekStrip from={page.from} timezone={timezone} />
          )}
          {view === 'day' && anchorDate !== undefined && (
            <WeekStrip
              from={page.from}
              timezone={timezone}
              mode="links"
              anchorDate={anchorDate}
              weekStart={weekStart}
              audience={page.audience}
            />
          )}

          {/* Three different facts, still not conflated — but no longer distinguished by a
              NUMBER. "Everything is hidden from this audience" is a privacy statement; an
              owner looking at a quiet week is not being told anything about privacy, and a
              fresh account read the old copy as a failure to load.

              The count used to do this work and is gone from every preview surface (see
              preview-bar.tsx). `withheldCount` still CHOOSES the sentence — it just never
              appears in one. That is the honest reading of the decision: the number is not
              displayed, and the three cases stay tellable apart by wording. It is thinner
              than it was, and worth knowing it is thinner: "Nothing here for this audience"
              and "Nothing in this week for this audience" are one preposition apart.

              The day and month grids render even when empty — an empty time grid is a
              legible empty day, and a month of quiet cells is a legible quiet month. */}
          {days.length === 0 && (view === 'agenda' || view === 'week') && (
            <>
              {/* THE SENTENCE AND THE SEEDER ARE GATED SEPARATELY, and that split is a bug
                  fix rather than a refinement. The sentence keyed off `days` (occurrences
                  only) while the agenda list below keys off `agendaDays` (occurrences PLUS
                  holiday-only days), so a week holding Christmas Day and nothing else
                  rendered "Nothing scheduled this week." AND, underneath it, a day heading
                  with an empty list. Two contradictory answers to one question, which reads
                  as a rendering failure rather than as a quiet week.

                  The sentence now asks the VIEW'S own question — has this view a row to
                  show? — which for the agenda is `agendaDays` and for the week is the grid,
                  which does not render at all without events.

                  The seeder keeps asking the older and genuinely different question: are
                  there any EVENTS? A public holiday is not something you scheduled, so a
                  first week that happens to contain one must still offer the way in. */}
              {(view === 'week' || agendaDays.length === 0) && (
                <div className={styles.empty}>
                  {/* The heading is the engraved register the day headings use, one step
                      up. An empty calendar is the first screen a new account sees, and a
                      single centred sentence in the middle of a large space reads as a
                      page that failed rather than a week that is free. */}
                  <h2 className={styles.emptyTitle}>
                    {page.withheldCount > 0
                      ? 'Nothing here for this audience'
                      : page.audience === 'owner'
                        ? 'Nothing scheduled this week'
                        : 'Nothing in this week for this audience'}
                  </h2>
                  {/* The NEXT ACTION, stated. Not cute and not apologetic: the owner gets
                      a way in, and everyone else gets nothing extra, because a restricted
                      audience has nothing to do here. */}
                  {page.audience === 'owner' && page.withheldCount === 0 && canCompose && (
                    <>
                      <p className={styles.emptyLede}>
                        Add the first one and it is encrypted on this device before it is
                        saved.
                      </p>
                      <span className={styles.emptyAction}>
                        <NewEventButton variant="block" onOpen={() => composeAt(null)} />
                      </span>
                    </>
                  )}
                </div>
              )}
              {/* An empty week is the one place sample data helps — and the only place it
                  can come from is here, sealed in this browser with real keys. */}
              {page.audience === 'owner' &&
                page.withheldCount === 0 &&
                !demoMode &&
                composeDate !== undefined && (
                  <SeedSampleEvents from={page.from} timezone={timezone} />
                )}
            </>
          )}

          {view === 'week' && days.length > 0 && (
            <WeekGrid
              occurrences={page.occurrences}
              from={page.from}
              timezone={timezone}
              colorFor={colorFor}
              baselineLevel={page.baselineLevel}
              audience={page.audience}
              onOpenVisibility={setVisibilityFor}
              onComposeSlot={canCompose ? (date, time) => composeAt({ date, time }) : undefined}
              holidays={holidays}
              availability={availability}
              onSaved={reportSaved}
              onDeleted={reportDeleted}
              savedEventId={savedNotice?.eventId ?? null}
            />
          )}

          {view === 'day' && (
            <WeekGrid
              occurrences={page.occurrences}
              from={page.from}
              timezone={timezone}
              colorFor={colorFor}
              baselineLevel={page.baselineLevel}
              dayCount={1}
              audience={page.audience}
              onOpenVisibility={setVisibilityFor}
              onComposeSlot={canCompose ? (date, time) => composeAt({ date, time }) : undefined}
              holidays={holidays}
              availability={availability}
              onSaved={reportSaved}
              onDeleted={reportDeleted}
              savedEventId={savedNotice?.eventId ?? null}
            />
          )}

          {view === 'month' && anchorDate !== undefined && (
            <MonthGrid
              occurrences={page.occurrences}
              from={page.from}
              timezone={timezone}
              anchorDate={anchorDate}
              audience={page.audience}
              colorFor={colorFor}
              holidays={holidays}
            />
          )}

          {/* KEYED ON THE AUDIENCE, so changing who is looking replays the staggered
              entrance instead of swapping the rows in place. Switching audience is a server
              navigation and React reuses the DOM across it, so without this the calendar
              simply becomes different text under a still cursor — the one moment in the
              product where something ought to be seen happening.

              The entrance is `rise`, not the cloak wipe. --duration-cloak is already spent
              on a sealed VALUE becoming readable (cloaked-text.module.css), and spending it
              on a list re-entrance as well would make the signature motion mean two things.
              Same trick as the landing hero, which keys its grid for exactly this reason. */}
          {/* Rendered conditionally rather than hidden: two copies of every title in the
              DOM would mean any assertion about a title matching twice, and a `hidden`
              subtree is still text a naive leak scan would find. */}
          {view === 'agenda' && (
          <ol className={styles.agenda} key={page.audience}>
            {agendaDays.map(([day, occurrences]) => (
              // The id is the week strip's anchor target; scroll-margin in CSS keeps the
              // heading clear of the sticky chrome.
              <li key={day} id={`day-${day}`} className={styles.day}>
                <h2 className={styles.dayHeading}>
                  {DAY_LABEL.format(new Date(`${day}T00:00:00Z`))}
                  {/* Inside the heading, not a row of its own: a holiday is a property OF
                      the day, and an agenda row would put a thing you cannot open, edit or
                      hide in a list where every other row does all three. */}
                  {(() => {
                    const holiday = primaryHoliday(holidays[day])
                    return holiday === undefined ? null : (
                      <span className={styles.holidayNote} data-kind={holiday.kind}>
                        {holiday.name}
                      </span>
                    )
                  })()}
                </h2>
                <ul className={styles.events}>
                  {occurrences.map((occurrence, index) => (
                    <li
                      key={`${occurrence.eventId}:${occurrence.occurrenceLocal}`}
                      className={styles.event}
                      data-color={colorFor(occurrence.calendarId)}
                      data-time={occurrence.time}
                      data-just-saved={occurrence.eventId === savedNotice?.eventId || undefined}
                      style={
                        {
                          '--i': Math.min((staggerBase.get(day) ?? 0) + index, 8),
                        } as CSSProperties
                      }
                    >
                      <span className={styles.time}>
                        {timeOf(occurrence.start)}
                        {/* Availability, un-conflated from privacy: the old chip said
                            Busy/Free where the board draws the privacy level. Free is
                            still worth a word; it just lives with the time now. */}
                        {page.audience === 'owner' && occurrence.busy === 'free' && (
                          <span className={styles.freeNote}>Free</span>
                        )}
                      </span>
                      <span className={styles.eventBody}>
                        {/* Owner-only, same guard the delete path uses in the sheet. For every other audience
                            the body renders exactly as it always did — a non-owner has
                            nothing to open, and nothing to be told about. */}
                        {page.audience === 'owner' && occurrence.version !== undefined ? (
                          <EditableEvent
                            eventId={occurrence.eventId}
                            version={occurrence.version}
                            recurring={occurrence.recurring ?? false}
                            series={occurrence.series ?? null}
                            occurrenceLocal={occurrence.occurrenceLocal}
                            timezone={timezone}
                            start={occurrence.start}
                            end={occurrence.end}
                            label={`the event at ${timeOf(occurrence.start)}`}
                            onSaved={reportSaved}
                            onDeleted={reportDeleted}
                          >
                            <CloakedText
                              className={styles.eventTitle}
                              subjectType="event"
                              subjectId={occurrence.eventId}
                              fieldName="title"
                              placeholder="Private event"
                            />
                          </EditableEvent>
                        ) : occurrence.time === 'busy' ? (
                          // Nothing to reveal: the server sent no fields for this one.
                          <span className={styles.eventTitle}>Busy</span>
                        ) : (
                          <CloakedText
                            className={styles.eventTitle}
                            subjectType="event"
                            subjectId={occurrence.eventId}
                            fieldName="title"
                            placeholder="Private event"
                          />
                        )}
                        {occurrence.dst !== 'none' && (
                          <span className={styles.dstNote}>
                            {occurrence.dst === 'nonexistent-shifted'
                              ? 'Moved by a daylight saving change'
                              : 'Falls in a repeated hour'}
                          </span>
                        )}
                      </span>
                      {/* THE SECOND LABEL SHOWS THE CHIP ONLY WHERE THIS EVENT DIFFERS
                          FROM YOUR BASELINE, and the calendar everywhere else.

                          The board's rule was "the level unless it is full", and the level
                          is the widest disclosure any audience gets — which is the
                          workspace setting for almost every event. One rule putting a
                          contact on title-only therefore printed "Limited details" on every
                          row in the calendar, forever: a setting restated once per event
                          rather than a fact about any of them. A chip that is always the
                          same carries no information and still costs the eye a stop.

                          So the chip now means "this one is different", and the baseline it
                          differs from is stated ONCE per screen, in the same vocabulary, in
                          the sidebar. Colour is still never the sole carrier: the chip keeps
                          its icon and its words, and its ABSENCE is not a colour.

                          For the owner it is also the DOOR either way, which is why the
                          button wraps both branches — the route into the visibility sheet
                          does not depend on which label won. Non-owners keep the
                          availability chip: the redaction they received IS their privacy
                          information. */}
                      {page.audience === 'owner' && occurrence.privacyLevel !== undefined ? (
                        <button
                          type="button"
                          className={styles.chipButton}
                          title="Change who can see this event"
                          aria-label={`Change who can see the event at ${timeOf(occurrence.start)}`}
                          onClick={() => setVisibilityFor(occurrence.eventId)}
                        >
                          {occurrence.privacyLevel === page.baselineLevel &&
                          occurrence.calendarId !== undefined ? (
                            <CloakedText
                              className={styles.calendarNote}
                              subjectType="calendar"
                              subjectId={occurrence.calendarId}
                              fieldName="display_name"
                              placeholder="Calendar"
                            />
                          ) : (
                            <PrivacyChip level={occurrence.privacyLevel} />
                          )}
                        </button>
                      ) : (
                        <span className={styles.busy} data-busy={occurrence.busy ?? 'busy'}>
                          {occurrence.busy === 'free' ? 'Free' : 'Busy'}
                        </span>
                      )}
                      {/* NO DELETE HERE ANY MORE. It lives in the edit sheet, which has
                          hosted the same component with the same two scopes since the sheet
                          was built, so this was the second door to one room rather than the
                          only door to it.

                          It was also the heaviest thing in the agenda: the one irreversible
                          action in the product, rendered permanently in every row of the
                          primary content area, and doing it once per row is most of what
                          made the list read as a stack of forms. A row is a thing you read;
                          the sheet is where you act on it.

                          Not hover-revealed, which was the other candidate: a phone has no
                          hover, so that spelling would have put the control on desktop only
                          and left the sheet as the sole route on the device most people
                          use. One route on every device is the smaller idea. */}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          )}
        </SealableMain>

        {/* The cloak cover. A grid child in `main`'s area, AFTER it in DOM order so it paints
            on top — see audience-transition.module.css. Narrowing only. */}
        <AudienceCover />

        {/* MOBILE chrome only (CSS hides it from 900px, where the header's segmented
            control takes over): five slots, Cloak in the privileged centre — the board's
            statement that privacy is a place you go. Day and Month are real navigations
            now; agenda/week stay instant toggles while the week fetch is on the page. */}
        <nav className={styles.nav} aria-label="Calendar views">
          {NAV_LEADING.map((target) => navControl(navItemFor(target), styles.navItem))}
          <button
            type="button"
            className={styles.cloakTile}
            aria-expanded={cloakOpen}
            onClick={() => setCloakOpen(true)}
          >
            <CloakMark size={18} />
            Cloak
          </button>
          {NAV_TRAILING.map((target) => navControl(navItemFor(target), styles.navItem))}
        </nav>

        {/* Composing is owner-only. Creating an event while viewing as someone else would
            be a confusing thing to offer and an easy thing to get wrong. */}
        {canCompose && composeDate !== undefined && (
          <>
            <NewEventButton variant="fab" onOpen={() => composeAt(null)} />
            {composeOpen && (
              <NewEvent
                timezone={timezone}
                defaultDate={composeSlot?.date ?? composeDate}
                defaultTime={composeSlot?.time ?? '09:00'}
                demo={demoMode}
                onSaved={reportSaved}
                onClose={() => {
                  setComposeOpen(false)
                  // Forget the slot: the next plain-button compose should get the anchor
                  // date at 09:00, not wherever the grid was last clicked.
                  setComposeSlot(null)
                }}
              />
            )}
          </>
        )}

        {visibilityFor !== null && (
          <VisibilitySheet
            eventId={visibilityFor}
            audiences={audiences}
            workspaceRules={workspaceRules}
            eventRules={rulesByEvent[visibilityFor] ?? []}
            groupsByContact={groupsByContact}
            demo={demoMode}
            onClose={() => setVisibilityFor(null)}
          />
        )}

        {cloakOpen && (
          <Suspense fallback={null}>
            <CloakSheet
              audiences={audiences}
              currentAudience={page.audience}
              workspaceRules={workspaceRules}
              groupsByContact={groupsByContact}
              onClose={() => setCloakOpen(false)}
            />
          </Suspense>
        )}
      </div>
      </AudienceTransitionProvider>
    </CloakProvider>
  )
}
