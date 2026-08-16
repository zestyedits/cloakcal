'use client'

import { Suspense, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { todayQuery, viewQuery } from '@/lib/calendar-links'
import { HEADER_VIEWS, NAV_LEADING, NAV_TRAILING, VIEW_LABELS } from '@/lib/calendar-views'
import { wallTimeLabel } from '@/lib/wall-time'
import { CalendarHotkeys } from './calendar-hotkeys'
import type { VisibilityRule } from '@cloakcal/policy'
import type { RedactedOccurrence, RedactedPage } from '@/server/audience'
import type { AudienceOption } from '@/lib/audiences'
import { withViewTransition } from '@/lib/view-transition'
import { CloakProvider, type ExtraSealedField } from './cloak-provider'
import { CloakedText } from './cloaked-text'
import { ViewAsBar } from './view-as-bar'
import { DefaultViewControl } from './default-view-control'
import { NewCalendarButton } from './new-calendar'
import { WeekGrid } from './week-grid'
import { NewEvent, NewEventButton } from './new-event'
import { DeleteEvent } from './delete-event'
import { EditableEvent } from './editable-event'
import { CloakHomeLink, CloakMark } from './cloak-logo'
import { ThemeToggle } from './theme-toggle'
import { MiniMonth } from './mini-month'
import { MonthGrid } from './month-grid'
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
  holidays = {},
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
          <CloakHomeLink size="sm" />

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
              current={page.audience}
              withheldCount={page.withheldCount}
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

        <main id="main" className={styles.main}>
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

          {/* Two different facts, and conflating them was wrong. "Everything is hidden from
              this audience" is a privacy statement; an owner looking at a quiet week is not
              being told anything about privacy, and a fresh account read the old copy as a
              failure to load. withheldCount distinguishes them exactly. The day and month
              grids render even when empty — an empty time grid is a legible empty day, and
              a month of quiet cells is a legible quiet month. */}
          {days.length === 0 && (view === 'agenda' || view === 'week') && (
            <>
              <p className={styles.empty}>
                {page.withheldCount > 0
                  ? `Nothing here for this audience. ${page.withheldCount} ${
                      page.withheldCount === 1 ? 'event is' : 'events are'
                    } hidden from them entirely.`
                  : page.audience === 'owner'
                    ? 'Nothing scheduled this week.'
                    : 'Nothing in this week for this audience.'}
              </p>
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
              audience={page.audience}
              onOpenVisibility={setVisibilityFor}
              onComposeSlot={canCompose ? (date, time) => composeAt({ date, time }) : undefined}
              holidays={holidays}
              availability={availability}
            />
          )}

          {view === 'day' && (
            <WeekGrid
              occurrences={page.occurrences}
              from={page.from}
              timezone={timezone}
              colorFor={colorFor}
              dayCount={1}
              audience={page.audience}
              onOpenVisibility={setVisibilityFor}
              onComposeSlot={canCompose ? (date, time) => composeAt({ date, time }) : undefined}
              holidays={holidays}
              availability={availability}
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

          {/* Rendered conditionally rather than hidden: two copies of every title in the
              DOM would mean any assertion about a title matching twice, and a `hidden`
              subtree is still text a naive leak scan would find. */}
          {view === 'agenda' && (
          <ol className={styles.agenda}>
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
                        {/* Owner-only, same guard as Delete below. For every other audience
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
                      {/* The board's rule for the second label: the privacy level when it
                          is anything other than full — the product's whole argument, at a
                          glance — otherwise the calendar, which is the useful fact about
                          an unrestricted event. For the owner the chip is also the DOOR:
                          it opens this event's visibility sheet, which makes the privacy
                          state and the privacy control the same object. Non-owners keep
                          the availability chip: the redaction they received IS their
                          privacy information. */}
                      {page.audience === 'owner' && occurrence.privacyLevel !== undefined ? (
                        <button
                          type="button"
                          className={styles.chipButton}
                          title="Change who can see this event"
                          aria-label={`Change who can see the event at ${timeOf(occurrence.start)}`}
                          onClick={() => setVisibilityFor(occurrence.eventId)}
                        >
                          {occurrence.privacyLevel === 'full' &&
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
                      {/* Owner only, and only when the server actually sent a version to
                          guard the write with. Both conditions are already true together —
                          audience.ts only attaches `version` for the owner — but relying on
                          that coupling silently would make this the thing that breaks the
                          day the engine changes. */}
                      {page.audience === 'owner' && occurrence.version !== undefined && (
                        <DeleteEvent
                          eventId={occurrence.eventId}
                          version={occurrence.version}
                          recurring={occurrence.recurring ?? false}
                          // The occurrence's ORIGINAL local wall time, straight from the
                          // server. Never re-derived from `start`, which is a resolved
                          // instant — deriving it back would put a second wall-clock
                          // resolution in the codebase, and ADR 0001 allows exactly one.
                          occurrenceLocal={occurrence.occurrenceLocal}
                          label={`the event at ${timeOf(occurrence.start)}`}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          )}
        </main>

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
    </CloakProvider>
  )
}
