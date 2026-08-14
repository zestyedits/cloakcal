import { redirect } from 'next/navigation'
import { loadPeopleData } from '@/server/people'
import { PeopleList } from '@/components/people-screen'

export const metadata = { title: 'People · CloakCal' }

// Reads the session and per-user data; CI has no Supabase variables, so without this the
// build prerenders (and dies) exactly as /account did twice. See CLAUDE.md.
export const dynamic = 'force-dynamic'

export default async function PeoplePage() {
  const data = await loadPeopleData('owner')
  // Middleware already bounces the signed-out case; this covers the race where the
  // session died between the two checks.
  if (data === null) redirect('/sign-in')

  return (
    <PeopleList
      page={data.page}
      email={data.email}
      audiences={data.visibility.audiences}
      fixtureMode={data.fixtureMode}
      // Null in fixture mode so every write door stays structurally shut — the fixture's
      // 'fixture' placeholder id must never reach an RPC parameter.
      workspaceId={data.fixtureMode ? null : data.visibility.workspaceId}
    />
  )
}
