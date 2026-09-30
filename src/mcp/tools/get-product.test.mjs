/**
 * Teste pentru `get_product`.
 *
 * Decizie de semantică, documentată aici fiindcă nu e evidentă din nume:
 * slug inexistent → `found: false, product: null`, `isError` ABSENT. Motiv:
 * un slug care nu (mai) corespunde unui produs activ e o stare normală a
 * catalogului (produs retras, link vechi), nu o defecțiune a serverului —
 * exact ca „zero potriviri” la `search_products`, care e tot răspuns valid,
 * nu eroare. `isError` rămâne rezervat pentru „nu pot confirma” (PostgREST
 * jos, plafon depășit), nu pentru „am confirmat că nu există”.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandler, inputSchema, outputSchema, config } from './get-product.mjs'

/** Mediu fals. Valori inventate — nicio cheie reală în teste. */
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key-not-real',
  TATUAT_SITE_URL: 'https://tatuat.ro',
}

/** Rândul de fișă, ca cel întors de `v_products_with_pricing` (DETAIL_SELECT). */
const DETAIL_ROW = {
  id: 101,
  slug: 'ace-cartus-0-30-rl',
  name: 'Ace cartuș 0.30 RL',
  description: 'Ace cartuș de calitate, sterilizate individual, pentru linework fin.',
  price: 40,
  sale_price: null,
  on_sale: false,
  sale_start: null,
  sale_end: null,
  from_price: null,
  from_price_max: null,
  in_stock: true,
  stock_qty: 12,
  primary_image: 'img.webp',
  variant_count: 2,
  brand_id: 7,
  sku: 'ACE-030-RL',
  weight_g: 15,
  model: null,
}

/** Rânduri de variante, ca cele întoarse de `product_variants`. */
const VARIANT_ROWS = [
  { id: 1, name: 'Cutie 20 buc', sku: 'ACE-030-RL-20', price: 40, sale_price: null, stock_qty: 12, is_default: true },
  { id: 2, name: 'Cutie 50 buc', sku: 'ACE-030-RL-50', price: 90, sale_price: 80, stock_qty: 0, is_default: false },
]

/**
 * Stub de fetch care înregistrează fiecare apel și răspunde pe rută.
 * @param {{ detail?: unknown, detailStatus?: number, variants?: unknown, brands?: unknown }} [plan]
 */
function makeFetch(plan = {}) {
  /** @type {{ url: string, method: string }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const impl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    calls.push({ url: href, method })

    if (href.includes('/v_products_with_pricing')) {
      const status = plan.detailStatus ?? 200
      const body = plan.detail ?? [DETAIL_ROW]
      return new Response(JSON.stringify(status === 200 ? body : { message: 'boom' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (href.includes('/product_variants')) {
      return new Response(JSON.stringify(plan.variants ?? VARIANT_ROWS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (href.includes('/brands')) {
      return new Response(JSON.stringify(plan.brands ?? [{ id: 7, name: 'Tatuat Pro' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Rută neașteptată în test: ${href}`)
  }
  return { impl, calls }
}

/**
 * @param {{ slug: string }} args
 * @param {{ detail?: unknown, detailStatus?: number, variants?: unknown, brands?: unknown }} [plan]
 */
function run(args, plan) {
  const { impl, calls } = makeFetch(plan)
  const handler = createHandler({ env: ENV, fetchImpl: impl })
  return handler(args, {}).then((result) => ({ result, calls }))
}

/**
 * `structuredContent` trecut prin `outputSchema`, nu printr-un cast — vezi
 * search-products.test.mjs pentru raționamentul complet.
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

/**
 * Ca `structured(result).product`, dar afirmă (runtime ȘI la tip) că produsul
 * nu e null — pentru testele care presupun un slug găsit. Testul de slug
 * inexistent verifică el însuși `product === null`, deci nu trece prin asta.
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function foundProduct(result) {
  const { product } = structured(result)
  assert.ok(product, 'testul presupune un produs găsit')
  return product
}

test('CONTROL POZITIV: slug existent → found true, forma respectă outputSchema', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  assert.equal(result.isError, undefined)
  const data = structured(result)
  assert.equal(data.found, true)
  assert.ok(data.product)
  assert.equal(data.product.product_id, 101)
  assert.equal(data.product.slug, 'ace-cartus-0-30-rl')
  assert.equal(data.product.name, 'Ace cartuș 0.30 RL')
})

test('slug inexistent → found false, product null, NU e eroare', async () => {
  const { result, calls } = await run({ slug: 'nu-exista' }, { detail: [] })
  assert.equal(result.isError, undefined, 'slug inexistent nu e o eroare a serverului')
  const data = structured(result)
  assert.equal(data.found, false)
  assert.equal(data.product, null)
  // Eficiență: fără produs, nu are sens să cerem variante sau branduri.
  assert.equal(
    calls.some((c) => c.url.includes('/product_variants') || c.url.includes('/brands')),
    false,
    'a cerut variante/branduri pentru un produs care nu există',
  )
})

test('URL-ul produsului folosește prefixul /product/, ca în magazin', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  assert.equal(foundProduct(result).url, 'https://tatuat.ro/product/ace-cartus-0-30-rl')
})

test('brand_id devine nume de brand', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  assert.equal(foundProduct(result).brand, 'Tatuat Pro')
})

test('brand necunoscut → null, nu id scurs în răspuns', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' }, { brands: [] })
  assert.equal(foundProduct(result).brand, null)
  // Pe obiectul BRUT, nu pe cel validat: zod ar fi aruncat singur `brand_id`.
  assert.equal(JSON.stringify(result.structuredContent).includes('brand_id'), false)
})

test('reducere reală → price + price_before', async () => {
  const { result } = await run(
    { slug: 'ace-cartus-0-30-rl' },
    { detail: [{ ...DETAIL_ROW, price: 40, sale_price: 30 }] },
  )
  const product = foundProduct(result)
  assert.equal(product.price, 30)
  assert.equal(product.price_before, 40)
})

test('fără reducere → price_before null (control pentru testul de reducere)', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  const product = foundProduct(result)
  assert.equal(product.price, 40)
  assert.equal(product.price_before, null)
})

test('sale_price egal cu price NU se raportează ca reducere', async () => {
  const { result } = await run(
    { slug: 'ace-cartus-0-30-rl' },
    { detail: [{ ...DETAIL_ROW, price: 40, sale_price: 40 }] },
  )
  const product = foundProduct(result)
  assert.equal(product.price, 40)
  assert.equal(product.price_before, null)
})

test('descriere lungă e trunchiată la graniță de cuvânt', async () => {
  const long = 'cuvant '.repeat(120).trim() // mult peste 500 caractere
  const { result } = await run(
    { slug: 'ace-cartus-0-30-rl' },
    { detail: [{ ...DETAIL_ROW, description: long }] },
  )
  const description = foundProduct(result).description
  assert.ok(description.length <= 501, 'descrierea nu a fost trunchiată')
  assert.ok(description.endsWith('…'))
  assert.equal(description.includes(' cuv…'), false, 'a spart un cuvânt în mijloc')
})

test('descriere scurtă rămâne neschimbată (control pentru trunchiere)', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  assert.equal(
    foundProduct(result).description,
    'Ace cartuș de calitate, sterilizate individual, pentru linework fin.',
  )
})

test('varianta implicită (is_default) e marcată; cealaltă nu', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  const variants = foundProduct(result).variants
  assert.equal(variants.length, 2)
  const [first, second] = variants
  assert.equal(first.is_default, true)
  assert.equal(second.is_default, false)
})

test('variantele au preț și stoc propriu, independent de produsul-mamă', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' })
  const variants = foundProduct(result).variants
  assert.equal(variants[0].price, 40)
  assert.equal(variants[0].in_stock, true)
  // A doua variantă are reducere reală (90 → 80) și stoc epuizat (0).
  assert.equal(variants[1].price, 80)
  assert.equal(variants[1].in_stock, false)
})

test('produs fără variante → variants: [] (control pentru cazul cu variante)', async () => {
  const { result } = await run(
    { slug: 'ace-cartus-0-30-rl' },
    { detail: [{ ...DETAIL_ROW, variant_count: 0 }], variants: [] },
  )
  assert.deepEqual(foundProduct(result).variants, [])
})

test('eroare PostgREST pe fișă → isError, fără structuredContent și fără detalii interne', async () => {
  const { result } = await run({ slug: 'ace-cartus-0-30-rl' }, { detailStatus: 500 })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('supabase'), false, 'a scurs hostul intern')
  assert.equal(text.includes('500'), false, 'a scurs statusul HTTP brut')
})

test('plafon depășit → isError, fără date parțiale', async () => {
  const { impl } = makeFetch()
  const handler = createHandler({ env: ENV, fetchImpl: impl, limiter: async () => false })
  const result = await handler({ slug: 'ace-cartus-0-30-rl' }, {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
})

test('plafonul se cheie pe sesiune, nu global (control: ambele sesiuni trec)', async () => {
  /** @type {string[]} */
  const keys = []
  const { impl } = makeFetch()
  const handler = createHandler({
    env: ENV,
    fetchImpl: impl,
    limiter: async (key) => {
      keys.push(key)
      return true
    },
  })
  const a = await handler({ slug: 'ace-cartus-0-30-rl' }, { sessionId: 'sess-1' })
  const b = await handler({ slug: 'ace-cartus-0-30-rl' }, { sessionId: 'sess-2' })
  assert.equal(a.isError, undefined)
  assert.equal(b.isError, undefined)
  assert.deepEqual(keys, ['get_product:sess-1', 'get_product:sess-2'])
})

test('inputSchema respinge slug gol și acceptă un slug valid', () => {
  assert.equal(inputSchema.safeParse({ slug: '' }).success, false)
  assert.equal(inputSchema.safeParse({ slug: 'ace-cartus-0-30-rl' }).success, true)
})

test('annotations declară toate cele patru câmpuri, niciunul permisiv greșit', () => {
  assert.deepEqual(config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
})

test('fiecare câmp de input și de output are descriere pentru model', () => {
  for (const [key, field] of Object.entries(inputSchema.shape)) {
    assert.ok(field.description, `inputSchema.${key} nu are .describe()`)
  }
  for (const [key, field] of Object.entries(outputSchema.shape)) {
    assert.ok(field.description, `outputSchema.${key} nu are .describe()`)
  }
})

// ---------------------------------------------------------------------------
// Restricția „doar Ungaria" pe fișa de produs (01.10.2026). Vezi policy.mjs
// pentru DE CE se anunță în loc să se ascundă.
// ---------------------------------------------------------------------------

test('fișa unui produs lang="hu" declară restricția, fără să ascundă produsul', async () => {
  const { result } = await run({ slug: 'produs-sintetic-doar-hu' }, { detail: [{ ...DETAIL_ROW, lang: 'hu' }] })
  const out = structured(result)
  assert.equal(out.found, true, 'produsul nu trebuie ascuns — e cumpărabil din Ungaria')
  assert.equal(out.order_restriction, 'hu_only')
  assert.ok(/Ungaria/.test(result.content.map((c) => c.text).join(' ')))
})

test('CONTROL NEGATIV: fișa unui produs RO nu declară nicio restricție', async () => {
  const { result } = await run({ slug: DETAIL_ROW.slug }, { detail: [{ ...DETAIL_ROW, lang: null }] })
  const out = structured(result)
  assert.equal(out.order_restriction, null)
  assert.ok(!/Ungaria/.test(result.content.map((c) => c.text).join(' ')))
})

test('slug inexistent: order_restriction e null, nu absent — outputSchema o cere', async () => {
  const { result } = await run({ slug: 'nu-exista' }, { detail: [] })
  const out = structured(result)
  assert.equal(out.found, false)
  assert.equal(out.order_restriction, null)
})
