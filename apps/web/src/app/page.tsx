import { getCalendarPage } from '@/server/events'
import { CalendarScreen } from '@/components/calendar-screen'

/**
 * Server Component. Reads Tier A metadata plus ciphertext and passes it down.
 *
 * Everything in `page` is safe to serialize into the RSC payload precisely because none
 * of it is readable. The leak tests assert that by searching the Flight response for a
 * known Cloaked title.
 */
export default function Page() {
  const page = getCalendarPage()
  return <CalendarScreen page={page} />
}
