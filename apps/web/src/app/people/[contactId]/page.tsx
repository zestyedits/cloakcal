import { notFound, redirect } from 'next/navigation'
import { loadPeopleData } from '@/server/people'
import { FIXTURE_GROUPS } from '@/server/dev-fixture'
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
      // Null in fixture mode so every write door stays structurally shut — the fixture's
      // 'fixture' placeholder id must never reach an RPC parameter.
      workspaceId={data.fixtureMode ? null : data.visibility.workspaceId}
      workspaceRules={data.visibility.workspaceRules}
      // A Record, not a Map: this crosses the RSC boundary. Same fixture split `/` makes —
      // the engine needs alex's colleagues membership for the level to read honestly.
      groupsByContact={Object.fromEntries(
        data.fixtureMode ? FIXTURE_GROUPS : data.visibility.groupsByContact,
      )}
    />
  )
}
