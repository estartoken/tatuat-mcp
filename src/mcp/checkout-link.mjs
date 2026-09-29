/**
 * Semnare și verificare pură a link-urilor de checkout — fără I/O, fără fetch,
 * fără citire de env. Secretul HMAC e primit ca parametru, nu citit de aici:
 * modulul trebuie testabil fără rețea și fără variabile de mediu reale.
 *
 * 🔴 PREȚUL NU CIRCULĂ PRIN LINK. Payload-ul e o INTENȚIE de coș (produs,
 * variantă, cantitate, opțiuni) — prețul autoritar se recitește pe site la
 * checkout, din catalogul live, nu din ce a scris modelul în conversație.
 * Un preț semnat aici ar deveni exact ce ChatGPT arată clientului ca preț
 * final, chiar dacă produsul s-a scumpit/redus/dezactivat între timp.
 *
 * Format:
 *   c   = base64url(JSON.stringify({ items, nonce, exp }))
 *   sig = base64url(HMAC-SHA256(c, secret))
 * URL:  <origin><AGENT_CART_PATH>?c=<c>&sig=<sig>
 *
 * Verificarea semnăturii foloseşte `crypto.timingSafeEqual` pe Buffer, nu
 * `===`: o comparație de string ar scurge, prin timing, câți bytes inițiali
 * coincid. `timingSafeEqual` ARUNCĂ dacă bufferele au lungimi diferite — de
 * aceea lungimea se verifică explicit înainte; altfel un `sig` de lungime
 * greșită de la un atacator ar arunca din `guarded()` ca eroare 500, nu s-ar
 * respinge curat ca semnătură rea.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Calea de pe tatuat.ro pe care aterizează linkul agentului.
 *
 * 🔴 NU `/checkout`, și nu dintr-un motiv de stil. `/checkout` e REVENDICAT de aplicația mobilă pe
 * ambele platforme — iOS prin `apple-app-site-association` (căi exacte, `/checkout` printre ele),
 * Android prin `intentFilters` cu `autoVerify: true` (`/checkout`, `/en/checkout`, `/hu/checkout`).
 * Aplicația nu știe să citească `c`/`sig`, deci un link apăsat în ChatGPT pe un telefon cu aplicația
 * instalată deschide aplicația, care își arată propriul coș — gol — fără nicio eroare. Coșul construit
 * în conversație dispară tăcut, exact pe canalul unde trăiește acest tool.
 *
 * Calea de mai jos e NEREVENDICATĂ (verificat 29.09.2026 în ambele liste, exact și prin wildcard).
 * Site-ul are o rută cu acest nume, care pune produsele în coș și trece la `/checkout` printr-o
 * navigare client-side — nu o încărcare nouă de document, deci fără a doua șansă de intercepție.
 *
 * ⚠️ Cele două repo-uri se deployează separat. Dacă se redenumește ruta pe site, se schimbă și aici,
 * în aceeași trecere — altfel linkul duce la 404, iar clientul vede o pagină goală.
 */
export const AGENT_CART_PATH = '/cos-din-conversatie'

/** Câți bytes de aleatoriu are un nonce, înainte de encodare. */
const NONCE_BYTES = 16

/**
 * @typedef {object} CheckoutItem
 * @property {number} product_id
 * @property {number | null} variant_id
 * @property {number} qty
 * @property {Record<string, string>} options
 */

/**
 * @typedef {object} CheckoutPayload
 * @property {CheckoutItem[]} items
 * @property {string} nonce
 * @property {number} exp epoch secunde
 */

/** @returns {string} nonce base64url, unic per apel */
export function createNonce() {
  return randomBytes(NONCE_BYTES).toString('base64url')
}

/**
 * @param {CheckoutPayload} payload
 * @param {string} secret
 * @returns {{ c: string, sig: string }}
 */
export function signCheckoutPayload(payload, secret) {
  const c = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(c).digest('base64url')
  return { c, sig }
}

/**
 * @param {string} c
 * @returns {CheckoutPayload | null} null dacă nu e base64url→JSON valid sau nu are forma așteptată
 */
export function decodeCheckoutPayload(c) {
  /** @type {unknown} */
  let parsed
  try {
    const json = Buffer.from(c, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray(/** @type {Record<string, unknown>} */ (parsed).items) ||
    typeof /** @type {Record<string, unknown>} */ (parsed).nonce !== 'string' ||
    typeof /** @type {Record<string, unknown>} */ (parsed).exp !== 'number'
  ) {
    return null
  }
  return /** @type {CheckoutPayload} */ (parsed)
}

/**
 * Comparație în timp constant. NU cu `===` — vezi capul fișierului.
 *
 * @param {string} c
 * @param {string} sig
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyCheckoutSignature(c, sig, secret) {
  const expected = createHmac('sha256', secret).update(c).digest()
  const actual = Buffer.from(sig, 'base64url')

  // 🔴 Respinge orice encodare pe care serverul nu ar fi emis-o.
  // `Buffer.from(…, 'base64url')` e DELIBERAT tolerant: ignoră biții de umplutură
  // ai ultimului caracter, acceptă padding `=` și alfabetul base64 clasic. O
  // semnătură de 32 de octeți se scrie în 43 de caractere = 258 de biți, deci
  // ultimul caracter are doar 4 biți semnificativi — măsurat: 16 clase de câte 4
  // caractere care decodează la același octet. Fără linia de mai jos, `sig` și
  // `sig` cu ultimul caracter mutat în clasa lui sunt AMBELE acceptate: patru
  // șiruri distincte pentru o semnătură pe care am emis-o o singură dată.
  //
  // Nu e o slăbiciune a HMAC-ului — octeții comparați rămân corecți — dar e
  // malleabilitate: același coș ar avea patru link-uri „valide" diferite, iar
  // orice dedup/idempotență care cheie pe `sig` s-ar putea ocoli. Un server care
  // emite o formă și acceptă patru e o relaxare tăcută a propriului contract.
  //
  // Re-encodarea e canonică prin construcție; dacă diferă de input, inputul nu e.
  // Comparația cu `!==` nu scurge nimic despre secret: ambele valori derivă
  // exclusiv din `sig`, care e public — nu din `expected`.
  if (actual.toString('base64url') !== sig) return false

  // `timingSafeEqual` ARUNCĂ pe lungimi diferite — verificată explicit, ca un
  // `sig` de lungime greșită să se respingă, nu să arunce mai departe.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Construiește link-ul complet de checkout, cu nonce nou și semnătură.
 *
 * @param {string} origin fără slash final
 * @param {{ items: CheckoutItem[], exp: number, secret: string }} params
 * @returns {{ url: string, payload: CheckoutPayload }}
 */
export function buildCheckoutUrl(origin, { items, exp, secret }) {
  /** @type {CheckoutPayload} */
  const payload = { items, nonce: createNonce(), exp }
  const { c, sig } = signCheckoutPayload(payload, secret)
  const url = new URL(AGENT_CART_PATH, origin)
  url.searchParams.set('c', c)
  url.searchParams.set('sig', sig)
  return { url: url.toString(), payload }
}

/**
 * @typedef {{ valid: true, payload: CheckoutPayload } | { valid: false, reason: 'bad_signature' | 'bad_payload' | 'expired' }} VerifyResult
 */

/**
 * @param {{ c: string, sig: string, secret: string, now?: () => number }} params
 * @returns {VerifyResult}
 */
export function verifyCheckoutLink({ c, sig, secret, now = Date.now }) {
  if (!verifyCheckoutSignature(c, sig, secret)) return { valid: false, reason: 'bad_signature' }
  const payload = decodeCheckoutPayload(c)
  if (payload === null) return { valid: false, reason: 'bad_payload' }
  if (Math.floor(now() / 1000) >= payload.exp) return { valid: false, reason: 'expired' }
  return { valid: true, payload }
}
