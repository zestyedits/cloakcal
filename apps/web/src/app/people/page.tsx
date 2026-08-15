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
      // Null under the fixture so every write door stays structurally shut; the loader
      // decides that once (see PeopleData.workspaceId).
      workspaceId={data.workspaceId}
      // So the register can state what each person currently gets, instead of making you
      // open a file to find out the one fact the book exists to answer. The map is the one
      // the engine redacted with, flattened for the RSC boundary — never re-derived.
      workspaceRules={data.visibility.workspaceRules}
      groupsByContact={Object.fromEntries(data.groupsByContact)}
      now={data.previewedAt}
    />
  )
}
