/**
 * Endpointul public MCP: POST/GET/DELETE la `/mcp`.
 *
 * ⚠️ Fișierul e DELIBERAT fără logică. Tot ce decide ceva (validare de Host și
 * Origin, plafon, construcția serverului, tratarea erorilor) trăiește în
 * `src/mcp/*.mjs`, unde e acoperit de `node --test`. Un `.ts` de glue nu are
 * teste în acest repo, deci nu are voie să conțină nimic care poate greși.
 *
 * 🔑 De ce se exportă și GET și DELETE, nu doar POST:
 * Next răspunde automat 405 pentru metodele pe care ruta nu le exportă — dar
 * atunci 405-ul ar fi al lui Next, nu al protocolului. Pachetul are propria
 * semantică pentru ele (`legacy: 'stateless'` răspunde singur cu 405 pe GET și
 * DELETE ale erei 2025, iar era modernă le folosește altfel), deci decizia
 * trebuie să fie a PACHETULUI. Le deleg pe toate trei și las protocolul să
 * răspundă.
 *
 * 🔑 De ce handlerul e singleton la nivel de modul:
 * `createMcpHandler` rulează factory-ul de server pe FIECARE cerere („one
 * serving unit: one HTTP request"), deci instanța de MCP e oricum per-cerere.
 * Ce NU trebuie să fie per-cerere e starea plafonului de rate limiting: creată
 * aici o dată, la primul import, trăiește cât trăiește instanța de funcție.
 * Construcția nu citește secrete și nu poate arunca (`allowedHostnames` are
 * valoare implicită), deci un singleton de modul nu poate rupe importul rutei.
 *
 * 🔑 De ce nu ține nicio stare de sesiune: măsurat în teste — `tools/list`
 * răspunde fără `initialize` prealabil, doar cu headerul `mcp-protocol-version`.
 */

import { createTatuatMcpHandler } from '@/src/mcp/handler.mjs'

/**
 * Node, nu Edge: tool-urile folosesc `AbortSignal.timeout` și `process.env`, iar
 * comparațiile de semnătură din faza 2 vor avea nevoie de `node:crypto`.
 */
export const runtime = 'nodejs'

/**
 * Route Handlers nu sunt cache-uite implicit în Next 16, dar `force-dynamic` o
 * spune explicit: un răspuns MCP servit din cache ar fi un răspuns la întrebarea
 * altui client.
 */
export const dynamic = 'force-dynamic'

/**
 * Plafon de execuție. `responseMode: 'auto'` poate urca la SSE, iar keep-alive-ul
 * pachetului e 15s — 60s lasă loc unui tool lent fără să țină o funcție agățată.
 */
export const maxDuration = 60

const handler = createTatuatMcpHandler()

export function POST(request: Request): Promise<Response> {
  return handler.fetch(request)
}

export function GET(request: Request): Promise<Response> {
  return handler.fetch(request)
}

export function DELETE(request: Request): Promise<Response> {
  return handler.fetch(request)
}
