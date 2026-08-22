import type { ReactNode } from 'react'

import { SettingsChrome } from '@/components/settings/settings-chrome'

/**
 * One bar for every settings route.
 *
 * A layout is the only thing Next keeps mounted across a sibling navigation, so this is what
 * stops the header being rebuilt four times on the way through Settings. See
 * `settings-chrome.tsx` for why the back target is computed rather than passed.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsChrome>{children}</SettingsChrome>
}
