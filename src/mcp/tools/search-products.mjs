/**
 * `search_products` — FORMA CANONICĂ a unui tool. Celelalte cinci o copiază.
 *
 * Convenții pe care le fixează acest fișier:
 *  - `registerTool(name, config, handler)` cu `inputSchema`/`outputSchema` ca
 *    `z.object({...})`. Shape brut e `@deprecated` în pachet.
 *  - `annotations` declarate explicit, toate patru câmpurile (vezi
 *    READ_ONLY_ANNOTATIONS) — OpenAI respinge pentru annotations permisive greșit.
 *  - dependențele injectate prin `deps`, ca testul să nu atingă rețeaua.
 *  - orice eroare trece prin `guarded()` → răspuns de eroare, niciodată date
 *    inventate și niciodată stack în textul citit de model.
 *  - `p_lang` NU se trimite: gate-ul RO-only al fazei 1 (vezi catalog.mjs).
 */

import { z } from 'zod'
import { searchProducts, brandNames } from '../catalog.mjs'
import { ProductCard, summaryLine, toProductCard, READ_ONLY_ANNOTATIONS } from '../schemas.mjs'
import { okResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'
import { siteOrigin } from '../env.mjs'

export const name = 'search_products'

/** Plafonul de rezultate. Peste atât, răspunsul devine nefolositor unui model. */
export const MAX_LIMIT = 20
/** Câte rezultate se întorc dacă modelul nu cere un număr. */
export const DEFAULT_LIMIT = 10

export const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'Ce caută clientul, în cuvintele lui: nume de produs, brand, sau tip de produs (ex. „ace 0.30 RL", „mașină rotativă", „tuș negru"). Minim două caractere ca să se facă efectiv o căutare.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Câte rezultate să întoarcă, între 1 și ${MAX_LIMIT}. Implicit ${DEFAULT_LIMIT}.`),
})

export const outputSchema = z.object({
  query: z.string().describe('Interogarea folosită efectiv, după curățare.'),
  count: z.number().int().describe('Câte produse s-au găsit, maximum limita cerută.'),
  products: z.array(ProductCard).describe('Produsele găsite, în ordinea de relevanță a magazinului.'),
})

export const config = {
  title: 'Caută produse pe tatuat.ro',
  description:
    'Caută în catalogul tatuat.ro după nume, brand sau tip de produs și întoarce produse cu preț în RON, disponibilitate și link direct la fișa de produs. Folosește acest tool când clientul întreabă dacă un produs există, cât costă sau ce opțiuni sunt disponibile. Pentru detaliile unui produs anume, folosește după aceea get_product cu slug-ul întors aici.',
  inputSchema,
  outputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
}

/**
 * @typedef {object} Deps
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../rate-limit.mjs').Limiter} [limiter]
 * @property {(err: unknown) => void} [onError]
 */

/**
 * @param {Deps} [deps]
 */
export function createHandler(deps = {}) {
  /**
   * @param {{ query: string, limit?: number }} args
   * @param {{ sessionId?: string }} [ctx]
   * @returns {Promise<import('../tool-result.mjs').ToolResult>}
   */
  return async function handler(args, ctx = {}) {
    return guarded(async () => {
      if (deps.limiter) {
        // Cheia e sesiunea MCP când transportul o dă; altfel o singură găleată.
        // Plafon per-instanță, best-effort — NU control de acces (vezi rate-limit.mjs).
        await enforce(deps.limiter, `${name}:${ctx.sessionId ?? 'anon'}`)
      }

      const env = deps.env ?? process.env
      const origin = siteOrigin(env)
      const query = args.query.trim()
      const limit = args.limit ?? DEFAULT_LIMIT
      const passThrough = { env, fetchImpl: deps.fetchImpl }

      const rows = await searchProducts({ query, limit }, passThrough)

      if (rows.length === 0) {
        return okResult(
          query.length < 2
            ? `Interogarea „${query}" e prea scurtă pentru o căutare. Sunt necesare minim două caractere.`
            : `Nicio potrivire pe tatuat.ro pentru „${query}".`,
          { query, count: 0, products: [] },
        )
      }

      // Brandurile se rezolvă la NUME: un `brand_id: 12` nu-i spune nimic modelului.
      const brands = await brandNames(
        rows.map((r) => (typeof r.brand_id === 'number' ? r.brand_id : NaN)),
        passThrough,
      )

      const products = rows
        .map((row) => toProductCard(row, { origin, brands }))
        .filter((card) => card !== null)

      const text = [
        `${products.length} produse pe tatuat.ro pentru „${query}":`,
        ...products.map((card) => `• ${summaryLine(card)}`),
      ].join('\n')

      return okResult(text, { query, count: products.length, products })
    }, { onError: deps.onError })
  }
}

/**
 * ⚠️ Tipul e `McpServer`-ul real, nu o formă structurală minimă („un obiect care
 * are `registerTool`"). O formă minimă cu `config: unknown` NU e asignabilă din
 * semnătura reală — `registerTool` e generică și inferează schemele din `config`,
 * iar un parametru `unknown` e mai larg decât ce acceptă ea (contravarianță).
 * Măsurat: `tsc` a dat TS2345 pe exact linia de înregistrare din `server.mjs`.
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Deps} [deps]
 */
export function register(server, deps = {}) {
  return server.registerTool(name, config, createHandler(deps))
}
