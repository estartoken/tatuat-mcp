/**
 * Marginea HTTP a serverului MCP: un `fetch` web-standard pe care ruta Next îl
 * apelează, cu ce trebuie să se întâmple ÎNAINTE ca pachetul să vadă cererea.
 *
 * 🔑 MĂSURAT în @modelcontextprotocol/server@2.0.0:
 *  - `createMcpHandler(factory, options?)` → `{ fetch, close, notify, bus }`,
 *    `fetch: (request, options?) => Promise<Response>`
 *    (`dist/createMcpHandler-CLhGwQTn.d.mts:3901`).
 *  - `CreateMcpHandlerOptions` are EXACT șase câmpuri: `legacy`, `onerror`,
 *    `responseMode`, `bus`, `maxSubscriptions`, `keepAliveMs`
 *    (`:3829-3891`). 🔴 NU există `route` și NU există `allowedOriginHostnames`
 *    — validarea de Host/Origin NU e făcută de pachet pe baza unei opțiuni;
 *    o scriu aici, explicit, cu helperii pe care pachetul îi exportă.
 *  - `legacy` implicit e `'stateless'`; îl declar explicit ca să fie citibil.
 *  - `responseMode` rămâne omis (= `'auto'`). `'json'` ar ARUNCA notificările
 *    emise înainte de rezultat; `'auto'` urcă la SSE doar dacă un tool emite
 *    ceva. Pentru tool-urile de acum comportamentul e identic, dar `'auto'` nu
 *    devine o pierdere silențioasă când un tool viitor raportează progres.
 *  - Factory-ul rulează PE FIECARE CERERE („one serving unit: one HTTP
 *    request"), deci nu poate ține starea plafonului — vezi `moduleLimiter`.
 */

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server'

import { buildTatuatMcpServer } from './server.mjs'
import { allowedHostnames } from './env.mjs'
import { createMemoryLimiter } from './rate-limit.mjs'

/**
 * Plafonul trăiește la nivel de MODUL, nu în factory.
 *
 * ⚠️ Dacă ar fi creat înăuntrul factory-ului, găleata s-ar reseta la fiecare
 * cerere HTTP — adică un control care nu poate eșua niciodată, deci nu e un
 * control. Pe serverless rămâne oricum per-instanță (vezi rate-limit.mjs);
 * per-instanță e „best effort", per-cerere ar fi zero.
 */
const moduleLimiter = createMemoryLimiter()

/**
 * Diagnosticul erorilor de out-of-band. Ajunge în logul platformei, nu la client.
 * Nu loghez obiectul întreg: un `cause` de fetch poate purta URL-ul intern cu
 * cheia în query dacă cineva construiește vreodată o cerere greșit.
 *
 * @param {unknown} err
 */
function defaultOnError(err) {
  const name = err instanceof Error ? err.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[mcp] ${name}: ${message}`)
}

/**
 * @typedef {object} HandlerDeps
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('./rate-limit.mjs').Limiter} [limiter]
 * @property {(err: unknown) => void} [onError]
 * @property {string[]} [allowedHosts]
 * @property {{ fetch: (request: Request) => Promise<Response> }} [inner]
 */

/**
 * @param {HandlerDeps} [deps]
 */
export function createTatuatMcpHandler(deps = {}) {
  const env = deps.env ?? process.env
  const hosts = deps.allowedHosts ?? allowedHostnames(env)
  const limiter = deps.limiter ?? moduleLimiter
  const onError = deps.onError ?? defaultOnError

  const inner =
    deps.inner ??
    createMcpHandler(
      () => buildTatuatMcpServer({ env, limiter, onError, fetchImpl: deps.fetchImpl }),
      { legacy: 'stateless', onerror: onError },
    )

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handle(request) {
    // Ambele întorc `Response` la refuz și `undefined` la trecere, deci se
    // compun cu `??`. Ordinea contează doar pentru mesajul de eroare.
    //
    // ⚠️ Polarități OPUSE la header absent, măsurate în pachet:
    //  - Host lipsă  → REFUZ (`missing_host`). Clienții MCP trimit mereu `Host`.
    //  - Origin lipsă → TRECE. Clienții non-browser nu trimit `Origin`; a-i
    //    respinge ar rupe exact clientul pentru care există serverul.
    const rejected =
      hostHeaderValidationResponse(request, hosts) ?? originValidationResponse(request, hosts)
    if (rejected) return rejected

    return inner.fetch(request)
  }

  return { fetch: handle, allowedHosts: hosts }
}
