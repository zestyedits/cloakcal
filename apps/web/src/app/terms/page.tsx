import { LegalScreen } from '@/components/legal-screen'
import { TERMS } from '@/lib/legal'

export const metadata = {
  title: 'Terms · CloakCal',
  description:
    'The agreement between you and CloakCal, including the one that is genuinely unusual: we cannot recover your content.',
}

/** Public, for the same reason as `/privacy`. See the note there. */
export default function TermsPage() {
  return <LegalScreen document={TERMS} />
}
