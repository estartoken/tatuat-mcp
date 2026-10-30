import type { ReactNode } from 'react'

/** Layout for Next error pages. Public documentation uses a static route handler. */
export const metadata = {
  title: 'TATUAT.RO MCP',
  description: 'Server MCP pentru catalogul tatuat.ro.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ro">
      <body>{children}</body>
    </html>
  )
}
