import { DEMO_AUDIENCES, redactPage, type AudienceId } from '@/server/audience'
import { getCalendarPage } from '@/server/events'
import { CalendarScreen } from '@/components/calendar-screen'

/**
 * Server Component. Reads Tier A metadata plus ciphertext, then runs it through the
 * policy engine before anything leaves the server — including for the owner.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>
}) {
  const { as } = await searchParams
  const audience: AudienceId = DEMO_AUDIENCES.some((a) => a.id === as)
    ? (as as AudienceId)
    : 'owner'

  // Fixed instant so the demo page is deterministic and statically renderable; the real
  // read path uses request time.
  const page = redactPage(getCalendarPage(), audience, '2026-05-19T08:00:00-04:00')

  return <CalendarScreen page={page} audiences={DEMO_AUDIENCES} />
}
