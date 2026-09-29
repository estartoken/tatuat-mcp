/**
 * Teste pentru politica de conținut a canalului ChatGPT.
 *
 * 🔴 CONTROLUL POZITIV NU E OPȚIONAL AICI. Un filtru care ar exclude TOT ar
 * trece fiecare test de excludere din acest fișier. Deci fiecare afirmație de
 * excludere stă lângă una care cere TRECEREA unui produs legitim — și în special
 * lângă familia „Biotat Numbing", a cărei descriere conține LITERAL
 * „Este 100% fara lidocaina. COMPLET NATURAL". Un detector pe cuvinte ar
 * clasifica drept risc exact produsele care neagă riscul; testele de mai jos
 * cad dacă cineva înlocuiește lista măsurată cu o euristică pe text.
 *
 * Ultima secțiune testează CABLAJUL, nu constanta: o listă corectă care nu e
 * conectată la citirile de catalog e un fix fals. Acolo se stubuiește `fetch` și
 * se verifică ce iese efectiv din `searchProducts`/`categoryProducts`/
 * `productsForShipping`/`productBySlug`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXCLUDED_PRODUCTS,
  EXCLUDED_PRODUCT_IDS,
  isAllowedProductId,
  isAllowedProduct,
  filterAllowedProducts,
  allowedProductOrNull,
} from './policy.mjs'

import {
  searchProducts,
  categoryProducts,
  productsForShipping,
  productBySlug,
  productVariants,
} from './catalog.mjs'

// Cablajul lui `create_checkout` se verifică pe handlerul REAL, nu pe o copie a
// logicii: e singurul tool care nu atinge catalogul, deci singurul loc unde
// politica trebuie aplicată pe `product_id` venit DE LA MODEL.
import { createHandler as createCheckoutHandler } from './tools/create-checkout.mjs'
import { AGENT_CART_PATH } from './checkout-link.mjs'

/** Exact cele două chei pe care `credentials()` le cere; altfel `requireEnv` aruncă. */
const STUB_ENV = {
  SUPABASE_URL: 'https://stub.invalid',
  SUPABASE_ANON_KEY: 'stub-anon-key-not-real',
}

/** Cele trei id-uri „Biotat Numbing" citate nominal în măsurătoare. */
const BIOTAT_FARA_LIDOCAINA = [6593, 6825, 8416]

// ─────────────────────────────────────────────────────────────────────────────
// Lista în sine
// ─────────────────────────────────────────────────────────────────────────────

test('lista are EXACT cele 7 id-uri măsurate, niciunul în plus', () => {
  assert.deepEqual(
    EXCLUDED_PRODUCTS.map((p) => p.id).sort((a, b) => a - b),
    [1455, 1840, 2971, 4605, 4606, 8002, 1506762],
    'lista de excludere a fost modificată — politica de conținut e decizia ownerului',
  )
  assert.equal(EXCLUDED_PRODUCT_IDS.size, 7, 'id-uri duplicate în listă')
})

test('fiecare intrare poartă nume și motiv, ca owner-ul să poată revizui lista', () => {
  for (const p of EXCLUDED_PRODUCTS) {
    assert.ok(p.name.length > 0, `id ${p.id}: fără nume`)
    assert.ok(p.why.length > 0, `id ${p.id}: fără motiv măsurat`)
  }
})

for (const p of EXCLUDED_PRODUCTS) {
  test(`exclus nominal: ${p.id} — ${p.name}`, () => {
    assert.equal(isAllowedProductId(p.id), false, `${p.name} nu e exclus din canal`)
    assert.equal(isAllowedProduct({ id: p.id, slug: 'x' }), false)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROALE POZITIVE — fără ele, un filtru care refuză tot ar trece testele de sus
// ─────────────────────────────────────────────────────────────────────────────

for (const id of BIOTAT_FARA_LIDOCAINA) {
  test(`CONTROL POZITIV: Biotat Numbing ${id} TRECE (textul lui neagă lidocaina)`, () => {
    assert.equal(
      isAllowedProductId(id),
      true,
      'un detector pe cuvântul „lidocaina" a exclus un produs care declară că NU conține lidocaină',
    )
  })
}

test('CONTROL POZITIV: un produs obișnuit de tatuaj trece', () => {
  assert.equal(isAllowedProduct({ id: 4242, slug: 'ace-rotative-0-35' }), true)
})

test('CONTROL POZITIV: id-uri vecine celor excluse trec (nu se exclude un interval)', () => {
  for (const id of [1454, 1456, 1839, 1841, 8001, 8003, 1506761, 1506763]) {
    assert.equal(isAllowedProductId(id), true, `id ${id} a fost exclus fără să fie pe listă`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed pe id nedeterminabil
// ─────────────────────────────────────────────────────────────────────────────

test('fail-closed: id care nu e întreg pozitiv nu trece', () => {
  for (const bad of [undefined, null, '1455', '4242', NaN, Infinity, 0, -1, 1.5, {}, [], true]) {
    assert.equal(isAllowedProductId(bad), false, `${JSON.stringify(bad) ?? String(bad)} a trecut ca id valid`)
  }
})

test('fail-closed: un rând care nu e obiect cu id nu trece', () => {
  for (const bad of [null, undefined, 'produs', 42, [], [{ id: 4242 }], {}, { slug: 'x' }]) {
    assert.equal(isAllowedProduct(bad), false, `${JSON.stringify(bad) ?? String(bad)} a trecut ca rând de produs`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Helperii de listă
// ─────────────────────────────────────────────────────────────────────────────

test('filterAllowedProducts scoate exclusele și PĂSTREAZĂ ORDINEA celorlalte', () => {
  const rows = [
    { id: 4242, slug: 'a' },
    { id: 1455, slug: 'tattoo-soothe-10g' },
    { id: 6593, slug: 'biotat-numbing' },
    { id: 8002, slug: 'recovery-numbing' },
    { id: 9001, slug: 'z' },
  ]
  assert.deepEqual(
    filterAllowedProducts(rows).map((r) => r.slug),
    ['a', 'biotat-numbing', 'z'],
  )
})

test('filterAllowedProducts pe listă goală întoarce listă goală, nu aruncă', () => {
  assert.deepEqual(filterAllowedProducts([]), [])
})

test('allowedProductOrNull: exclus → null, permis → chiar rândul, null → null', () => {
  const ok = { id: 4242, slug: 'ace-rotative-0-35' }
  assert.equal(allowedProductOrNull({ id: 1840, slug: 'bactine-150ml' }), null)
  assert.equal(allowedProductOrNull(ok), ok)
  assert.equal(allowedProductOrNull(null), null)
})

// ─────────────────────────────────────────────────────────────────────────────
// CABLAJ — o listă corectă necablată e un fix fals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `fetch` fals care întoarce ACELEAȘI rânduri la orice cerere.
 * `rpc` nu validează forma, `select` da — un array de obiecte satisface ambele.
 * @param {Record<string, unknown>[]} rows
 */
function makeStub(rows) {
  /** @type {string[]} */
  const urls = []
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {unknown} */ url) => {
        urls.push(String(url))
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) }
      }
    )
  )
  return { urls, opts: { env: STUB_ENV, fetchImpl } }
}

/** Un exclus, un „fals pozitiv" care trebuie să treacă, și un produs obișnuit. */
const MIXED_ROWS = [
  { id: 1455, slug: 'tattoo-soothe-10g', price: 100 },
  { id: 6593, slug: 'biotat-numbing-caps', price: 90 },
  { id: 4242, slug: 'ace-rotative-0-35', price: 20 },
]

test('CABLAJ searchProducts: produsul exclus nu ajunge la model', async () => {
  const { opts } = makeStub(MIXED_ROWS)
  const rows = await searchProducts({ query: 'crema', limit: 10 }, opts)
  assert.deepEqual(
    rows.map((r) => r.id),
    [6593, 4242],
    'searchProducts a întors un produs exclus din canalul ChatGPT',
  )
})

test('CABLAJ categoryProducts: produsul exclus nu apare în categorie', async () => {
  const { opts } = makeStub(MIXED_ROWS)
  const rows = await categoryProducts({ categoryId: 7, sort: 'popular', limit: 10, offset: 0 }, opts)
  assert.deepEqual(
    rows.map((r) => r.id),
    [6593, 4242],
    'categoryProducts a întors un produs exclus din canalul ChatGPT',
  )
})

test('CABLAJ productsForShipping: linia cu produs exclus nu primește preț', async () => {
  const { opts } = makeStub(MIXED_ROWS)
  const rows = await productsForShipping({ slugs: ['tattoo-soothe-10g', 'ace-rotative-0-35'], ids: [] }, opts)
  assert.deepEqual(
    rows.map((r) => r.id),
    [6593, 4242],
    'productsForShipping a întors un produs exclus — calculul de transport l-ar fi confirmat ca vandabil',
  )
})

test('CABLAJ productBySlug: fișa unui produs exclus e null, ca la produs inexistent', async () => {
  const { opts } = makeStub([{ id: 1455, slug: 'tattoo-soothe-10g', price: 100 }])
  assert.equal(
    await productBySlug('tattoo-soothe-10g', opts),
    null,
    'get_product a servit fișa unui produs exclus prin link direct',
  )
})

test('CONTROL POZITIV CABLAJ: productBySlug servește un produs permis', async () => {
  const { opts } = makeStub([{ id: 4242, slug: 'ace-rotative-0-35', price: 20 }])
  const row = await productBySlug('ace-rotative-0-35', opts)
  assert.equal(row?.id, 4242, 'filtrul a înghițit un produs legitim')
})

test('CONTROL POZITIV CABLAJ: productBySlug servește un Biotat „fara lidocaina"', async () => {
  const { opts } = makeStub([{ id: 6593, slug: 'biotat-numbing-caps', price: 90 }])
  const row = await productBySlug('biotat-numbing-caps', opts)
  assert.equal(row?.id, 6593)
})

test('CABLAJ: productVariants NU e filtrat — acolo `id` e id de VARIANTĂ', async () => {
  // Spațiile de id-uri sunt distincte: o variantă cu id 1455 nu are nicio
  // legătură cu produsul 1455. Un filtru aplicat uniform pe „row.id" ar șterge
  // tăcut variante legitime, iar simptomul (o variantă lipsă) nu s-ar vedea
  // în niciun test de politică. De aceea cablajul e per-cale, nu global.
  const { opts } = makeStub([
    { id: 1455, product_id: 4242, name: '0.35 RL' },
    { id: 8002, product_id: 4242, name: '0.30 RL' },
  ])
  const rows = await productVariants(4242, opts)
  assert.deepEqual(
    rows.map((r) => r.id),
    [1455, 8002],
    'variantele au fost filtrate cu lista de produse — id-urile au referenți diferiți',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// CABLAJ `create_checkout` — singurul tool care NU citește catalogul.
//
// 🔴 De ce e o secțiune separată: filtrul din `catalog.mjs` acoperă exact căile
// care CITESC produse. `create_checkout` nu citește nimic — primește
// `product_id` direct de la model și îl semnează. Regula OpenAI e verbatim
// „enforce authorization in the MCP server for every request; never rely on the
// model to decide whether a user has access", deci un produs exclus scris de
// model în argumente trebuie respins AICI, nu presupus filtrat mai jos.
//
// Refuzul trebuie să fie ÎNTREG, nu un link cu linia lipsă: un coș tăcut
// incomplet ar duce clientul pe tatuat.ro cu altceva decât ce i s-a confirmat în
// conversație, iar simptomul nu s-ar vedea nici în UI, nici în teste.
// ─────────────────────────────────────────────────────────────────────────────

/** Mediu fals. Secret inventat — nicio valoare reală în teste. */
const CHECKOUT_ENV = {
  AGENT_CHECKOUT_SECRET: 'stub-secret-not-real-0123456789',
  TATUAT_SITE_URL: 'https://tatuat.ro',
}

/** Handler real: fără rețea, fără limiter, `now` fix ⇒ `exp` determinist. */
function checkoutHandler() {
  return createCheckoutHandler({ env: CHECKOUT_ENV, now: () => 1_700_000_000_000 })
}

const LEGIT_ITEM = { product_id: 4242, variant_id: null, qty: 1, options: {} }
const EXCLUDED_ITEM = { product_id: 1455, variant_id: null, qty: 1, options: {} }

test('CABLAJ create_checkout: un produs exclus nu ajunge în linkul semnat', async () => {
  const res = await checkoutHandler()({ items: [EXCLUDED_ITEM] })
  assert.equal(res.isError, true, 'un produs exclus a produs un link de checkout valid')
  assert.equal(res.structuredContent, undefined, 'răspunsul de refuz poartă totuși date de link')
  const text = res.content[0]?.text ?? ''
  assert.ok(text.includes('1455'), `refuzul nu spune care linie e problema: ${text}`)
})

test('CONTROL POZITIV create_checkout: un coș legitim primește link', async () => {
  const res = await checkoutHandler()({ items: [LEGIT_ITEM] })
  assert.notEqual(res.isError, true, `un coș legitim a fost refuzat: ${res.content[0]?.text}`)
  const url = String(res.structuredContent?.url ?? '')
  assert.ok(url.startsWith(`https://tatuat.ro${AGENT_CART_PATH}?`), `link neașteptat: ${url}`)
})

test('CABLAJ create_checkout: coș MIXT → refuz întreg, nu link parțial', async () => {
  const res = await checkoutHandler()({ items: [LEGIT_ITEM, EXCLUDED_ITEM] })
  assert.equal(res.isError, true, 'coșul mixt a produs un link')
  const url = String(res.structuredContent?.url ?? '')
  assert.equal(url, '', 'a fost emis un link parțial, cu linia exclusă omisă tăcut')
})
