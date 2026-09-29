/**
 * Teste pentru `search_products` — și pentru controalele care apără gate-ul RO-only.
 *
 * ⚠️ Testul central („`p_lang` nu se trimite") ar trece și dacă stub-ul de fetch
 * n-ar fi apelat niciodată, sau dacă payload-ul ar fi citit greșit. De aceea
 * fiecare astfel de verificare stă lângă un CONTROL POZITIV pe același obiect:
 * `p_query` TREBUIE să fie prezent. Un stub rupt cade pe control, nu trece tăcut.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandler, inputSchema, outputSchema, config, MAX_LIMIT } from './search-products.mjs'

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

    if (href.includes('/rpc/search_products_personalized')) {
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
 * @param {{ query: string, limit?: number }} args
 * @param {{ rpc?: unknown, brands?: unknown, rpcStatus?: number }} [plan]
 */
function run(args, plan) {
  const { impl, calls } = makeFetch(plan)
  const handler = createHandler({ env: ENV, fetchImpl: impl })
  return handler(args, {}).then((result) => ({ result, calls }))
}

/**
 * Payload-ul RPC al unui apel înregistrat, cu verificarea că apelul a avut loc.
 * Un `find()` care întoarce `undefined` ar face fiecare assert de mai jos să treacă
 * pe „nu există" — de aceea prezența e afirmată aici, o dată, pentru toate testele.
 *
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
 *
 * De ce nu un cast: un cast ar face fiecare test de mai jos să citească câmpuri
 * pe care nimeni nu le-a validat. Trecând prin schemă, orice test care citește
 * `products[0].price` afirmă în același timp că răspunsul respectă contractul
 * declarat tool-ului. ⚠️ Zod aruncă cheile necunoscute, deci un test care verifică
 * ABSENȚA unui câmp (`brand_id` nescurs) trebuie să se uite la obiectul BRUT —
 * pe `parsed.data` ar trece mereu, fără să măsoare nimic.
 *
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

test('gate RO-only: p_lang NU apare în payload-ul RPC (cu control pozitiv)', async () => {
  const { calls } = await run({ query: 'ace', limit: 5 })
  // CONTROL POZITIV — dacă astea cad, stub-ul sau extragerea e ruptă, nu codul testat.
  const rpcCall = callTo(calls, '/rpc/search_products_personalized')
  assert.equal(rpcCall.method, 'POST')
  assert.equal(rpcCall.body.p_query, 'ace', 'payload-ul nu conține interogarea')
  assert.equal(rpcCall.body.p_limit, 5)

  // Verificarea propriu-zisă.
  assert.equal(
    Object.hasOwn(rpcCall.body, 'p_lang'),
    false,
    'p_lang a ajuns în payload — produsele doar-HU ar deveni vizibile în ChatGPT',
  )
})

test('proiecția de coloane e trimisă ca select pe rezultatul RPC', async () => {
  const { calls } = await run({ query: 'ace' })
  const rpcCall = callTo(calls, '/rpc/search_products_personalized')
  assert.ok(rpcCall.url.includes('select='), 'lipsește select= → răspuns de ~15x mai mare')
  const decoded = decodeURIComponent(rpcCall.url)
  assert.ok(decoded.includes('slug'), 'select-ul nu cere slug-ul')
  assert.equal(decoded.includes('search_tsv'), false, 'select-ul cere coloane inutile')
})

test('structuredContent respectă outputSchema declarat', async () => {
  const { result } = await run({ query: 'ace' })
  assert.equal(result.isError, undefined)
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.equal(parsed.success, true, parsed.error ? String(parsed.error) : '')
  assert.equal(parsed.data.count, 1)
  assert.equal(parsed.data.products[0].product_id, 101)
})

test('URL-ul de produs folosește prefixul /product/, ca în magazin', async () => {
  const { result } = await run({ query: 'ace' })
  assert.equal(structured(result).products[0].url, 'https://tatuat.ro/product/ace-cartus-0-30-rl')
})

test('brand_id devine nume de brand', async () => {
  const { result } = await run({ query: 'ace' })
  assert.equal(structured(result).products[0].brand, 'Tatuat Pro')
})

test('brand necunoscut → null, nu id scurs în răspuns', async () => {
  const { result } = await run({ query: 'ace' }, { brands: [] })
  assert.equal(structured(result).products[0].brand, null)
  // Pe obiectul BRUT, nu pe cel validat: zod ar fi aruncat singur `brand_id`.
  assert.equal(JSON.stringify(result.structuredContent).includes('brand_id'), false)
})

test('reducere reală → price + price_before; fără reducere → price_before null', async () => {
  const { result: onSale } = await run(
    { query: 'ace' },
    { rpc: [{ ...ROW, price: 40, sale_price: 30 }] },
  )
  assert.equal(structured(onSale).products[0].price, 30)
  assert.equal(structured(onSale).products[0].price_before, 40)

  const { result: plain } = await run({ query: 'ace' })
  assert.equal(structured(plain).products[0].price, 40)
  assert.equal(structured(plain).products[0].price_before, null)
})

test('sale_price egal cu price NU se raportează ca reducere', async () => {
  const { result } = await run({ query: 'ace' }, { rpc: [{ ...ROW, price: 40, sale_price: 40 }] })
  assert.equal(structured(result).products[0].price, 40)
  assert.equal(structured(result).products[0].price_before, null)
})

test('moneda e etichetată RON în fiecare card și în text', async () => {
  const { result } = await run({ query: 'ace' })
  assert.equal(structured(result).products[0].currency, 'RON')
  assert.ok(result.content[0].text.includes('RON'))
})

test('interogare de un caracter: zero rezultate ȘI zero cereri de rețea', async () => {
  const { result, calls } = await run({ query: 'a' })
  assert.equal(structured(result).count, 0)
  assert.deepEqual(structured(result).products, [])
  assert.equal(calls.length, 0, 's-a interogat catalogul pentru o interogare prea scurtă')
})

test('zero potriviri: răspuns valid, nu eroare', async () => {
  const { result } = await run({ query: 'xyzq' }, { rpc: [] })
  assert.equal(result.isError, undefined)
  assert.equal(structured(result).count, 0)
})

test('PostgREST 500 → isError, fără structuredContent și fără detalii interne', async () => {
  const { result } = await run({ query: 'ace' }, { rpcStatus: 500 })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('supabase'), false, 'a scurs hostul intern')
  assert.equal(text.includes('500'), false, 'a scurs statusul HTTP brut')
  assert.ok(text.includes('tatuat.ro'))
})

test('plafon depășit → isError, fără date parțiale', async () => {
  const { impl } = makeFetch()
  const handler = createHandler({
    env: ENV,
    fetchImpl: impl,
    limiter: async () => false,
  })
  const result = await handler({ query: 'ace', limit: 5 }, {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
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
  await handler({ query: 'ace' }, { sessionId: 'sess-1' })
  await handler({ query: 'ace' }, { sessionId: 'sess-2' })
  assert.deepEqual(keys, ['search_products:sess-1', 'search_products:sess-2'])
})

test('inputSchema respinge limit peste plafon și acceptă lipsa lui', () => {
  assert.equal(inputSchema.safeParse({ query: 'ace', limit: MAX_LIMIT + 1 }).success, false)
  assert.equal(inputSchema.safeParse({ query: 'ace', limit: 0 }).success, false)
  const parsed = inputSchema.safeParse({ query: 'ace' })
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.limit, 10, 'defaultul de limit nu s-a aplicat')
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
