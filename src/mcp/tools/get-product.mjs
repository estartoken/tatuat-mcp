/**
 * `get_product` — fișa unui produs după slug. Copiază structura din
 * `search-products.mjs` (forma canonică): `registerTool` cu `z.object({...})`,
 * `annotations` explicite, dependențe injectate prin `deps`, erori prin
 * `guarded()`.
 *
 * Decizie de semantică pentru slug inexistent (nu e evidentă din nume, deci
 * documentată aici): `found: false, product: null`, **fără** `isError`. Un
 * slug care nu mai corespunde unui produs activ e o stare normală a
 * catalogului (produs retras, link vechi din altă conversație) — exact ca
 * „zero potriviri” la `search_products`, care e tot răspuns valid, nu eroare.
 * `isError` rămâne rezervat pentru „nu pot confirma” (PostgREST jos, plafon
 * depășit), nu pentru „am confirmat că nu există”.
 *
 * Fișa de produs NU e filtrată pe limbă (vezi catalog.mjs): produsul doar-HU
 * e ascuns din liste, dar rămâne accesibil pe link direct. De aceea, spre
 * diferență de `search_products`, aici nu există niciun `p_lang` de omis.
 */

import { z } from 'zod'
import { productBySlug, productVariants, brandNames } from '../catalog.mjs'
import { HU_ONLY, ORDER_RESTRICTION_NOTICE, orderRestrictionForRow } from '../policy.mjs'
import { productDescription, READ_ONLY_ANNOTATIONS } from '../schemas.mjs'
import { CURRENCY, cardPricing, effectivePrice, formatPrice, productUrl } from '../format.mjs'
import { okResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'
import { siteOrigin } from '../env.mjs'

export const name = 'get_product'

export const inputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Slug-ul produsului, exact cel întors de search_products sau cel din URL-ul fișei (ex. „ace-cartus-0-30-rl"), fără prefixul /product/.',
    ),
})

const ProductVariant = z.object({
  variant_id: z.number().int().describe('Identificatorul numeric al variantei.'),
  name: z.string().describe('Numele variantei (ex. mărime, capacitate, culoare).'),
  sku: z.string().nullable().describe('Codul SKU al variantei, sau null dacă nu e setat.'),
  price: z
    .number()
    .nullable()
    .describe('Prețul efectiv al variantei (prețul redus dacă are o reducere reală).'),
  in_stock: z.boolean().describe('Dacă această variantă poate fi comandată acum.'),
  is_default: z
    .boolean()
    .describe('Dacă e varianta selectată implicit pe fișa produsului de pe tatuat.ro.'),
})

const ProductDetail = z.object({
  product_id: z.number().int().describe('Identificatorul numeric stabil al produsului.'),
  slug: z.string().describe('Identificatorul textual stabil, folosit în URL.'),
  name: z.string().describe('Numele comercial al produsului, în română.'),
  description: z
    .string()
    .describe(
      'Descrierea produsului, curățată de HTML și trunchiată la maximum 500 de caractere, la graniță de cuvânt.',
    ),
  url: z.string().describe('Adresa fișei de produs pe tatuat.ro.'),
  price: z
    .number()
    .nullable()
    .describe(
      'Prețul efectiv de plată (prețul redus dacă produsul e la promoție). La produsele cu variante e prețul CELEI MAI IEFTINE variante — vezi price_from și lista `variants`.',
    ),
  price_before: z
    .number()
    .nullable()
    .describe('Prețul dinainte de reducere, sau null dacă produsul nu e la promoție.'),
  price_from: z
    .boolean()
    .describe(
      'Dacă true, `price` e cel mai mic preț dintre variante, nu prețul exact — anunță-l clientului ca „de la X RON" și folosește `variants` pentru prețul variantei alese. Dacă false, `price` e prețul exact.',
    ),
  currency: z.literal(CURRENCY).describe('Moneda prețului. Întotdeauna RON.'),
  in_stock: z.boolean().describe('Dacă produsul poate fi comandat acum.'),
  variant_count: z
    .number()
    .int()
    .describe('Câte variante are produsul (0 = produs simplu, fără variante de ales).'),
  brand: z.string().nullable().describe('Numele brandului, sau null dacă nu e setat.'),
  sku: z.string().nullable().describe('Codul SKU al produsului, sau null dacă nu e setat.'),
  variants: z
    .array(ProductVariant)
    .describe('Variantele produsului, cu preț și stoc propriu; listă vidă dacă produsul e simplu.'),
})

export const outputSchema = z.object({
  found: z
    .boolean()
    .describe('Dacă slug-ul corespunde unui produs activ pe tatuat.ro. false ≠ eroare.'),
  product: ProductDetail
    .nullable()
    .describe('Fișa produsului, sau null dacă slug-ul nu corespunde niciunui produs activ.'),
  order_restriction: z
    .enum([HU_ONLY])
    .nullable()
    .describe(
      'Restricția de comandă a produsului, sau null dacă n-are niciuna (și la found: false). hu_only = se poate comanda DOAR cu livrare în Ungaria; o comandă cu livrare în România va fi refuzată la plasare.',
    ),
})

export const config = {
  title: 'Fișa unui produs de pe tatuat.ro',
  description:
    'Întoarce fișa completă a unui produs de pe tatuat.ro după slug: nume, descriere, preț efectiv în RON (cu prețul dinainte de reducere dacă e cazul), disponibilitate, link direct la fișă, brand și variantele cu preț și stoc propriu. Folosește slug-ul întors de search_products. Dacă slug-ul nu corespunde unui produs activ, found este false — nu e o eroare.',
  inputSchema,
  outputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
}

/**
 * @param {Record<string, unknown>} row rând din `product_variants`
 * @returns {z.infer<typeof ProductVariant> | null} null dacă rândul e inutilizabil
 */
function toVariant(row) {
  const id = row.id
  const rowName = row.name
  if (typeof id !== 'number' || typeof rowName !== 'string') return null
  // `product_variants` nu are o coloană `in_stock` proprie (vezi catalog.mjs);
  // disponibilitatea variantei se derivă din `stock_qty`, ca în magazin.
  const stockQty = typeof row.stock_qty === 'number' ? row.stock_qty : null
  return {
    variant_id: id,
    name: rowName,
    sku: typeof row.sku === 'string' ? row.sku : null,
    price: effectivePrice(/** @type {{ price?: number | null, sale_price?: number | null }} */ (row)),
    in_stock: stockQty !== null && stockQty > 0,
    is_default: row.is_default === true,
  }
}

/**
 * @param {Record<string, unknown>} row rând din `v_products_with_pricing` (DETAIL_SELECT)
 * @param {Record<string, unknown>[]} variantRows
 * @param {{ origin: string, brands?: Map<number, string> }} ctx
 * @returns {z.infer<typeof ProductDetail> | null} null dacă rândul e inutilizabil
 */
function toProductDetail(row, variantRows, ctx) {
  const id = row.id
  const slug = row.slug
  const name = row.name
  if (typeof id !== 'number' || typeof slug !== 'string' || typeof name !== 'string') {
    return null
  }
  // Aceeași regulă ca pe cardul din listă (`cardPricing`, format.mjs): la produsele cu variante
  // prețul de bază din view e 0, iar prețul real e minimul variantelor, din `from_price`.
  const { price, price_before, price_from } = cardPricing(row)
  const brandId = typeof row.brand_id === 'number' ? row.brand_id : null
  const variants = variantRows.map(toVariant).filter((v) => v !== null)
  return {
    product_id: id,
    slug,
    name,
    description: productDescription(row.description),
    url: productUrl(ctx.origin, slug),
    price,
    // „redus de la" doar când reducerea e reală; altfel modelul ar anunța o promoție inexistentă.
    price_before,
    price_from,
    currency: CURRENCY,
    in_stock: row.in_stock === true,
    variant_count: typeof row.variant_count === 'number' ? row.variant_count : variants.length,
    brand: brandId !== null ? (ctx.brands?.get(brandId) ?? null) : null,
    sku: typeof row.sku === 'string' ? row.sku : null,
    variants,
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
   * @param {{ slug: string }} args
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
      const slug = args.slug.trim()
      const passThrough = { env, fetchImpl: deps.fetchImpl }

      const notFound = () =>
        okResult(`Nu am găsit niciun produs activ pe tatuat.ro cu slug-ul „${slug}".`, {
          found: false,
          product: null,
          order_restriction: null,
        })

      const row = await productBySlug(slug, passThrough)
      if (row === null) return notFound()

      const productId = row.id
      if (typeof productId !== 'number') return notFound()

      const [variantRows, brands] = await Promise.all([
        productVariants(productId, passThrough),
        brandNames([typeof row.brand_id === 'number' ? row.brand_id : NaN], passThrough),
      ])

      const product = toProductDetail(row, variantRows, { origin, brands })
      if (product === null) return notFound()

      const text = [
        `${product.name} — ${product.price_from && product.price !== null ? 'de la ' : ''}${formatPrice(product.price)}`,
        product.in_stock ? 'în stoc' : 'stoc epuizat',
        product.variants.length > 0 ? `${product.variants.length} variante` : null,
        product.url,
      ]
        .filter((p) => p !== null)
        .join(' · ')

      // Restricția vine din RÂNDUL brut, nu din `product`: `toProductDetail` compune
      // fișa pentru client și nu poartă `lang` — dacă ar fi citită de acolo, ar ieși
      // `null` pentru tot, adică exact tăcerea pe care câmpul o repară.
      const restriction = orderRestrictionForRow(row)
      const textFinal = restriction === null ? text : `${text} · ${ORDER_RESTRICTION_NOTICE[restriction]}`

      return okResult(textFinal, { found: true, product, order_restriction: restriction })
    }, { onError: deps.onError })
  }
}

/**
 * ⚠️ Tipul e `McpServer`-ul real, nu o formă structurală minimă — vezi nota
 * din `search-products.mjs` (măsurat: `tsc` dă TS2345 pe o formă mai largă).
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Deps} [deps]
 */
export function register(server, deps = {}) {
  return server.registerTool(name, config, createHandler(deps))
}
