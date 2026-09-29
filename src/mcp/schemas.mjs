/**
 * Schemele Zod partajate de tool-uri.
 *
 * 🔴 `z.object({...})`, niciodată shape brut: overload-ul cu shape brut al lui
 * `registerTool` e marcat `@deprecated` în @modelcontextprotocol/server@2.0.0
 * („Wrap with `z.object({...})` instead.").
 *
 * Fiecare câmp are `.describe()`: descrierile ajung în schema pe care o citește
 * modelul, iar un câmp nedescris e un câmp pe care modelul îl ghicește.
 */

import { z } from 'zod'
import { CURRENCY, effectivePrice, formatPrice, productUrl, truncateAtWord } from './format.mjs'

/** Identificator stabil de produs — cerință explicită OpenAI pentru plugins. */
export const ProductCard = z.object({
  product_id: z.number().int().describe('Identificatorul numeric stabil al produsului.'),
  slug: z.string().describe('Identificatorul textual stabil, folosit în URL.'),
  name: z.string().describe('Numele comercial al produsului, în română.'),
  url: z.string().describe('Adresa fișei de produs pe tatuat.ro.'),
  price: z
    .number()
    .nullable()
    .describe('Prețul efectiv de plată (prețul redus dacă produsul e la promoție).'),
  price_before: z
    .number()
    .nullable()
    .describe('Prețul dinainte de reducere, sau null dacă produsul nu e la promoție.'),
  currency: z.literal(CURRENCY).describe('Moneda prețului. Întotdeauna RON.'),
  in_stock: z.boolean().describe('Dacă produsul poate fi comandat acum.'),
  variant_count: z
    .number()
    .int()
    .describe('Câte variante are produsul (0 = produs simplu, fără variante de ales).'),
  brand: z.string().nullable().describe('Numele brandului, sau null dacă nu e setat.'),
})

/** Text scurt, gata de citit, pentru un card de produs. */
export const summaryLine = (/** @type {z.infer<typeof ProductCard>} */ card) =>
  [
    card.name,
    formatPrice(card.price),
    card.price_before !== null ? `(redus de la ${formatPrice(card.price_before)})` : null,
    card.in_stock ? 'în stoc' : 'stoc epuizat',
    card.variant_count > 0 ? `${card.variant_count} variante` : null,
    card.url,
  ]
    .filter((p) => p !== null)
    .join(' · ')

/**
 * Transformă un rând din catalog în cardul expus de tool-uri.
 * Prețul se calculează cu aceeași regulă ca în magazin, nu se copiază câmpul brut.
 *
 * @param {Record<string, unknown>} row
 * @param {{ origin: string, brands?: Map<number, string> }} ctx
 * @returns {z.infer<typeof ProductCard> | null} null dacă rândul e inutilizabil
 */
export function toProductCard(row, ctx) {
  const id = row.id
  const slug = row.slug
  const name = row.name
  if (typeof id !== 'number' || typeof slug !== 'string' || typeof name !== 'string') {
    return null
  }
  const price = effectivePrice(
    /** @type {{ price?: number | null, sale_price?: number | null }} */ (row),
  )
  const list = typeof row.price === 'number' ? row.price : null
  const brandId = typeof row.brand_id === 'number' ? row.brand_id : null
  return {
    product_id: id,
    slug,
    name,
    url: productUrl(ctx.origin, slug),
    price,
    // „redus de la" doar când reducerea e reală; altfel modelul ar anunța o promoție inexistentă.
    price_before: price !== null && list !== null && list > price ? list : null,
    currency: CURRENCY,
    in_stock: row.in_stock === true,
    variant_count: typeof row.variant_count === 'number' ? row.variant_count : 0,
    brand: brandId !== null ? (ctx.brands?.get(brandId) ?? null) : null,
  }
}

/** Descrierea de produs, tăiată la graniță de cuvânt. */
export const productDescription = (/** @type {unknown} */ raw) =>
  truncateAtWord(typeof raw === 'string' ? raw.replace(/<[^>]+>/g, ' ') : '', 500)

/**
 * Annotations de siguranță pentru un tool strict de citire.
 * OpenAI respinge pentru annotations greșite ÎN DIRECȚIA PERMISIVĂ, deci fiecare
 * câmp e declarat explicit, nu lăsat pe default.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
