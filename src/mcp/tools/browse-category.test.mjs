/**
 * Teste pentru `browse_category`.
 *
 * ⚠️ Testul central de sortare ar trece și dacă stub-ul de fetch n-ar fi apelat
 * niciodată, sau dacă payload-ul ar fi citit greșit. De aceea fiecare astfel de
 * verificare stă lângă un CONTROL POZITIV pe același apel: `p_limit`/`p_offset`
 * TREBUIE să fie prezenți. Un stub rupt cade pe control, nu trece tăcut.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createHandler,
  inputSchema,
  outputSchema,
  config,
  MAX_LIMIT,
} from './browse-category.mjs'
import { CATEGORY_SORTS, DEFAULT_CATEGORY_SORT } from '../catalog.mjs'

/** Mediu fals. Valori inventate — nicio cheie reală în teste. */
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key-not-real',
  TATUAT_SITE_URL: 'https://tatuat.ro',
}

/** Un rând de card, ca cel întors de RPC-ul cu `select`. */
const ROW = {
  id: 101,
  slug: 'ace-cartus-0-30-rl',
  name: 'Ace cartuș 0.30 RL',
  price: 40,
  sale_price: null,
  on_sale: false,
  in_stock: true,
  stock_qty: 12,
  primary_image: 'img.webp',
  variant_count: 3,
  brand_id: 7,
}

/**
 * Stub de fetch care înregistrează fiecare apel și răspunde pe rută.
 * @param {{ rpc?: unknown, brands?: unknown, rpcStatus?: number }} [plan]
 */
function makeFetch(plan = {}) {
  /** @type {{ url: string, method: string, body: unknown }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const impl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    let body = null
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    calls.push({ url: href, method, body })

    if (href.includes('/rpc/products_in_category')) {
      const status = plan.rpcStatus ?? 200
      return new Response(JSON.stringify(plan.rpc ?? [ROW]), {
        status,
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
 * @param {{ category_id?: number | null, sort?: string, limit?: number, offset?: number }} args
 * @param {{ rpc?: unknown, brands?: unknown, rpcStatus?: number }} [plan]
 */
function run(args, plan) {
  const { impl, calls } = makeFetch(plan)
  const handler = createHandler({ env: ENV, fetchImpl: impl })
  return handler(args, {}).then((result) => ({ result, calls }))
}

/**
 * Payload-ul RPC al unui apel înregistrat, cu verificarea că apelul a avut loc.
 * @param {{ url: string, method: string, body: unknown }[]} calls
 * @param {string} fragment
 */
function callTo(calls, fragment) {
  const found = calls.find((c) => c.url.includes(fragment))
  assert.ok(found, `nu s-a făcut niciun apel către ${fragment}`)
  return { ...found, body: /** @type {Record<string, unknown>} */ (found.body) }
}

/**
 * `structuredContent` trecut prin `outputSchema`, nu printr-un cast.
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

for (const sort of CATEGORY_SORTS) {
  test(`sortarea „${sort}" ajunge la RPC ca p_sort cu numele CORECT (cu control pozitiv)`, async () => {
    const { calls } = await run({ category_id: 5, sort, limit: 3, offset: 0 })
    const rpcCall = callTo(calls, '/rpc/products_in_category')
    // CONTROL POZITIV — dacă astea cad, stub-ul sau extragerea e ruptă, nu sortarea.
    assert.equal(rpcCall.method, 'POST')
    assert.equal(rpcCall.body.p_category_id, 5)
    assert.equal(rpcCall.body.p_limit, 3)
    // Verificarea propriu-zisă: o valoare ghicită (ex. `price_asc`) ar ajunge la RPC
    // ca string valid și ar produce o sortare greșită tăcut, nu o eroare.
    assert.equal(rpcCall.body.p_sort, sort)
  })
}

test('sortul implicit e "for_you" cand nu se trimite sort (cu control pozitiv pe p_limit)', async () => {
  const { calls } = await run({})
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  assert.equal(rpcCall.body.p_limit, 10, 'defaultul de limit nu s-a aplicat')
  assert.equal(rpcCall.body.p_sort, DEFAULT_CATEGORY_SORT)
})

test('category_id implicit (null) → tot catalogul: p_category_id NU apare (cu control pozitiv pe p_sort)', async () => {
  const { calls } = await run({})
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  assert.equal(rpcCall.body.p_sort, DEFAULT_CATEGORY_SORT, 'controlul pozitiv a picat')
  assert.equal(
    Object.hasOwn(rpcCall.body, 'p_category_id'),
    false,
    'p_category_id a apărut cu category_id=null — nu mai e "tot catalogul"',
  )
})

test('category_id numeric ajunge exact ca p_category_id', async () => {
  const { calls } = await run({ category_id: 42 })
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  assert.equal(rpcCall.body.p_category_id, 42)
})

test('offset ajunge exact ca p_offset (cu control pozitiv pe p_limit)', async () => {
  const { calls } = await run({ limit: 5, offset: 15 })
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  assert.equal(rpcCall.body.p_limit, 5, 'controlul pozitiv a picat')
  assert.equal(rpcCall.body.p_offset, 15)
})

test('gate RO-only: p_lang NU apare în payload-ul RPC (cu control pozitiv)', async () => {
  const { calls } = await run({ category_id: 5 })
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  // CONTROL POZITIV.
  assert.equal(rpcCall.body.p_category_id, 5)
  // Verificarea propriu-zisă.
  assert.equal(
    Object.hasOwn(rpcCall.body, 'p_lang'),
    false,
    'p_lang a ajuns în payload — produsele doar-HU ar deveni vizibile în ChatGPT',
  )
})

test('proiecția de coloane e trimisă ca select pe rezultatul RPC', async () => {
  const { calls } = await run({})
  const rpcCall = callTo(calls, '/rpc/products_in_category')
  assert.ok(rpcCall.url.includes('select='), 'lipsește select= → răspuns mult mai mare decât e nevoie')
  const decoded = decodeURIComponent(rpcCall.url)
  assert.ok(decoded.includes('slug'), 'select-ul nu cere slug-ul')
  assert.equal(decoded.includes('search_tsv'), false, 'select-ul cere coloane inutile')
})

test('structuredContent respectă outputSchema declarat, cu meta de categorie/sortare/offset', async () => {
  // offset NEZERO deliberat: cu offset: 0 (valoarea implicită) un handler care ar
  // hardcoda `offset: 0` în ieșire — în loc să repete argumentul primit — ar trece
  // acest test la fel de „verde" ca implementarea corectă. Măsurat: cu mutația
  // `offset: 0` hardcodată în handler, testul vechi (offset: 0 aici) rămânea GREEN.
  const { result } = await run({ category_id: 5, sort: 'popular', offset: 7 })
  assert.equal(result.isError, undefined)
  const data = structured(result)
  assert.equal(data.category_id, 5)
  assert.equal(data.sort, 'popular')
  assert.equal(data.offset, 7, 'offset-ul cerut nu a fost reflectat în ieșire (posibil hardcodat)')
  assert.equal(data.count, 1)
  assert.equal(data.products[0].product_id, 101)
})

test('URL-ul de produs folosește prefixul /product/, ca în magazin', async () => {
  const { result } = await run({})
  assert.equal(structured(result).products[0].url, 'https://tatuat.ro/product/ace-cartus-0-30-rl')
})

test('brand_id devine nume de brand', async () => {
  const { result } = await run({})
  assert.equal(structured(result).products[0].brand, 'Tatuat Pro')
})

test('brand necunoscut → null, nu id scurs în răspuns', async () => {
  const { result } = await run({}, { brands: [] })
  assert.equal(structured(result).products[0].brand, null)
  // Pe obiectul BRUT, nu pe cel validat: zod ar fi aruncat singur `brand_id`.
  assert.equal(JSON.stringify(result.structuredContent).includes('brand_id'), false)
})

test('reducere reală → price + price_before; fără reducere → price_before null', async () => {
  const { result: onSale } = await run({}, { rpc: [{ ...ROW, price: 40, sale_price: 30 }] })
  assert.equal(structured(onSale).products[0].price, 30)
  assert.equal(structured(onSale).products[0].price_before, 40)

  const { result: plain } = await run({})
  assert.equal(structured(plain).products[0].price, 40)
  assert.equal(structured(plain).products[0].price_before, null)
})

test('moneda e etichetată RON în fiecare card', async () => {
  const { result } = await run({})
  assert.equal(structured(result).products[0].currency, 'RON')
})

test('zero produse în categorie: răspuns valid, nu eroare', async () => {
  const { result } = await run({ category_id: 999 }, { rpc: [] })
  assert.equal(result.isError, undefined)
  const data = structured(result)
  assert.equal(data.count, 0)
  assert.deepEqual(data.products, [])
  assert.equal(data.category_id, 999)
})

test('PostgREST 500 → isError, fără structuredContent și fără detalii interne', async () => {
  const { result } = await run({}, { rpcStatus: 500 })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('supabase'), false, 'a scurs hostul intern')
  assert.equal(text.includes('500'), false, 'a scurs statusul HTTP brut')
  assert.ok(text.includes('tatuat.ro'))
})

test('plafon de rate limiting depășit → isError, fără date parțiale', async () => {
  const { impl } = makeFetch()
  const denyingHandler = createHandler({ env: ENV, fetchImpl: impl, limiter: async () => false })
  const denied = await denyingHandler({}, {})
  assert.equal(denied.isError, true, 'plafonul depășit nu a produs isError')
  assert.equal(denied.structuredContent, undefined)
})

// CONTROL POZITIV, test() SEPARAT: dacă ar fi în același test() ca cel de mai sus,
// un handler care ar respinge TOT ar cădea pe primul assert și verdictul combinat
// n-ar mai arăta care jumătate a picat — exact ce cere regula 4 să se evite.
test('plafon de rate limiting cu limiter permisiv → cererea identică trece (control pozitiv)', async () => {
  const { impl } = makeFetch()
  const allowingHandler = createHandler({ env: ENV, fetchImpl: impl, limiter: async () => true })
  const allowed = await allowingHandler({}, {})
  assert.equal(allowed.isError, undefined, 'controlul pozitiv a picat — limiter permisiv respinge tot')
})

test('plafonul se cheie pe sesiune, nu global', async () => {
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
  await handler({}, { sessionId: 'sess-1' })
  await handler({}, { sessionId: 'sess-2' })
  assert.deepEqual(keys, ['browse_category:sess-1', 'browse_category:sess-2'])
})

test('inputSchema respinge limit peste plafon, offset negativ și sort inexistent; acceptă lipsa tuturor', () => {
  assert.equal(inputSchema.safeParse({ limit: MAX_LIMIT + 1 }).success, false)
  assert.equal(inputSchema.safeParse({ limit: 0 }).success, false)
  assert.equal(inputSchema.safeParse({ offset: -1 }).success, false)
  assert.equal(inputSchema.safeParse({ sort: 'price_asc' }).success, false, 'sort inexistent a fost acceptat')
  const parsed = inputSchema.safeParse({})
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.limit, 10, 'defaultul de limit nu s-a aplicat')
  assert.equal(parsed.data.offset, 0, 'defaultul de offset nu s-a aplicat')
  assert.equal(parsed.data.sort, DEFAULT_CATEGORY_SORT, 'defaultul de sort nu s-a aplicat')
  assert.equal(parsed.data.category_id, null, 'defaultul de category_id nu s-a aplicat')
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
