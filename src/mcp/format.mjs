/**
 * Formatări partajate de tool-uri.
 *
 * ⚠️ Prețul contractual e RON. HUF există în magazin (rată fixă), dar nu se
 * expune aici: un preț fără etichetă de monedă într-un răspuns citit de un model
 * e exact felul în care un client ajunge să creadă că plătește altă sumă. Faza 1
 * întoarce RON, o singură monedă, explicit numită.
 */

/** Moneda unică a răspunsurilor din faza 1. */
export const CURRENCY = 'RON'

/**
 * Prețul efectiv: prețul redus dacă e valid și strict mai mic, altfel prețul de listă.
 * Portat din `effectivePrice()` (tatuat-site/lib/queries.ts) — aceeași regulă,
 * ca un produs la promoție să nu apară în ChatGPT la prețul întreg.
 *
 * @param {{ price?: number | null, sale_price?: number | null }} p
 * @returns {number | null}
 */
export function effectivePrice(p) {
  const list = typeof p.price === 'number' && Number.isFinite(p.price) ? p.price : null
  const sale =
    typeof p.sale_price === 'number' && Number.isFinite(p.sale_price) ? p.sale_price : null
  if (sale !== null && sale > 0 && (list === null || sale < list)) return sale
  return list
}

/** Numărul dacă e finit, altfel null. Un `NaN` propagat ar ajunge „preț indisponibil" abia la afișare. */
const finit = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * @typedef {object} Pretare
 * @property {number | null} price prețul pe care îl plătește clientul
 * @property {number | null} price_before prețul dinainte de reducere, sau null
 * @property {boolean} price_from dacă `price` e un MINIM („de la"), nu un preț exact
 */

/**
 * Prețul unui rând de CATALOG, inclusiv produsele cu variante.
 *
 * 🔴 DE CE NU E DE AJUNS `effectivePrice`. La produsele cu variante,
 * `v_products_with_pricing.price` e 0 — prețul real stă pe variantă, în `from_price`. Citind doar
 * `price`, tool-urile întorceau `price: 0, currency: "RON"`, iar un model care citește asta îi
 * spune clientului că produsul e gratis. Măsurat în producție 29.09.2026 pe
 * `ace-de-tatuat-cartus-limited-rl` (19 variante, toate 5.70) și
 * `ace-de-tatuat-cartus-pro-plus-rm` (variante 3.97…6.97).
 *
 * Regula e PORTATĂ din `effectivePrice` (tatuat-site/lib/queries.ts:49-58), cu ordinea ei de
 * ramuri, iar `price_from` din `ProductCard.tsx:120`. Ordinea contează: la un produs cu variante
 * se taxează varianta, deci `from_price` bate prețul de bază CHIAR DACĂ acela e nenul — altfel am
 * anunța un preț pe care nimeni nu-l plătește („afișat ≠ taxat", comentariul din site).
 *
 * 🔑 `price_from` nu e cosmetic. „3.97 RON" pentru un produs ale cărui variante urcă la 6.97 e o
 * informație falsă; „de la 3.97 RON" e adevărată. Când `from_price_max` lipsește nu putem dovedi
 * că variantele costă la fel, așa că marcăm „de la" — greșeala ieftină, nu cea scumpă.
 *
 * ⚠️ O DIVERGENȚĂ DELIBERATĂ FAȚĂ DE SITE, ca să nu fie „reparată" invers. Eticheta din
 * `ProductCard.tsx:120` cere ȘI `(!p.price || p.price === 0)`, deci la un produs cu preț de bază
 * nenul ȘI variante cu prețuri diferite site-ul afișează minimul FĂRĂ „de la". Aici marcăm „de la".
 * Prețul e același; doar eticheta diferă, iar a noastră e cea adevărată — în cazul ăla minimul CHIAR
 * e un minim. Nu copiem defectul de afișare al site-ului într-un canal unde un model îl repetă ca
 * afirmație. Măsurat 29.09.2026: 0 din 1664 de produse active declanșează cazul (cele 8 cu preț de
 * bază și variante au toate `from_price_max == from_price`), deci azi cele două coincid oricum.
 *
 * ⚠️ GOL CUNOSCUT, LĂSAT DELIBERAT (decizia owner-ului, 30.09.2026). Un produs cu variante al
 * cărui `from_price` lipsește sau e 0 NU intră pe ramura de sus, cade pe ramura simplă și
 * întoarce `products.price`, care la produsele cu variante e 0 — deci „0.00 RON", pe care un
 * model îl poate citi drept „gratis". Un produs SIMPLU fără preț întoarce corect `null`
 * („preț indisponibil"), deci cele două cazuri simetrice răspund opus. Reverificatorul a cerut
 * `null` în ambele; owner-ul a ales să păstreze `0`, informat asupra riscului. Nu schimba fără
 * să-l întrebi din nou. Comportamentul e FIXAT prin teste în `pricing.test.mjs`, ca să rămână o
 * alegere, nu un accident. NEMĂSURAT: dacă vreun produs din catalogul viu e azi în starea asta.
 *
 * @param {Record<string, unknown>} row rând din `v_products_with_pricing`
 * @returns {Pretare}
 */
export function cardPricing(row) {
  const fromPrice = finit(row.from_price)
  const variantCount = finit(row.variant_count) ?? 0
  const pretDeBaza = finit(row.price)

  // Ramurile 1 și 3 din site, contopite: ambele folosesc `from_price` și diferă doar prin condiția
  // de intrare — produsul are variante, SAU prețul de bază lipsește/e zero.
  const areVariante = variantCount > 0
  const bazaLipsa = pretDeBaza === null || pretDeBaza === 0
  if (fromPrice !== null && fromPrice > 0 && (areVariante || bazaLipsa)) {
    const fromWas = finit(row.from_price_was)
    const fromMax = finit(row.from_price_max)
    return {
      price: fromPrice,
      price_before: fromWas !== null && fromWas > fromPrice ? fromWas : null,
      // Doar o dovadă POZITIVĂ că variantele costă la fel scoate eticheta „de la".
      price_from: !(fromMax !== null && fromMax <= fromPrice),
    }
  }

  // Produs simplu: exact comportamentul dinainte, bit cu bit.
  const price = effectivePrice(
    /** @type {{ price?: number | null, sale_price?: number | null }} */ (row),
  )
  return {
    price,
    price_before: price !== null && pretDeBaza !== null && pretDeBaza > price ? pretDeBaza : null,
    price_from: false,
  }
}

/**
 * Formatare monetară pentru textul citit de om.
 * @param {number | null} amount
 * @returns {string}
 */
export function formatPrice(amount) {
  if (amount === null || !Number.isFinite(amount)) return 'preț indisponibil'
  return `${amount.toFixed(2)} ${CURRENCY}`
}

/**
 * Taie un text la o graniță de cuvânt, fără să spargă în mijlocul unuia.
 * Aceeași regulă ca în feed-ul de produse din tatuat-site.
 *
 * @param {unknown} raw
 * @param {number} max
 * @returns {string}
 */
export function truncateAtWord(raw, max) {
  if (typeof raw !== 'string') return ''
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

/**
 * URL-ul canonic al unui produs pe magazin.
 *
 * 🔴 MĂSURAT, nu presupus: prefixul e `/product/`, nu `/produs/`, iar encodarea
 * e decode-apoi-encode — portate 1:1 din `lib/route-slug.ts` (tatuat-site), unde
 * comentariul explică de ce există un singur loc: sitemap, feed XML și feed JSON
 * trebuie să emită link-uri IDENTICE cu canonical-ul paginii, altfel Google
 * Merchant respinge feed-ul. Trei produse reale au spațiu în slug.
 *
 * Decodarea înainte de encodare face funcția idempotentă: un slug deja encodat
 * nu se dublu-encodează (`%20` nu devine `%2520`).
 *
 * @param {string} origin
 * @param {string} slug
 * @returns {string}
 */
export function productUrl(origin, slug) {
  return `${origin}/product/${encodeRouteSlug(slug)}`
}

/**
 * Portat din `encodeRouteSlug` (tatuat-site/lib/route-slug.ts).
 * @param {string} slug
 * @returns {string}
 */
function encodeRouteSlug(slug) {
  let decoded = slug
  try {
    decoded = decodeURIComponent(slug)
  } catch {
    decoded = slug
  }
  return encodeURIComponent(decoded)
}
