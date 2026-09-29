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
