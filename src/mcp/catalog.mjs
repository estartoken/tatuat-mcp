/**
 * Accesul la catalog, portat din tatuat-site — nu reimplementat.
 *
 * 🔴 GATE-UL RO-ONLY, măsurat, nu presupus:
 * `search_products_personalized` și `products_in_category` primesc `p_lang`, iar
 * OMITEREA lui e fail-closed: serverul întoarce doar produsele cu `lang is null`,
 * adică RO. Comportamentul e verificat pgTAP în magazin (`lib/catalog-extra.ts`,
 * `lib/queries.ts`, owner 19.09). Faza 1 a pluginului e RO-only, deci `p_lang` nu
 * se trimite NICIODATĂ de aici — produsul FROST doar-Ungaria nu apare în LISTE.
 *
 * ⚠️ CORECTAT 30.09.2026, măsurat pe producție: fraza de mai sus spunea „nu apare în
 * ChatGPT", ceea ce e FALS și promitea o garanție pe care canalul nu o are. Gate-ul
 * `p_lang` acoperă LISTELE, atât. Măsurat pe un produs cu `lang='hu'`:
 *   • `search_products` — NU îl întoarce (verificat pe `name` ȘI `slug`; câmpul e
 *     `product_id`, nu `id`, iar o probă pe `id` iese vidă și pare verde). ✅
 *   • `get_product` pe slug direct — îl întoarce ÎNTREG. Vezi paragraful de mai jos:
 *     e paritate deliberată cu magazinul, nu un bug.
 *   • `create_checkout` — poate semna un link care îl conține. Nu poate face altfel:
 *     acel tool nu citește DB-ul deloc (zero cereri de rețea, by design), deci nu are
 *     de unde să afle `lang`. Singurul gard de acolo e denylist-ul static.
 * ⇒ Un agent putea parcurge tot drumul, iar comanda murea abia la `place_order` cu
 * `product_hu_only`. Un refuz care apare doar la final, fără ca nimic de pe drum să-l
 * fi anunțat, nu se citește ca regulă de business — se citește ca defecțiune.
 * CE se face cu asta e decizia ownerului (vezi nota din `policy.mjs`).
 *
 * ⚠️ Tipurile generate ale magazinului (`lib/database.types.ts`) NU arată `p_lang`.
 * Sunt stale — o altă sesiune le regenerează. Sursa de adevăr folosită aici e codul
 * LIVE care apelează RPC-urile, nu artefactul generat.
 *
 * Fișa de produs NU e filtrată pe limbă, tot ca în magazin: produsul doar-HU e
 * ascuns din liste, dar rămâne accesibil pe link direct („ascuns dar cumpărabil").
 */

import { rpc, select } from './postgrest.mjs'
import { filterAllowedProducts, allowedProductOrNull } from './policy.mjs'
import { effectivePrice } from './format.mjs'

/**
 * Exact coloanele cardului. RPC-urile întorc altfel TOT (inclusiv `search_tsv` și
 * descrierile) — ~321KB la 20 de produse în magazin.
 */
export const CARD_SELECT =
  'id,slug,name,price,sale_price,on_sale,from_price,from_price_was,from_price_max,in_stock,stock_qty,primary_image,variant_count,brand_id'

/** Coloanele fișei de produs. */
export const DETAIL_SELECT =
  'id,slug,name,description,price,sale_price,on_sale,sale_start,sale_end,from_price,from_price_was,from_price_max,in_stock,stock_qty,primary_image,variant_count,brand_id,sku,weight_g,model'

/**
 * Sortările acceptate de `products_in_category`.
 *
 * 🔴 MĂSURAT din tipul `CategorySort` (tatuat-site/lib/catalog-extra.ts:9), nu
 * ghicit din semnătura `p_sort?: string`: valorile de preț se numesc `cheap` și
 * `expensive`, NU `price_asc`/`price_desc`. Un nume inventat ar fi ajuns la RPC
 * ca string valid și ar fi produs o sortare greșită fără eroare.
 */
export const CATEGORY_SORTS = ['for_you', 'popular', 'cheap', 'expensive', 'newest']

/** Sortarea implicită, ca în magazin (`getCategoryProductsPage`). */
export const DEFAULT_CATEGORY_SORT = 'for_you'

/**
 * Rânduri de PRODUS gata de trimis spre model: formă validată, apoi politica de
 * conținut a canalului ChatGPT aplicată (`policy.mjs`).
 *
 * 🔑 De ce un helper separat și nu filtru în `asRows`: filtrul se cablează DOAR
 * pe căile de produs. `productVariants` și `brandNames` citesc alte tabele, în
 * care `id` e id de VARIANTĂ, respectiv de BRAND — un id coincident numeric ar
 * face să dispară tăcut o variantă legitimă, iar simptomul n-ar apărea în niciun
 * test de politică.
 *
 * 🔑 De ce filtrul stă aici și nu în tool-uri: un tool nou care ar uita să-l
 * apeleze ar expune produsul. Aici e pe drumul comun al celor trei citiri de
 * listă, deci omisiunea nu e posibilă fără a schimba `catalog.mjs`.
 *
 * @param {unknown} rows
 * @returns {Record<string, unknown>[]}
 */
function asProductRows(rows) {
  return filterAllowedProducts(asRows(rows))
}

/**
 * @param {unknown} rows
 * @returns {Record<string, unknown>[]}
 */
function asRows(rows) {
  return Array.isArray(rows) ? /** @type {Record<string, unknown>[]} */ (rows) : []
}

/**
 * Căutare în catalog. `p_lang` deliberat neomis → RO-only.
 *
 * @param {{ query: string, limit: number }} params
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function searchProducts({ query, limit }, opts = {}) {
  const q = query.trim()
  // Sub 2 caractere magazinul nici nu întreabă serverul; aceeași regulă, ca un tool
  // să nu ceară catalogul întreg pentru „a".
  if (q.length < 2) return []
  const rows = await rpc(
    'search_products_personalized',
    { p_query: q, p_limit: limit },
    { select: CARD_SELECT, ...opts },
  )
  return asProductRows(rows)
}

/**
 * Produsele unei categorii, cu descendenți (CTE recursiv în server).
 * `categoryId` null = tot catalogul, ca „Toate produsele" în magazin.
 *
 * @param {{ categoryId: number | null, sort: string, limit: number, offset: number }} params
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function categoryProducts({ categoryId, sort, limit, offset }, opts = {}) {
  const rows = await rpc(
    'products_in_category',
    {
      // `undefined` → cheia dispare din payload → RPC-ul își folosește defaultul.
      p_category_id: categoryId ?? undefined,
      p_sort: sort,
      p_limit: limit,
      p_offset: offset,
    },
    { select: CARD_SELECT, ...opts },
  )
  return asProductRows(rows)
}

/**
 * Fișa unui produs după slug. `null` = nu există sau e inactiv.
 *
 * @param {string} slug
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function productBySlug(slug, opts = {}) {
  const rows = await select(
    'v_products_with_pricing',
    `select=${DETAIL_SELECT}&slug=eq.${encodeURIComponent(slug)}&status=is.true&limit=1`,
    opts,
  )
  return allowedProductOrNull(rows.length > 0 ? /** @type {Record<string, unknown>} */ (rows[0]) : null)
}

/**
 * Variantele unui produs. Lista poate fi goală — produsele simple nu au variante.
 *
 * @param {number} productId
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function productVariants(productId, opts = {}) {
  return select(
    'product_variants',
    `select=id,name,sku,price,sale_price,stock_qty,is_default&product_id=eq.${productId}&order=is_default.desc,id.asc&limit=100`,
    opts,
  )
}

/**
 * Numele brandurilor pentru un set de id-uri, ca răspunsurile să nu conțină
 * `brand_id: 12` — un model nu poate face nimic util cu un id de brand.
 *
 * @param {number[]} ids
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Map<number, string>>}
 */
export async function brandNames(ids, opts = {}) {
  const unique = [...new Set(ids.filter((n) => Number.isSafeInteger(n)))]
  if (unique.length === 0) return new Map()
  const rows = await select(
    'brands',
    `select=id,name&id=in.(${unique.join(',')})&limit=${unique.length}`,
    opts,
  )
  return new Map(
    rows
      .map((r) => /** @type {{ id?: unknown, name?: unknown }} */ (r))
      .filter((r) => typeof r.id === 'number' && typeof r.name === 'string')
      .map((r) => [/** @type {number} */ (r.id), /** @type {string} */ (r.name)]),
  )
}

/**
 * Caracterele care au SENS STRUCTURAL în gramatica de filtre PostgREST și de
 * aceea nu pot apărea într-o valoare interpolată în `or=(…)`.
 *
 * 🔴 DENYLIST, nu allowlist alfanumeric — deliberat. `tatuat-site/lib/route-slug.ts`
 * documentează măsurat că 3 produse REALE au SPAȚIU în slug; un `[a-z0-9-]+` ar
 * „rezolva" injecția excluzând produse care există, adică o regresie funcțională
 * reală în locul unei vulnerabilități.
 *
 * De ce nu e destul `encodeURIComponent`: `(` și `)` sunt „unreserved" în RFC3986,
 * deci nu le atinge, iar virgulele pe care le escapează (`%2C`) sunt
 * percent-decodate de server ÎNAINTE ca PostgREST să parseze gramatica filtrului.
 * Un slug ca `x),slug.eq.y,slug.in.(z` închide clauza curentă, adaugă clauze
 * paralele și redeschide una — paranteze balansate, interogare sintactic validă,
 * cu totul alt sens. O singură virgulă ajunge pentru varianta tăcută: `a,b` ar
 * lărgi lista de valori din `in.(…)` fără nicio eroare de sintaxă.
 */
const UNSAFE_FOR_POSTGREST_FILTER = /[(),]/

/**
 * Preț + tarif de transport propriu pentru liniile calculatorului de transport.
 *
 * 🔴 Piesă LIPSĂ, adăugată aici (nu exista niciun accesor pe tabela `products`):
 * `v_products_with_pricing` NU expune `shipping_override`/`weight_g` — exact ca în
 * `reconcileCartLines` din tatuat-site (`lib/product-extra.ts`), care pentru același
 * motiv citește aceste două coloane direct din `products`, tabela de bază, RLS
 * `select using (true)` la fel ca vederea. Citim `price`/`sale_price` de-acolo tot
 * direct — `effectivePrice()` (format.mjs) le combină, ca la orice card de produs.
 *
 * @param {{ slugs: string[], ids: number[] }} params
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function productsForShipping({ slugs, ids }, opts = {}) {
  const uniqueSlugs = [
    ...new Set(
      slugs.filter(
        (s) => typeof s === 'string' && s.length > 0 && !UNSAFE_FOR_POSTGREST_FILTER.test(s),
      ),
    ),
  ]
  const uniqueIds = [...new Set(ids.filter((n) => Number.isSafeInteger(n)))]

  const filters = []
  if (uniqueSlugs.length > 0) filters.push(`slug.in.(${uniqueSlugs.map(encodeURIComponent).join(',')})`)
  if (uniqueIds.length > 0) filters.push(`id.in.(${uniqueIds.join(',')})`)
  // 🔑 Gardul de ieșire e DUPĂ filtrare, nu înainte. Dacă ar fi înainte, o cerere
  // cu un singur slug nesigur și fără id-uri ar trece de el și ar ajunge să trimită
  // `or=()` — interogare malformată, nu listă goală.
  if (filters.length === 0) return []

  // `limit` se numără din valorile care au RĂMAS în filtru. Calculat din cele
  // cerute, ar fi o cifră fără referent: un plafon de 3 pe o interogare de 2.
  const limit = uniqueSlugs.length + uniqueIds.length

  // 🔴 `product_variants(...)` ÎMBRICAT, nu o a doua cerere. La cele 55 de produse cu variante,
  // `products.price` e 0 (măsurat 29.09.2026 direct în tabelă, nu în view) — prețul real stă pe
  // variantă. Fără coloana asta, subtotalul unui coș plin ieșea 0 și clientul era anunțat că mai
  // are de cumpărat până la transport gratuit, deși îl avea deja.
  //
  // 🔑 DE CE NU view-ul `v_products_with_pricing`, care are deja `from_price`: nu are
  // `shipping_override`, iar fără el taxa de colet greu s-ar pierde tăcut. Îmbricarea păstrează
  // ambele într-o singură cerere de rețea.
  const rows = await select(
    'products',
    `select=id,slug,price,sale_price,shipping_override,weight_g,product_variants(price,sale_price)&or=(${filters.join(',')})&status=is.true&limit=${limit}`,
    opts,
  )
  return asProductRows(rows).map(withVariantPricing)
}

/**
 * Traduce variantele îmbricate în forma pe care o citește `cardPricing`: `from_price` (minimul
 * prețurilor efective de variantă), `from_price_max` și `variant_count`.
 *
 * Rândul rezultat arată ca unul de catalog, deci regula de preț rămâne una singură, în
 * `format.mjs` — nu apare o a doua implementare care să devieze de prima.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function withVariantPricing(row) {
  const variants = Array.isArray(row.product_variants) ? row.product_variants : []
  if (variants.length === 0) return row
  // `flatMap`, nu `map().filter()`: un `.filter(p => p !== null)` nu îngustează tipul, iar
  // `Math.min` ar primi `(number | null)[]` — `null` se coerce la 0 și minimul ar ieși 0, adică
  // exact regresia „preț 0" de la care a pornit fixul, reintrodusă pe altă cale.
  const preturi = variants.flatMap((v) => {
    const p = effectivePrice(/** @type {{ price?: number | null, sale_price?: number | null }} */ (v))
    return p !== null && p > 0 ? [p] : []
  })
  if (preturi.length === 0) return { ...row, variant_count: variants.length }
  return {
    ...row,
    variant_count: variants.length,
    from_price: Math.min(...preturi),
    from_price_max: Math.max(...preturi),
  }
}
