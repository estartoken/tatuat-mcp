/**
 * `get_stock` — starea de stoc pentru un produs (sau o variantă a lui), pe o
 * cantitate cerută de client. Copiază forma canonică din `search-products.mjs`.
 *
 * Logica de stare vine 1:1 din tatuat-site, citită read-only, nereimplementată
 * din memorie:
 *  - `stockHint(qty, stock, cap)` — `lib/stock-hint.ts` (patru stări: fără hint
 *    „în stoc", `partial`, `preorder`, `max`).
 *  - plafonul de linie `cap` — `lib/cart-client.ts` (`lineCap`,
 *    `MAX_QTY_PER_LINE = 9999`): `min(stock, 9999)` cât timp stocul e pozitiv,
 *    altfel 9999. La graniță (`qty === stock === cap`) starea e `max`, nu
 *    „în stoc" — comportamentul e ACELAȘI cu butonul „+" care se dezactivează
 *    pe /cos, măsurat, nu presupus.
 *
 * Precomanda e o stare REALĂ de business (owner: `place_order` decrementează
 * parțial stocul și inserează în `stock_notifications`) — nu se ascunde și nu
 * se prezintă ca „în stoc".
 *
 * `p_lang` nu se aplică aici: `productBySlug`/`productVariants` din catalog.mjs
 * citesc tabele direct (nu RPC-ul cu gate RO-only), iar fișa de produs NU e
 * filtrată pe limbă în magazin — „ascuns dar cumpărabil" pe link direct, la fel
 * ca aici pe slug direct.
 *
 * 🔴 DE ACEEA răspunsul declară `order_restriction` (01.10.2026). Produsul
 * `lang='hu'` ajunge aici pe slug și avea „stoc suficient" ca oricare altul, deși
 * `place_order` îl refuză cu `product_hu_only` la orice livrare în România.
 * Incidentul din 19.09 a fost exact asta: clientul a citit refuzul de la final ca
 * „server picat" și a plecat pe WhatsApp. Produsul rămâne vizibil — se schimbă
 * doar că restricția e SPUSĂ, nu descoperită la sfârșit.
 */

import { z } from 'zod'
import { productBySlug, productVariants } from '../catalog.mjs'
import { HU_ONLY, ORDER_RESTRICTION_NOTICE, orderRestrictionForRow } from '../policy.mjs'
import { productUrl } from '../format.mjs'
import { READ_ONLY_ANNOTATIONS } from '../schemas.mjs'
import { okResult, errorResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'
import { siteOrigin } from '../env.mjs'

export const name = 'get_stock'

/**
 * Plafonul maxim comandabil pe o linie, indiferent de stoc.
 * 🔴 MĂSURAT din `MAX_QTY_PER_LINE` (tatuat-site/lib/cart-client.ts:36): 9999,
 * nu „nelimitat" — prinde greșeala de tastare, nu limitează un client real.
 */
export const MAX_QTY_PER_LINE = 9999

export const inputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Identificatorul textual (slug) al produsului, ca cel întors de search_products sau din URL-ul /product/<slug>.',
    ),
  variant_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'ID-ul variantei (ex. mărimea acului) al cărei stoc se verifică. Omite pentru produsele fără variante — sau ca să se verifice varianta implicită a produsului.',
    ),
  qty: z
    .number()
    .int()
    .min(1)
    .max(MAX_QTY_PER_LINE)
    .default(1)
    .describe(`Câte bucăți vrea clientul să comande. Implicit 1, maximum ${MAX_QTY_PER_LINE}.`),
})

export const outputSchema = z.object({
  slug: z.string().describe('Slug-ul produsului verificat.'),
  product_id: z.number().int().describe('Identificatorul numeric stabil al produsului.'),
  product_name: z.string().describe('Numele comercial al produsului.'),
  variant_id: z
    .number()
    .int()
    .nullable()
    .describe('ID-ul variantei verificate, sau null dacă produsul nu are variante.'),
  variant_name: z
    .string()
    .nullable()
    .describe('Numele variantei verificate (ex. mărimea), sau null dacă produsul nu are variante.'),
  url: z.string().describe('Adresa fișei de produs pe tatuat.ro.'),
  requested_qty: z.number().int().describe('Cantitatea cerută în input.'),
  state: z
    .enum(['in_stock', 'partial', 'preorder', 'max'])
    .describe(
      'Starea de stoc: in_stock = toată cantitatea cerută e disponibilă acum; partial = doar o parte e disponibilă acum, restul intră pe precomandă; preorder = stoc 0, toată cantitatea intră pe precomandă; max = cantitatea cerută atinge exact plafonul maxim comandabil pe această linie.',
    ),
  available_now: z
    .number()
    .int()
    .describe('Câte bucăți din cantitatea cerută se pot onora chiar acum, din stocul curent.'),
  backorder_qty: z
    .number()
    .int()
    .describe('Câte bucăți din cantitatea cerută ar intra pe precomandă (0 dacă tot e disponibil acum).'),
  max_orderable: z
    .number()
    .int()
    .describe('Cantitatea maximă comandabilă acum pe această linie de produs (plafon de linie).'),
  order_restriction: z
    .enum([HU_ONLY])
    .nullable()
    .describe(
      'Restricția de comandă a produsului, sau null dacă n-are niciuna. hu_only = se poate comanda DOAR cu livrare în Ungaria; o comandă cu livrare în România va fi refuzată la plasare, oricât stoc ar exista.',
    ),
})

export const config = {
  title: 'Verifică stocul unui produs pe tatuat.ro',
  description:
    'Verifică disponibilitatea reală a unui produs (sau al unei variante a lui, ex. o mărime) pentru o cantitate cerută de client, folosind slug-ul întors de search_products. Întoarce una din patru stări — disponibil integral acum, parțial disponibil cu rest pe precomandă, precomandă integrală (stoc 0), sau cantitate la plafonul maxim comandabil — plus un text pe care îl poți spune clientului fără să inventezi o cifră.',
  inputSchema,
  outputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
}

/**
 * Portat 1:1 din `stockHint()` (tatuat-site/lib/stock-hint.ts). Ordinea contează:
 * stoc necunoscut → doar plafonul mai poate vorbi; stoc ≤0 → precomandă; cerere
 * peste stoc → parțial; cerere la plafon → max; altfel → fără hint („în stoc").
 *
 * @param {number} qty
 * @param {number | null} stock
 * @param {number} cap
 * @returns {{ kind: 'preorder' | 'partial' | 'max', stock: number } | null}
 */
function stockHint(qty, stock, cap) {
  if (stock == null) return qty >= cap ? { kind: 'max', stock: cap } : null
  if (stock <= 0) return { kind: 'preorder', stock: 0 }
  if (qty > stock) return { kind: 'partial', stock }
  if (qty >= cap) return { kind: 'max', stock }
  return null
}

/**
 * Portat 1:1 din `lineCap()` (tatuat-site/lib/cart-client.ts:37).
 * @param {number | null} stock
 * @returns {number}
 */
function lineCap(stock) {
  return stock != null && stock > 0 ? Math.min(stock, MAX_QTY_PER_LINE) : MAX_QTY_PER_LINE
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} field
 * @returns {number | null}
 */
function num(row, field) {
  const v = row[field]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Textul citit de client, fără să inventeze o cifră care nu vine din datele reale.
 *
 * @param {{ state: string, subject: string, requestedQty: number, availableNow: number, backorderQty: number, maxOrderable: number, url: string }} p
 * @returns {string}
 */
function buildText(p) {
  switch (p.state) {
    case 'preorder':
      return `„${p.subject}" e pe precomandă momentan — stocul e 0. Cele ${p.requestedQty} bucăți cerute ar intra integral pe precomandă, fără termen garantat de livrare imediată. ${p.url}`
    case 'partial':
      return `Din „${p.subject}" sunt disponibile chiar acum doar ${p.availableNow} bucăți (nu ${p.requestedQty}); restul de ${p.backorderQty} ar intra pe precomandă. ${p.url}`
    case 'max':
      return `„${p.subject}" are ${p.availableNow} bucăți disponibile chiar acum — este exact cantitatea maximă comandabilă pe această linie (plafon ${p.maxOrderable}). ${p.url}`
    default:
      return `„${p.subject}" are stoc suficient pentru cele ${p.availableNow} bucăți cerute. ${p.url}`
  }
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
   * @param {{ slug: string, variant_id?: number, qty?: number }} args
   * @param {{ sessionId?: string }} [ctx]
   * @returns {Promise<import('../tool-result.mjs').ToolResult>}
   */
  return async function handler(args, ctx = {}) {
    return guarded(async () => {
      if (deps.limiter) {
        await enforce(deps.limiter, `${name}:${ctx.sessionId ?? 'anon'}`)
      }

      const env = deps.env ?? process.env
      const origin = siteOrigin(env)
      const passThrough = { env, fetchImpl: deps.fetchImpl }
      const slug = args.slug.trim()
      const qty = args.qty ?? 1

      const product = await productBySlug(slug, passThrough)
      if (product === null) {
        return errorResult(`Nu găsesc niciun produs cu identificatorul „${slug}" pe tatuat.ro.`)
      }

      const productId = num(product, 'id')
      const productName = typeof product.name === 'string' ? product.name : slug
      if (productId === null) {
        return errorResult('Datele produsului sunt incomplete momentan pe tatuat.ro.')
      }

      let variantId = /** @type {number | null} */ (null)
      let variantName = /** @type {string | null} */ (null)
      let stock = num(product, 'stock_qty')

      const variantCount = num(product, 'variant_count') ?? 0
      if (args.variant_id != null || variantCount > 0) {
        const variants = await productVariants(productId, passThrough)

        if (args.variant_id != null) {
          const match = variants.find((v) => num(v, 'id') === args.variant_id)
          if (!match) {
            return errorResult(
              `Nu găsesc varianta cerută pentru „${productName}" pe tatuat.ro.`,
            )
          }
          variantId = args.variant_id
          variantName = typeof match.name === 'string' ? match.name : null
          stock = num(match, 'stock_qty')
        } else {
          const def = variants.find((v) => v.is_default === true) ?? variants[0]
          if (def) {
            variantId = num(def, 'id')
            variantName = typeof def.name === 'string' ? def.name : null
            stock = num(def, 'stock_qty')
          }
        }
      }

      const cap = lineCap(stock)
      const hint = stockHint(qty, stock, cap)
      const state = hint === null ? 'in_stock' : hint.kind

      let availableNow
      let backorderQty
      if (state === 'preorder') {
        availableNow = 0
        backorderQty = qty
      } else if (state === 'partial') {
        availableNow = /** @type {number} */ (stock)
        backorderQty = qty - /** @type {number} */ (stock)
      } else {
        availableNow = qty
        backorderQty = 0
      }

      const url = productUrl(origin, slug)
      const subject = variantName ? `${productName} (${variantName})` : productName
      // Restricția se citește din RÂNDUL DE PRODUS, nu din variantă: `lang` e pe produs.
      const restriction = orderRestrictionForRow(product)
      const text = buildText({
        state,
        subject,
        requestedQty: qty,
        availableNow,
        backorderQty,
        maxOrderable: cap,
        url,
      })
      const textFinal = restriction === null ? text : `${text} ${ORDER_RESTRICTION_NOTICE[restriction]}`

      return okResult(textFinal, {
        slug,
        product_id: productId,
        product_name: productName,
        variant_id: variantId,
        variant_name: variantName,
        url,
        requested_qty: qty,
        state,
        available_now: availableNow,
        backorder_qty: backorderQty,
        max_orderable: cap,
        order_restriction: restriction,
      })
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
