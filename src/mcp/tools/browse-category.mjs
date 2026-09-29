/**
 * `browse_category` — pagina de produse a unei categorii tatuat.ro.
 *
 * Copiază convențiile fixate de `search-products.mjs` (FORMA CANONICĂ):
 *  - `registerTool(name, config, handler)` cu `inputSchema`/`outputSchema` ca
 *    `z.object({...})`.
 *  - `annotations` explicite din `READ_ONLY_ANNOTATIONS`.
 *  - dependențele injectate prin `deps`, ca testul să nu atingă rețeaua.
 *  - orice eroare trece prin `guarded()`.
 *  - `p_lang` NU se trimite: gate-ul RO-only din `catalog.mjs` se aplică și la
 *    `products_in_category`, nu doar la căutare.
 */

import { z } from 'zod'
import { categoryProducts, brandNames, CATEGORY_SORTS, DEFAULT_CATEGORY_SORT } from '../catalog.mjs'
import { ProductCard, summaryLine, toProductCard, READ_ONLY_ANNOTATIONS } from '../schemas.mjs'
import { okResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'
import { siteOrigin } from '../env.mjs'

export const name = 'browse_category'

/** Plafonul de rezultate. Aceeași valoare ca la `search_products`. */
export const MAX_LIMIT = 20
/** Câte rezultate se întorc dacă modelul nu cere un număr. */
export const DEFAULT_LIMIT = 10

export const inputSchema = z.object({
  category_id: z
    .number()
    .int()
    .nullable()
    .default(null)
    .describe(
      'ID-ul numeric al categoriei ale cărei produse se listează. Omis sau null = tot catalogul, ca „Toate produsele" din magazin.',
    ),
  sort: z
    .enum(CATEGORY_SORTS)
    .default(DEFAULT_CATEGORY_SORT)
    .describe(
      `Cum se ordonează rezultatele: ${CATEGORY_SORTS.join(', ')}. Implicit „${DEFAULT_CATEGORY_SORT}".`,
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Câte produse să întoarcă, între 1 și ${MAX_LIMIT}. Implicit ${DEFAULT_LIMIT}.`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Câte produse se omit de la începutul listei, pentru paginare. Implicit 0.'),
})

export const outputSchema = z.object({
  category_id: z
    .number()
    .int()
    .nullable()
    .describe('ID-ul categoriei cerute; null înseamnă tot catalogul.'),
  sort: z.enum(CATEGORY_SORTS).describe('Sortarea efectiv folosită pentru această pagină.'),
  offset: z.number().int().describe('Offset-ul efectiv folosit pentru paginare.'),
  count: z.number().int().describe('Câte produse s-au întors în această pagină.'),
  products: z.array(ProductCard).describe('Produsele categoriei, în ordinea sortării cerute.'),
})

export const config = {
  title: 'Răsfoiește o categorie de pe tatuat.ro',
  description:
    'Întoarce o pagină de produse dintr-o categorie tatuat.ro (sau din tot catalogul, dacă nu se dă un ID de categorie), cu preț în RON, disponibilitate și link direct la fișa de produs. Folosește acest tool când clientul vrea să vadă ce e disponibil într-o categorie sau vrea produsele cele mai populare/ieftine/scumpe/noi. Pentru un produs anume folosește după aceea get_product cu slug-ul întors aici.',
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
   * @param {{ category_id?: number | null, sort?: string, limit?: number, offset?: number }} args
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
      const categoryId = args.category_id ?? null
      const sort = args.sort ?? DEFAULT_CATEGORY_SORT
      const limit = args.limit ?? DEFAULT_LIMIT
      const offset = args.offset ?? 0
      const passThrough = { env, fetchImpl: deps.fetchImpl }

      const rows = await categoryProducts({ categoryId, sort, limit, offset }, passThrough)

      if (rows.length === 0) {
        return okResult(
          categoryId === null
            ? `Niciun produs în catalogul tatuat.ro pentru sortarea „${sort}".`
            : `Niciun produs în categoria ${categoryId} pe tatuat.ro pentru sortarea „${sort}".`,
          { category_id: categoryId, sort, offset, count: 0, products: [] },
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
        `${products.length} produse pe tatuat.ro${categoryId === null ? '' : ` din categoria ${categoryId}`} (sortare „${sort}"):`,
        ...products.map((card) => `• ${summaryLine(card)}`),
      ].join('\n')

      return okResult(text, { category_id: categoryId, sort, offset, count: products.length, products })
    }, { onError: deps.onError })
  }
}

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Deps} [deps]
 */
export function register(server, deps = {}) {
  return server.registerTool(name, config, createHandler(deps))
}
