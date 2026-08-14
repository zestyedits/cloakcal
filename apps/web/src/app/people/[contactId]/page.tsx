import { notFound, redirect } from 'next/navigation'
import { loadPeopleData } from '@/server/people'
import { ContactPreview } from '@/components/people-screen'

export const metadata = { title: 'What they see · CloakCal' }

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
    <ContactPreview
      page={data.page}
      email={data.email}
      audiences={data.visibility.audiences}
      contactId={contactId}
      timezone={data.timezone}
      previewedAt={data.previewedAt}
      fixtureMode={data.fixtureMode}
    />
  )
}
