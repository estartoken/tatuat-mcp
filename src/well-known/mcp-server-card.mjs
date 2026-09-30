/**
 * `GET /.well-known/mcp-server-card.json` — documentul static „server card" cerut
 * de intrarea ARD a serverului: `tatuat-site/public/.well-known/ard.json`,
 * entry `urn:air:tatuat.ro:mcp:tatuat-mcp`, câmp `url`.
 *
 * 🔴 Descoperit prin verificare directă a schemei oficiale (28.09.2026,
 * `ards-project/ard-spec`, `spec/ard.md` §4.4 + `spec/schemas/ard-entry.schema.json`):
 * o intrare ARD de tip `application/mcp-server-card+json` cere câmpul `url` ca
 * referință către UN DOCUMENT STATIC JSON separat — NU endpointul JSON-RPC live
 * (`/mcp`, care răspunde doar la POST și n-ar întoarce niciodată acest content-type
 * la un GET simplu). Exemplul din spec: `"url": "https://api.acme.com/mcp/weather.json"`.
 * Fără acest fișier, intrarea ARD ar indica un link mort/greșit — exact capcana
 * semnalată în cercetarea din 27.09 („ARD publicat fără un server funcțional ar fi
 * un fișier care minte"), aplicată acum la nivel de câmp, nu doar de server.
 *
 * Conținutul oglindește DELIBERAT `server.json` trimis la
 * `registry.modelcontextprotocol.io` (§2 din handoff) — un singur loc de adevăr
 * pentru identitatea publică a serverului, ca cele două să nu diveargă în timp.
 */

/** Originea publică a serverului MCP. Implicit `api.tatuat.ro`, ca în `env.mjs` (`allowedHostnames`). */
const DEFAULT_ORIGIN = 'https://api.tatuat.ro'

/**
 * Numele complet al tool-urilor expuse — sursa de adevăr e `src/mcp/tools/*.mjs`.
 * Listate aici EXPLICIT (nu derivate dinamic din filesystem la runtime) ca orice
 * tool nou/șters să ceară o schimbare vizibilă aici, nu o desincronizare tăcută
 * cu ce promite cardul.
 */
export const CARD_TOOLS = Object.freeze([
  'search_products',
  'get_product',
  'get_stock',
  'browse_category',
  'calculate_shipping',
  'create_checkout',
])

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [version] versiunea din `package.json` — parametru injectabil ca
 *   testul să nu depindă de citirea fișierului real.
 * @returns {Response}
 */
export function mcpServerCardResponse(env = process.env, version = '0.1.0') {
  const origin = (env.MCP_ALLOWED_HOSTS ? `https://${env.MCP_ALLOWED_HOSTS.split(',')[0].trim()}` : DEFAULT_ORIGIN)

  const card = {
    name: 'io.github.estartoken/tatuat-mcp',
    description:
      'MCP server pentru catalogul TATUAT.RO (căutare, stoc, preț, categorii, calcul transport, link de checkout semnat) — prețuri RON; căutare în catalogul RO, restricții de livrare declarate pe fișele directe.',
    version,
    websiteUrl: 'https://tatuat.ro',
    remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }],
    tools: CARD_TOOLS,
  }

  return new Response(JSON.stringify(card, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Registrele/crawlerele ARD citesc cross-origin — fără acest header, un
      // fetch din browser dintr-un alt domeniu ar fi blocat de CORS deși
      // documentul e public prin design (exact ca `ard.json` de pe tatuat-site).
      'Access-Control-Allow-Origin': '*',
      // Static, dar nu imutabil: versiunea/tool-urile se pot schimba fără deploy
      // pe alt domeniu. 5 minute lasă o actualizare să se propage în aceeași zi,
      // fără să bată origin-ul la fiecare cerere de crawler.
      'Cache-Control': 'public, max-age=300',
    },
  })
}
