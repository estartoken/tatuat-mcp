import type { NextConfig } from 'next'

/**
 * Serverul MCP nu servește UI. Politica de securitate e deci maximal restrictivă:
 * nimic nu se încarcă, nimic nu se încadrează, nimic nu se indexează.
 *
 * ⚠️ CSP-ul de aici NU folosește nonce, deliberat: nonce-urile forțează dynamic
 * rendering pe TOATE paginile (static optimization și ISR dezactivate, PPR
 * incompatibil — Next 16.3.4, guides/content-security-policy). Ruta /mcp e POST,
 * deci oricum niciodată cache-uită („Route Handlers are not cached by default"),
 * dar restul proiectului nu trebuie penalizat.
 */
const CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
    ]
  },
}

export default nextConfig
