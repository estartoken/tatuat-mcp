/**
 * `calculate_shipping` — cost transport + prag gratuit + cadouri la prag, portat
 * 1:1 din tatuat-site (`lib/product-extra.ts`, `lib/gifts.ts`). Formă copiată din
 * FORMA CANONICĂ (`search-products.mjs`).
 *
 * Decizie de input (nu era impusă de spec): tool-ul acceptă ORICARE dintre
 *  - `lines`: liniile coșului (slug SAU product_id + quantity) — subtotalul se
 *    calculează din prețul REAL citit din catalog (`effectivePrice`), nu dintr-unul
 *    declarat de model; permite și detectarea produselor „grele" (`shipping_override`);
 *  - `subtotal`: o sumă deja cunoscută în RON, când modelul a calculat-o deja din
 *    `search_products`/`get_product` și o interogare suplimentară e inutilă
 *    (dar fără produse grele, fiindcă tool-ul nu are de unde ști care linii sunt grele).
 * Exact unul dintre cele două, niciodată ambele — ar fi ambiguu care e sursa de
 * adevăr a subtotalului — niciodată niciunul.
 *
 * Praguri/tarife MĂSURATE din fișierele reale ale magazinului, nu din memorie:
 *  - SHIP_THRESHOLD=300, SHIP_FEE=24 (tatuat-site/lib/product-extra.ts)
 *  - GIFT_THRESHOLD=500, GIFT2_THRESHOLD=800, numele cadourilor (tatuat-site/lib/gifts.ts)
 *  - produs „greu" → `shipping_override` (lei/bucată) ÎNLOCUIEȘTE tariful standard cu
 *    suma override × cantitate, nu se adună la el (`cartShipping`, gifts.ts:
 *    „if (heavy > 0) return heavy" — heavy nu se anulează nici peste pragul gratuit).
 */

import { z } from 'zod'
import { productsForShipping } from '../catalog.mjs'
import { CURRENCY, effectivePrice } from '../format.mjs'
import { READ_ONLY_ANNOTATIONS } from '../schemas.mjs'
import { okResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'

export const name = 'calculate_shipping'

/** Portate 1:1 din tatuat-site/lib/product-extra.ts. */
export const SHIP_THRESHOLD = 300
export const SHIP_FEE = 24
/** Portate 1:1 din tatuat-site/lib/gifts.ts. Cumulativ: la 800 ambele cadouri sunt atinse. */
export const GIFT_THRESHOLD = 500
export const GIFT2_THRESHOLD = 800
export const GIFT_PRODUCT_NAME = 'Frost Proactive Piercing Skin Recovery 30ml'
export const GIFT2_PRODUCT_NAME = 'Frost Soft Cleansing Foam Gentlecare 200ml'
const GIFTS = [
  { name: GIFT_PRODUCT_NAME, threshold: GIFT_THRESHOLD },
  { name: GIFT2_PRODUCT_NAME, threshold: GIFT2_THRESHOLD },
]

export const MAX_LINES = 50
export const MAX_QUANTITY = 9999
export const MAX_SUBTOTAL = 1_000_000

/**
 * Rotunjire la 2 zecimale ÎNAINTE de comparație — ca shippingFor/cartMilestones din site
 * (subtotalul se acumulează în float: 0.1+0.2 ≠ 0.3, un coș exact pe prag putea cădea greșit).
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100
}

const CartLine = z
  .object({
    slug: z.string().min(1).max(200).optional().describe('Slug-ul produsului, ca cel întors de search_products.'),
    product_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Identificatorul numeric al produsului, alternativă la slug.'),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUANTITY)
      .describe('Câte bucăți din acest produs sunt în coș.'),
  })
  .describe('O linie de coș: exact unul dintre slug sau product_id, plus cantitatea.')
  .refine((line) => (line.slug !== undefined) !== (line.product_id !== undefined), {
    message: 'Exact unul dintre slug și product_id trebuie dat, nu ambele și nu niciunul.',
  })

export const inputSchema = z
  .object({
    lines: z
      .array(CartLine)
      .max(MAX_LINES)
      .optional()
      .describe(
        `Liniile coșului (maxim ${MAX_LINES}), ca tool-ul să calculeze subtotalul din prețurile reale ale catalogului. Coș gol = listă vidă. Folosește ori acest câmp, ori 'subtotal', niciodată ambele.`,
      ),
    subtotal: z
      .number()
      .min(0)
      .max(MAX_SUBTOTAL)
      .optional()
      .describe(
        "Subtotalul coșului în RON, dacă e deja cunoscut (de exemplu calculat din prețurile întoarse de search_products). Folosește ori acest câmp, ori 'lines', niciodată ambele.",
      ),
  })
  .refine((v) => (v.lines !== undefined) !== (v.subtotal !== undefined), {
    message: "Exact unul dintre 'lines' și 'subtotal' trebuie dat, nu ambele și nu niciunul.",
  })

const GiftInfo = z.object({
  name: z.string().describe('Numele cadoului.'),
  amount_needed: z.number().describe('Cât mai trebuie adăugat la coș, în RON, ca să fie atins acest cadou.'),
})

export const outputSchema = z.object({
  subtotal: z.number().describe('Subtotalul folosit la calcul, în RON.'),
  shipping_fee: z.number().describe('Costul transportului pentru acest coș, în RON (0 = gratuit).'),
  free_shipping: z.boolean().describe('Dacă transportul e gratuit la acest coș.'),
  amount_to_free_shipping: z
    .number()
    .describe('Cât mai trebuie adăugat la coș, în RON, pentru transport gratuit (0 dacă e deja atins).'),
  heavy_shipping: z
    .boolean()
    .describe('Dacă tariful de mai sus vine din produse "grele" cu transport propriu, nu din tariful standard.'),
  currency: z.literal(CURRENCY).describe('Moneda tuturor sumelor. Întotdeauna RON.'),
  gifts_reached: z.array(z.string()).describe('Numele cadourilor pentru care coșul a atins deja pragul.'),
  next_gift: GiftInfo.nullable().describe(
    'Următorul cadou de atins și cât mai e nevoie, sau null dacă toate cadourile au fost atinse.',
  ),
})

export const config = {
  title: 'Calculează transportul pe tatuat.ro',
  description:
    "Calculează costul de transport, pragul pentru transport gratuit și cadourile atinse la prag pentru un coș tatuat.ro. Dă fie 'lines' (produsele coșului, ca tool-ul să citească prețul real din catalog), fie un 'subtotal' deja cunoscut. Folosește acest tool când clientul întreabă cât costă transportul sau cât mai trebuie să cumpere pentru livrare gratuită sau cadou.",
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
 * @param {Record<string, unknown>} row
 * @param {number} quantity
 * @returns {number} 0 = produs normal, altfel tariful de transport al liniei (override × cantitate).
 */
function heavyFeeFor(row, quantity) {
  const override =
    typeof row.shipping_override === 'number' && Number.isFinite(row.shipping_override)
      ? row.shipping_override
      : 0
  return override > 0 ? override * quantity : 0
}

/** @param {number} subtotal */
function nextGift(subtotal) {
  const upcoming = GIFTS.find((g) => subtotal < g.threshold)
  return upcoming ? { name: upcoming.name, amount_needed: round2(upcoming.threshold - subtotal) } : null
}

/** @param {number} subtotal */
function giftsReached(subtotal) {
  return GIFTS.filter((g) => subtotal >= g.threshold).map((g) => g.name)
}

/**
 * @param {Deps} [deps]
 */
export function createHandler(deps = {}) {
  /**
   * @param {{ lines?: { slug?: string, product_id?: number, quantity: number }[], subtotal?: number }} args
   * @param {{ sessionId?: string }} [ctx]
   * @returns {Promise<import('../tool-result.mjs').ToolResult>}
   */
  return async function handler(args, ctx = {}) {
    return guarded(async () => {
      if (deps.limiter) {
        // Cheia e sesiunea MCP când transportul o dă; altfel o singură găleată.
        await enforce(deps.limiter, `${name}:${ctx.sessionId ?? 'anon'}`)
      }

      const passThrough = { env: deps.env ?? process.env, fetchImpl: deps.fetchImpl }

      let subtotal
      let heavyTotal = 0

      if (args.subtotal !== undefined) {
        // Sursa e un subtotal deja cunoscut — niciun apel de rețea, niciun produs greu detectabil.
        subtotal = args.subtotal
      } else {
        const lines = args.lines ?? []
        const slugs = [...new Set(lines.filter((l) => l.slug !== undefined).map((l) => /** @type {string} */ (l.slug)))]
        const ids = [
          ...new Set(lines.filter((l) => l.product_id !== undefined).map((l) => /** @type {number} */ (l.product_id))),
        ]

        /** @type {Record<string, unknown>[]} */
        let rows = []
        if (slugs.length > 0 || ids.length > 0) {
          rows = await productsForShipping({ slugs, ids }, passThrough)
        }
        const bySlug = new Map(rows.map((r) => [r.slug, r]))
        const byId = new Map(rows.map((r) => [r.id, r]))

        subtotal = 0
        for (const line of lines) {
          const row = line.slug !== undefined ? bySlug.get(line.slug) : byId.get(line.product_id)
          // Produs necunoscut/dezactivat: linia nu contribuie — fail-closed, nu preț inventat.
          if (!row) continue
          const price = effectivePrice(/** @type {{ price?: number | null, sale_price?: number | null }} */ (row))
          if (price !== null) subtotal += price * line.quantity
          heavyTotal += heavyFeeFor(row, line.quantity)
        }
      }

      const roundedSubtotal = round2(Math.max(0, subtotal))
      // `cartShipping` (gifts.ts): un produs greu ÎNLOCUIEȘTE tariful standard cu suma
      // override-urilor — nu se anulează nici peste pragul de transport gratuit.
      const heavy = heavyTotal > 0
      // ⚠️ ISTORIC CORECTAT (28.09.2026): forma `heavy && roundedSubtotal >= SHIP_THRESHOLD ?` NU a
      // existat niciodată în codul livrat. A stat aici câteva minute ca MUTANT DELIBERAT, ca să se
      // dovedească că testul „produs greu SUB pragul de transport gratuit" discriminează — și a
      // discriminat: `fail 1` din 178, exact acel test, restul verzi. O sesiune paralelă a citit
      // mutantul în fereastra aceea, l-a luat drept bug livrat și a consemnat aici că ar fi fost
      // „găsit prin test:critical". Nu a fost. Nu raporta un bug de producție pe baza acestei linii.
      //
      // Proprietatea apărată rămâne cea documentată sus și în gifts.ts („if (heavy > 0) return heavy"):
      // `heavy` decide SINGUR ramura; pragul de transport gratuit intră DOAR când coșul nu e greu. Cu
      // pragul mutat în față, un produs greu sub 300 lei ar fi facturat SHIP_FEE=24 în loc de
      // override-ul lui real.
      const shippingFee = heavy ? round2(heavyTotal) : roundedSubtotal >= SHIP_THRESHOLD ? 0 : SHIP_FEE
      const freeShipping = shippingFee === 0
      const amountToFreeShipping = round2(Math.max(0, SHIP_THRESHOLD - roundedSubtotal))
      const reached = giftsReached(roundedSubtotal)
      const upcoming = nextGift(roundedSubtotal)

      const text = [
        `Subtotal ${roundedSubtotal.toFixed(2)} RON.`,
        heavy
          ? `Transport ${shippingFee.toFixed(2)} RON (produse cu tarif propriu de transport).`
          : freeShipping
            ? 'Transport gratuit.'
            : `Transport ${shippingFee.toFixed(2)} RON. Mai sunt necesari ${amountToFreeShipping.toFixed(2)} RON pentru transport gratuit.`,
        reached.length > 0 ? `Cadouri atinse: ${reached.join(', ')}.` : null,
        upcoming
          ? `Următorul cadou: ${upcoming.name}, mai sunt necesari ${upcoming.amount_needed.toFixed(2)} RON.`
          : null,
      ]
        .filter((line) => line !== null)
        .join(' ')

      return okResult(text, {
        subtotal: roundedSubtotal,
        shipping_fee: shippingFee,
        free_shipping: freeShipping,
        amount_to_free_shipping: amountToFreeShipping,
        heavy_shipping: heavy,
        currency: CURRENCY,
        gifts_reached: reached,
        next_gift: upcoming,
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
