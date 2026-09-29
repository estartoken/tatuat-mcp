/**
 * Teste pentru `create_checkout`.
 *
 * ⚠️ Fără cereri de rețea: acest tool nu face fetch (nu citește catalogul),
 * doar semnează un payload cu `checkout-link.mjs`. Nu există fetchImpl de
 * stubuit aici — deps.env e mediul fals, injectat direct.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createHandler,
  inputSchema,
  outputSchema,
  config,
  MAX_ITEMS,
  MAX_OPTIONS,
  MAX_OPTION_KEY,
  MAX_OPTION_VALUE,
  MAX_LINK_CHARS,
} from './create-checkout.mjs'
import { MAX_QTY_PER_LINE } from './get-stock.mjs'
import { decodeCheckoutPayload, verifyCheckoutLink } from '../checkout-link.mjs'

/** Mediu fals. Nicio cheie reală în teste. */
const ENV = {
  TATUAT_SITE_URL: 'https://tatuat.ro',
  AGENT_CHECKOUT_SECRET: 'test-hmac-secret-not-real',
}

const ONE_ITEM = [{ product_id: 101, variant_id: null, qty: 2, options: {} }]

/**
 * @param {{ items: { product_id: number, variant_id: number | null, qty: number, options: Record<string, string> }[] }} args
 * @param {Record<string, string | undefined>} [env]
 */
function run(args, env = ENV) {
  const handler = createHandler({ env })
  return handler(args, {})
}

/**
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

test('CONTROL POZITIV: coș valid → link ce începe cu TATUAT_SITE_URL și trece verificarea', async () => {
  const result = await run({ items: ONE_ITEM })
  assert.equal(result.isError, undefined)
  const data = structured(result)
  assert.ok(data.url.startsWith(ENV.TATUAT_SITE_URL), `url nu începe cu site-ul: ${data.url}`)

  const u = new URL(data.url)
  const c = u.searchParams.get('c')
  const sig = u.searchParams.get('sig')
  assert.ok(c && sig, 'linkul nu are c/sig')
  const verified = verifyCheckoutLink({ c: /** @type {string} */ (c), sig: /** @type {string} */ (sig), secret: ENV.AGENT_CHECKOUT_SECRET })
  assert.equal(verified.valid, true, 'linkul emis de tool nu trece propria verificare')
})

test('secret absent din env → isError, fără să scurgă numele variabilei sau vreo valoare', async () => {
  const { AGENT_CHECKOUT_SECRET, ...withoutSecret } = ENV
  const result = await run({ items: ONE_ITEM }, withoutSecret)
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('AGENT_CHECKOUT_SECRET'), false, 'a scurs numele variabilei de mediu')
  assert.equal(text.toLowerCase().includes('secret'), false, 'a scurs cuvântul "secret" în text')
})

test('coș gol → respins de inputSchema', () => {
  assert.equal(inputSchema.safeParse({ items: [] }).success, false)
})

test('coș cu un produs → acceptat de inputSchema (CONTROL POZITIV)', () => {
  assert.equal(inputSchema.safeParse({ items: ONE_ITEM }).success, true)
})

test('cantitate 0 → respinsă de inputSchema', () => {
  assert.equal(
    inputSchema.safeParse({ items: [{ product_id: 101, variant_id: null, qty: 0, options: {} }] }).success,
    false,
  )
})

test('cantitate negativă → respinsă de inputSchema', () => {
  assert.equal(
    inputSchema.safeParse({ items: [{ product_id: 101, variant_id: null, qty: -1, options: {} }] }).success,
    false,
  )
})

test('cantitate pozitivă → acceptată de inputSchema (CONTROL POZITIV)', () => {
  assert.equal(
    inputSchema.safeParse({ items: [{ product_id: 101, variant_id: null, qty: 1, options: {} }] }).success,
    true,
  )
})

/** @param {number} n */
function itemsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    product_id: 101 + i,
    variant_id: null,
    qty: 1,
    options: {},
  }))
}

test('exact MAX_ITEMS linii → acceptat de inputSchema (CONTROL POZITIV pe granița exactă)', () => {
  assert.equal(inputSchema.safeParse({ items: itemsOf(MAX_ITEMS) }).success, true)
})

test('MAX_ITEMS + 1 linii → respins de inputSchema (granița exactă, nu mijlocul intervalului)', () => {
  assert.equal(inputSchema.safeParse({ items: itemsOf(MAX_ITEMS + 1) }).success, false)
})

test('product_id 0 → respins de inputSchema (positive(), nu doar int())', () => {
  assert.equal(
    inputSchema.safeParse({ items: [{ product_id: 0, variant_id: null, qty: 1, options: {} }] }).success,
    false,
  )
})

test('variant_id 0 → respins de inputSchema (positive(), nu doar int())', () => {
  assert.equal(
    inputSchema.safeParse({ items: [{ product_id: 101, variant_id: 0, qty: 1, options: {} }] }).success,
    false,
  )
})

test('niciun preț în payload-ul decodat', async () => {
  const result = await run({ items: ONE_ITEM })
  const data = structured(result)
  const u = new URL(data.url)
  const c = u.searchParams.get('c')
  const decoded = decodeCheckoutPayload(/** @type {string} */ (c))
  assert.ok(decoded)
  const raw = JSON.stringify(decoded)
  assert.equal(raw.includes('price'), false, 'a scurs un preț în payload-ul de checkout')
  // CONTROL POZITIV pe conținutul real, nu doar pe absența cuvântului "price":
  assert.deepEqual(decoded?.items, ONE_ITEM)
})

test('URL-ul folosește TATUAT_SITE_URL injectat, nu process.env real', async () => {
  const result = await run({ items: ONE_ITEM }, { ...ENV, TATUAT_SITE_URL: 'https://exemplu-injectat.test' })
  const data = structured(result)
  assert.ok(data.url.startsWith('https://exemplu-injectat.test'))
})

test('annotations NU sunt READ_ONLY_ANNOTATIONS — readOnlyHint și idempotentHint false', () => {
  assert.deepEqual(config.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  })
})

test('fiecare câmp de input și de output are descriere pentru model', () => {
  // O buclă peste un obiect gol trece cu ZERO aserțiuni executate. Dacă vreun refactor învelește
  // schemele într-un `.transform()`/`.pipe()` care pierde `.shape`, testul ar deveni decor tăcut.
  assert.ok(Object.keys(inputSchema.shape).length > 0, 'inputSchema.shape e gol')
  assert.ok(Object.keys(outputSchema.shape).length > 0, 'outputSchema.shape e gol')
  for (const [key, field] of Object.entries(inputSchema.shape)) {
    assert.ok(field.description, `inputSchema.${key} nu are .describe()`)
  }
  for (const [key, field] of Object.entries(outputSchema.shape)) {
    assert.ok(field.description, `outputSchema.${key} nu are .describe()`)
  }
})

test('plafon depășit → isError, fără date parțiale', async () => {
  const handler = createHandler({ env: ENV, limiter: async () => false })
  const result = await handler({ items: ONE_ITEM }, {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
})

test('plafon care permite → succes (CONTROL POZITIV pe același drum, cu limiter prezent)', async () => {
  const handler = createHandler({ env: ENV, limiter: async () => true })
  const result = await handler({ items: ONE_ITEM }, {})
  assert.equal(result.isError, undefined)
  assert.ok(result.structuredContent, 'un limiter care permite nu ar trebui să blocheze cererea')
})

// ─────────── CONTRACT cu site-ul: ce iese de aici trebuie să treacă de validarea de acolo ───────────
//
// 🔴 Defectul, găsit la verificarea încrucișată din 29.09.2026: site-ul validează liniile primite
// prin link în `lib/agent-items.mjs` (MAX_QTY 9999, MAX_OPTIONS 20, cheie 64, valoare 200) și
// respinge ÎN BLOC un coș care încalcă oricare dintre ele — mesajul văzut de client e „Linkul nu a
// putut fi verificat", același pe care l-ar primi la o semnătură falsificată. Aici, în schimb,
// `qty` avea doar `.min(1)` și `options` niciun plafon. Rezultatul: modelul cerea `qty: 100000`,
// primea un link perfect semnat, iar clientul lovea un zid fără explicație și fără drum înapoi.
//
// Refuzul trebuie să vină LA APEL, unde modelul îl citește și poate corecta cantitatea, nu după ce
// linkul a plecat în conversație. Limitele de mai jos sunt OGLINDA celor din site; dacă acolo se
// schimbă, testele de aici trebuie schimbate în aceeași trecere.

/** @param {Record<string, unknown>} [extra] */
const linie = (extra) => ({ items: [{ product_id: 101, variant_id: null, qty: 1, options: {}, ...extra }] })

test('CONTRACT: cantitatea peste plafonul site-ului e respinsă AICI, nu după emiterea linkului', () => {
  assert.equal(inputSchema.safeParse(linie({ qty: MAX_QTY_PER_LINE + 1 })).success, false)
})

test('CONTRACT: exact plafonul de cantitate trece (CONTROL POZITIV pe margine)', () => {
  assert.equal(inputSchema.safeParse(linie({ qty: MAX_QTY_PER_LINE })).success, true)
})

test('CONTRACT: prea multe opțiuni pe o linie → respins', () => {
  const multe = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, 'v']))
  assert.equal(Object.keys(multe).length, 21, 'precondiția testului: chiar 21 de opțiuni')
  assert.equal(inputSchema.safeParse(linie({ options: multe })).success, false)
})

test('CONTRACT: exact 20 de opțiuni trec (CONTROL POZITIV pe margine)', () => {
  const douazeci = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`o${i}`, 'v']))
  assert.equal(inputSchema.safeParse(linie({ options: douazeci })).success, true)
})

test('CONTRACT: cheie de opțiune prea lungă → respinsă', () => {
  assert.equal(inputSchema.safeParse(linie({ options: { ['k'.repeat(65)]: 'v' } })).success, false)
  assert.equal(inputSchema.safeParse(linie({ options: { ['k'.repeat(64)]: 'v' } })).success, true)
})

test('CONTRACT: cheie de opțiune GOALĂ → respinsă (site-ul o refuză, deci n-are ce căuta în link)', () => {
  assert.equal(inputSchema.safeParse(linie({ options: { '': 'v' } })).success, false)
})

test('CONTRACT: valoare de opțiune prea lungă → respinsă', () => {
  assert.equal(inputSchema.safeParse(linie({ options: { culoare: 'v'.repeat(201) } })).success, false)
  assert.equal(inputSchema.safeParse(linie({ options: { culoare: 'v'.repeat(200) } })).success, true)
})

test('CONTRACT: un coș la limitele pe câmpuri produce un link pe care site-ul îl poate citi', async () => {
  // Testele de mai sus opresc ce e prea mare. Ăsta dovedește invers: ce trece de schemă chiar se
  // transformă într-un link citibil, adică n-am strâns limitele sub ce e legitim.
  //
  // 🔑 Coșul de aici e la maximul pe FIECARE CÂMP (20 de linii, cantitate maximă, variantă, cheie
  // și valoare de opțiune la plafon) — dar cu o singură opțiune pe linie, fiindcă mai multe îl duc
  // peste `MAX_LINK_CHARS` și e refuzat deliberat (vezi testele de LIVRABILITATE). Măsurat: 7.248
  // de caractere, adică sub plafonul de 8.000. Cele două teste împreună țin marginea din amândouă
  // părțile: nici prea strâmt cât să taie un coș real, nici atât de larg cât să emită un link mort.
  const handler = createHandler({ env: ENV })
  const optiuni = { ['k'.repeat(MAX_OPTION_KEY)]: 'v'.repeat(MAX_OPTION_VALUE) }
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    product_id: 101 + i, variant_id: 7 + i, qty: MAX_QTY_PER_LINE, options: optiuni,
  }))
  assert.equal(inputSchema.safeParse({ items }).success, true, 'coșul trebuie să treacă de schemă')
  const result = await handler({ items }, {})
  assert.equal(result.isError, undefined, 'coșul de la limitele pe câmpuri nu trebuie să pice la emitere')
  // 🔑 Explicit îNAINTE de `String(... ?? '')`: fără el, un `structuredContent` absent ar deveni `''`,
  // iar eșecul s-ar arăta ca un `TypeError: Invalid URL` — simptom, nu cauză.
  assert.ok(result.structuredContent, 'coșul de la limite nu a produs structuredContent')
  const url = String(result.structuredContent.url ?? '')
  const c = new URL(url).searchParams.get('c')
  assert.ok(c, 'linkul emis nu are parametrul c')
  const payload = decodeCheckoutPayload(c)
  assert.ok(payload, 'payload-ul propriului nostru link nu se decodează')
  assert.equal(payload.items.length, MAX_ITEMS)
  assert.equal(payload.items[0].qty, MAX_QTY_PER_LINE)
  assert.equal(Object.keys(payload.items[0].options)[0].length, MAX_OPTION_KEY)
})

// ─────────── linkul trebuie să încapă într-un URL real, nu doar să fie valid ───────────

test('LIVRABILITATE: un coș care ar produce un link prea lung e refuzat, cu explicație', async () => {
  // Măsurat 29.09.2026: 20 de linii × 20 de opțiuni × 200 de caractere ⇒ un URL de ~113.000 de
  // caractere. Fiecare câmp în parte respectă limitele site-ului, deci validarea de formă îl lasă
  // să treacă — dar URL-ul nu poate ajunge nicăieri: Vercel taie cererile la ~14KB de URL, iar ruta
  // /api/agent-cart a site-ului refuză corpurile peste MAX_BODY (64.000). Clientul ar fi văzut
  // „Linkul nu a putut fi verificat", adică mesajul de la o semnătură falsificată.
  const handler = createHandler({ env: ENV })
  const optiuni = Object.fromEntries(Array.from({ length: MAX_OPTIONS }, (_, i) => [`o${i}`, 'v'.repeat(MAX_OPTION_VALUE)]))
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    product_id: 101 + i, variant_id: null, qty: MAX_QTY_PER_LINE, options: optiuni,
  }))
  const result = await handler({ items }, {})
  assert.equal(result.isError, true, 'un link nelivrabil nu are voie să plece în conversație')
  assert.equal(result.structuredContent, undefined, 'niciun URL parțial')
  const text = result.content.map((c) => c.text).join(' ')
  // Refuzul trebuie să-i spună modelului CE să facă, altfel îl reîncearcă identic.
  assert.match(text, /prea mare|prea lung|împarte|mai puține/i)
})

test('LIVRABILITATE: coșul realist maxim (20 de linii cu variante, fără opțiuni) trece lejer', async () => {
  // CONTROL POZITIV: plafonul nu are voie să taie coșuri pe care clientul chiar le poate avea.
  const handler = createHandler({ env: ENV })
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    product_id: 101 + i, variant_id: 7 + i, qty: 3, options: { marime: '1207RL', culoare: 'negru' },
  }))
  const result = await handler({ items }, {})
  assert.equal(result.isError, undefined)
  // 🔴 FĂRĂ linia asta aserțiunea de mai jos e VACUĂ: `structuredContent` absent → `''` → lungime 0,
  // care e mereu sub plafon. Testul ar fi trecut și dacă tool-ul n-ar fi întors niciun link. `isError`
  // nu acoperă gaura — un rezultat care ocolește `okResult` n-are NICI `isError`, NICI `structuredContent`.
  assert.ok(result.structuredContent, 'coșul realist nu a produs structuredContent')
  assert.ok(
    String(result.structuredContent.url ?? '').length < MAX_LINK_CHARS,
    'coșul realist trebuie să rămână mult sub plafon',
  )
})

test('LIVRABILITATE: plafonul e sub ce acceptă ruta site-ului, nu peste', () => {
  // MAX_BODY din tatuat-site/app/api/agent-cart/route.ts. Dacă plafonul de aici l-ar depăși, am fi
  // mutat pur și simplu refuzul de la MCP la site — tot fără explicație pentru client.
  const MAX_BODY_SITE = 64_000
  assert.ok(MAX_LINK_CHARS < MAX_BODY_SITE, `${MAX_LINK_CHARS} trebuie să fie sub ${MAX_BODY_SITE}`)
  // Și sub limita de URL a platformei (~14KB pe Vercel), altfel cererea nici nu ajunge la rută.
  assert.ok(MAX_LINK_CHARS < 14_000, `${MAX_LINK_CHARS} trebuie să fie sub limita de URL a platformei`)
})
