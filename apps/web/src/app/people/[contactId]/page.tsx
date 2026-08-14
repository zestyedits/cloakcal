import { notFound, redirect } from 'next/navigation'
import { loadPeopleData } from '@/server/people'
import { ContactFile } from '@/components/contact-file'

export const metadata = { title: 'Contact file · CloakCal' }

// Reads the session and per-user data; CI has no Supabase variables, so without this the
// build prerenders (and dies) exactly as /account did twice. See CLAUDE.md.
export const dynamic = 'force-dynamic'

export default async function ContactPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params

  const data = await loadPeopleData(`contact:${contactId}`)
  // A contact that does not exist and a contact that is not yours render identically:
  // the 404 cannot distinguish "missing" from "not yours", same rule as the event 404.
  if (data === null) {
    const owner = await loadPeopleData('owner')
    if (owner === null) redirect('/sign-in')
    notFound()
  }

  return (
    <ContactFile
      page={data.page}
      email={data.email}
      audiences={data.visibility.audiences}
      contactId={contactId}
      timezone={data.timezone}
      previewedAt={data.previewedAt}
      fixtureMode={data.fixtureMode}
      // Null under the fixture so every write door stays structurally shut; the loader
      // decides that once (see PeopleData.workspaceId).
      workspaceId={data.workspaceId}
      workspaceRules={data.visibility.workspaceRules}
      // A Record, not a Map: this crosses the RSC boundary. The map the engine redacted
      // with, from resolveAndRedact — the file's level picker must read the same
      // memberships the preview above it was computed under.
      groupsByContact={Object.fromEntries(data.groupsByContact)}
    />
  )
}
