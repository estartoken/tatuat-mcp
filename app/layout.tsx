import type { ReactNode } from 'react'

/**
 * Root layout — Next îl cere chiar și pentru un proiect care nu servește nicio
 * pagină, doar Route Handlers. Fără el, `next build` refuză.
 *
 * ⚠️ Deliberat gol de conținut: proiectul ăsta e un API, nu un site. Nu are
 * pagini, nu are fonturi, nu are stiluri. `next.config.ts` trimite deja
 * `X-Robots-Tag: noindex, nofollow` și un CSP `default-src 'none'`, deci nici o
 * eventuală pagină de eroare a lui Next nu încarcă nimic din exterior.
 */
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
