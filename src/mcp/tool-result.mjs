/**
 * Forma răspunsurilor de tool, într-un singur loc.
 *
 * 🔑 MĂSURAT în @modelcontextprotocol/server@2.0.0
 * (`dist/mcp-DXXb3Vv3.mjs:1438-1445`, `validateToolOutput`): când `result.isError`
 * e adevărat, validarea faţă de `outputSchema` e SĂRITĂ. Deci un tool care are
 * `outputSchema` poate întoarce un eșec fără `structuredContent` — legal, nu un
 * hack. Fără această măsurătoare singura ieșire ar fi fost să arunc din handler.
 *
 * ⚠️ Textul de eroare ajunge la model și, prin el, la client. Nu conține
 * niciodată stack, URL intern, nume de variabilă de mediu sau cheie — doar ce
 * poate face clientul mai departe. Diagnosticul real pleacă prin `onerror`.
 */

import { PostgrestError } from './postgrest.mjs'
import { RateLimitError } from './rate-limit.mjs'
import { McpConfigError } from './env.mjs'

/**
 * Forma UNICĂ a răspunsului unui tool — un singur tip, nu două forme disjuncte.
 *
 * De ce contează: dacă succesul și eșecul ar fi tipuri separate, uniunea lor n-ar
 * avea nicio proprietate accesibilă, iar orice apelant (test, handler, tool viitor)
 * ar trebui să facă narrowing înainte de a citi `structuredContent`. Ambele câmpuri
 * sunt opționale exact ca în `CallToolResult` al protocolului.
 *
 * @typedef {object} ToolResult
 * @property {{ type: 'text', text: string }[]} content
 * @property {Record<string, unknown>} [structuredContent]
 * @property {boolean} [isError]
 */

/**
 * Răspuns reușit: text pentru om + date structurate pentru model.
 *
 * @param {string} text
 * @param {Record<string, unknown>} structuredContent
 * @returns {ToolResult}
 */
export function okResult(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent }
}

/**
 * Răspuns de eșec. `isError` e ce face validarea de output să nu ceară
 * `structuredContent`.
 *
 * @param {string} text
 * @returns {ToolResult}
 */
export function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Rulează corpul unui tool și traduce erorile cunoscute în răspunsuri de eroare
 * lizibile, fail-closed: nicio eroare nu se transformă în date inventate.
 *
 * @param {() => Promise<ToolResult>} fn
 * @param {{ onError?: (err: unknown) => void }} [opts]
 * @returns {Promise<ToolResult>}
 */
export async function guarded(fn, opts = {}) {
  try {
    return await fn()
  } catch (err) {
    opts.onError?.(err)
    if (err instanceof RateLimitError) {
      return errorResult('Prea multe cereri într-un interval scurt. Încearcă din nou imediat.')
    }
    if (err instanceof PostgrestError) {
      return errorResult(
        'Catalogul tatuat.ro nu a răspuns acum. Nu pot confirma preț sau stoc — încearcă din nou în câteva momente.',
      )
    }
    if (err instanceof McpConfigError) {
      // Configurare lipsă pe server. Numele variabilei rămâne în log, nu în răspuns.
      return errorResult('Serviciul tatuat.ro nu e configurat corect momentan.')
    }
    return errorResult('A apărut o eroare neașteptată la interogarea catalogului tatuat.ro.')
  }
}
