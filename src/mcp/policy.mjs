/**
 * Politica de conținut a canalului ChatGPT: ce NU iese din catalog prin pluginul
 * public.
 *
 * DE CE EXISTĂ: lista OpenAI de produse interzise conține, verbatim,
 * „prescription-only medications" și „harmful or dangerous materials". Ace,
 * tușuri și mașini de tatuat sunt bunuri fizice obișnuite și nu apar pe listă.
 * Riscul real, MĂSURAT pe catalogul propriu, sunt cremele/spray-urile
 * ANESTEZICE cu substanță activă declarată — pot fi citite ca medicamente.
 *
 * 🔴 DE CE O LISTĂ MĂSURATĂ ȘI NU UN DETECTOR PE CUVINTE:
 * în catalogul real există ~18 produse „Biotat Numbing" a căror descriere
 * conține LITERAL „Este 100% fara lidocaina. COMPLET NATURAL". Un detector care
 * caută cuvântul „lidocaina" ar clasifica drept risc exact produsele care neagă
 * riscul, și ar exclude o familie întreagă de produse vandabile. Lista de mai
 * jos e rezultatul unei interogări pe catalog, nu al unei euristici — fiecare
 * intrare poartă substanța găsită în textul produsului.
 *
 * 🔑 CE se exclude rămâne DECIZIA OWNERULUI. Modulul livrează mecanismul plus
 * lista măsurată ca default. Default-ul e restrictiv deliberat: un produs rămas
 * în canal care n-ar fi trebuit să fie acolo e o respingere de plugin, iar unul
 * exclus din greșeală e doar o vânzare mai puțin.
 */

/**
 * Produsele excluse din canalul ChatGPT, cu motivul măsurat în textul lor.
 * Măsurătoare din catalogul LIVE, 29.09.2026.
 *
 * @type {ReadonlyArray<{ id: number, name: string, why: string }>}
 */
export const EXCLUDED_PRODUCTS = [
  { id: 1455, name: 'Tattoo Soothe 10g', why: '5% lidocaina, 2% tetracaina, 0,02% epinefrina' },
  { id: 2971, name: 'Tattoo Soothe 30ml', why: 'anestezic cu substanță activă declarată' },
  { id: 1840, name: 'Bactine 150ml', why: '4% lidocaina' },
  { id: 4606, name: 'Gel Feel Better Now 30ml', why: 'anestezic topic' },
  { id: 4605, name: 'Cremă Feel Better Now 15g', why: 'anestezic topic' },
  { id: 1506762, name: 'Cremă Recovery 30ml', why: 'anestezic topic' },
  { id: 8002, name: 'Recovery Numbing Cream 120ml', why: 'anestezic topic' },
]

/** Id-urile excluse, pentru căutare în O(1). */
export const EXCLUDED_PRODUCT_IDS = new Set(EXCLUDED_PRODUCTS.map((p) => p.id))

/**
 * Dacă un id de produs are voie în canalul ChatGPT.
 *
 * 🔑 FAIL-CLOSED pe id nedeterminabil: un rând fără `id` numeric întreg pozitiv
 * NU e „probabil în regulă", e un rând despre care politica nu poate decide —
 * deci nu iese. Asta acoperă rândurile trunchiate, `id` sosit ca string dintr-un
 * JSON neașteptat, `NaN` dintr-o conversie tăcută și obiectele goale.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isAllowedProductId(id) {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return false
  return !EXCLUDED_PRODUCT_IDS.has(id)
}

/**
 * Dacă un rând de produs are voie în canalul ChatGPT.
 *
 * ⚠️ Se aplică DOAR pe rânduri de PRODUS. `product_variants` și `brands` au
 * propriile spații de id-uri, iar un id de variantă care coincide numeric cu un
 * id de produs exclus ar dispărea tăcut. De aceea cablajul din `catalog.mjs`
 * atinge exact cele patru funcții care întorc produse, nu toate citirile.
 *
 * @param {unknown} row
 * @returns {boolean}
 */
export function isAllowedProduct(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  return isAllowedProductId(/** @type {{ id?: unknown }} */ (row).id)
}

/**
 * Scoate produsele excluse dintr-o listă, păstrând ordinea celorlalte.
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {Record<string, unknown>[]}
 */
export function filterAllowedProducts(rows) {
  return rows.filter((row) => isAllowedProduct(row))
}

/**
 * Fișa unui produs, sau `null` dacă politica îl exclude — aceeași valoare pe
 * care apelantul o primește pentru un produs inexistent, deci un produs exclus
 * nu se distinge de unul care nu există. Fără mesaj care să confirme existența.
 *
 * @param {Record<string, unknown> | null} row
 * @returns {Record<string, unknown> | null}
 */
export function allowedProductOrNull(row) {
  return row !== null && isAllowedProduct(row) ? row : null
}

/**
 * Codul restricției de comandă a produsului „doar Ungaria".
 *
 * 🔴 MĂSURAT din regula REALĂ, nu inventată aici: `place_order` respinge cu
 * `product_hu_only`, iar oglinda lui din client
 * (tatuat-site/components/CheckoutForm.tsx:268) interoghează exact
 * `products.lang = 'hu'` și blochează NUMAI când `country !== 'HU'`. Criteriul e
 * deci `lang`, NU `hidden_from_catalog`: ascunderea din catalog e o decizie de
 * AFIȘARE, limba e cea care decide eligibilitatea la COMANDĂ. Măsurat
 * 01.10.2026 în tabelă: azi cele două criterii sunt coextensive (un singur rând
 * `lang='hu'`, el fiind și singurul ascuns) — alegerea contează la drift viitor,
 * iar cea corectă e cea care oglindește serverul.
 */
export const HU_ONLY = 'hu_only'

/**
 * Textul pe care un tool îl adaugă la răspuns pentru un produs restricționat.
 *
 * Formulat ca în `CheckoutForm` („disponibil doar pentru comenzi din Ungaria"),
 * ca să nu apară un al doilea vocabular pentru aceeași regulă.
 */
export const ORDER_RESTRICTION_NOTICE = {
  [HU_ONLY]:
    'ATENȚIE: acest produs este disponibil DOAR pentru comenzi cu livrare în Ungaria. O comandă cu livrare în România va fi refuzată la plasare.',
}

/**
 * Restricția de comandă a unui rând de produs, sau `null` dacă n-are niciuna.
 *
 * 🔑 De ce se ANUNȚĂ, nu se ascunde: „ascuns dar cumpărabil" e intenția
 * ownerului (banner geo → fișă accesibilă pe link direct), iar
 * `get_product`/`get_stock` oglindesc FIȘA, nu listele — listele îl exclud deja
 * prin gate-ul RO-only din RPC-uri (măsurat 01.10.2026: `search_products` și
 * `browse_category` pe toate cele 4 categorii ale produsului, 0 apariții cu
 * control pozitiv). Ce a produs incidentul n-a fost vizibilitatea, ci TĂCEREA:
 * agentul confirma „are stoc suficient", clientul completa formularul, iar
 * comanda murea la `place_order` cu un mesaj care arăta ca „server picat".
 *
 * ⚠️ Cere `lang` ÎN RÂND. Un rând fără câmpul `lang` nu e „fără restricție", e
 * un rând despre care politica nu poate decide. De asta listele de `select` din
 * `catalog.mjs` îl includ, iar `policy.test.mjs` verifică structural includerea —
 * altfel un `select` scurtat tăcut ar face funcția asta să întoarcă `null`
 * pentru TOT, adică exact tăcerea pe care o repară.
 *
 * ⚠️ Doar `'hu'`, nu „orice limbă ≠ ro": serverul filtrează `.eq('lang','hu')`.
 * O verificare mai largă ar bloca cazuri pe care serverul le acceptă.
 *
 * @param {unknown} row
 * @returns {typeof HU_ONLY | null}
 */
export function orderRestrictionForRow(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const lang = /** @type {{ lang?: unknown }} */ (row).lang
  if (typeof lang !== 'string') return null
  return lang.trim().toLowerCase() === 'hu' ? HU_ONLY : null
}
