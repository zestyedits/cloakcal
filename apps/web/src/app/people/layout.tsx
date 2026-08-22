import type { ReactNode } from 'react'

import { PeopleChrome } from '@/components/people-chrome'

/** One bar for the register and every contact file beneath it. See people-chrome.tsx. */
export default function PeopleLayout({ children }: { children: ReactNode }) {
  return <PeopleChrome>{children}</PeopleChrome>
}
