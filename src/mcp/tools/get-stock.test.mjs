/**
 * Teste pentru `get_stock` — starea de stoc pe o linie (produs simplu sau variantă).
 *
 * Logica portată 1:1 din tatuat-site/lib/stock-hint.ts (`stockHint`) + plafonul de
 * linie din tatuat-site/lib/cart-client.ts (`lineCap`, `MAX_QTY_PER_LINE = 9999`),
 * amândouă citite read-only, nereimplementate din memorie.
 *
 * ⚠️ Fiecare test de refuz/limită stă lângă un CONTROL POZITIV pe același drum,
 * ca un handler care ar respinge TOT să nu treacă toate testele de refuz.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandler, inputSchema, outputSchema, config, MAX_QTY_PER_LINE } from './get-stock.mjs'

/** Mediu fals. Valori inventate — nicio cheie reală în teste. */
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key-not-real',
  TATUAT_SITE_URL: 'https://tatuat.ro',
}

/** Produs simplu, fără variante. `stock_qty: 12` — cap-ul de linie devine 12. */
const SIMPLE_PRODUCT = {
  id: 501,
  slug: 'tus-negru-30ml',
  name: 'Tuș negru 30ml',
  description: 'Tuș de tatuaj negru, 30ml.',
  price: 45,
  sale_price: null,
  on_sale: false,
  sale_start: null,
  sale_end: null,
  from_price: null,
  from_price_max: null,
  in_stock: true,
  stock_qty: 12,
  primary_image: 'img.webp',
  variant_count: 0,
  brand_id: 7,
  sku: 'TN-30',
  weight_g: 40,
  model: null,
}

/** Produs pe precomandă: stoc 0. */
const PREORDER_PRODUCT = { ...SIMPLE_PRODUCT, id: 502, slug: 'tus-rosu-30ml', stock_qty: 0 }

/** Produs cu variante — stocul real trăiește pe variantă, nu pe produs. */
const VARIANT_PRODUCT = {
  ...SIMPLE_PRODUCT,
  id: 601,
  slug: 'ace-cartus-selectabil',
  name: 'Ace cartuș selectabil',
  variant_count: 2,
  stock_qty: 999, // irelevant când există variante — nu trebuie citit
}

const VARIANTS = [
  { id: 11, name: '0.30RL', sku: 'V-11', price: 40, sale_price: null, stock_qty: 5, is_default: true },
  { id: 12, name: '0.35RL', sku: 'V-12', price: 42, sale_price: null, stock_qty: 0, is_default: false },
]

/**
 * Stub de fetch pe rutele PostgREST folosite de `productBySlug`/`productVariants`.
 * @param {{ product?: unknown[], variants?: unknown[], productStatus?: number, variantsStatus?: number }} [plan]
 */
function makeFetch(plan = {}) {
  /** @type {{ url: string, method: string }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })

    if (href.includes('/v_products_with_pricing')) {
      const status = plan.productStatus ?? 200
      return new Response(JSON.stringify(plan.product ?? []), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (href.includes('/product_variants')) {
      const status = plan.variantsStatus ?? 200
      return new Response(JSON.stringify(plan.variants ?? []), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Rută neașteptată în test: ${href}`)
  }
  return { impl, calls }
}

/**
 * @param {{ slug: string, variant_id?: number, qty?: number }} args
 * @param {Parameters<typeof makeFetch>[0]} [plan]
 */
function run(args, plan) {
  const { impl, calls } = makeFetch(plan)
  const handler = createHandler({ env: ENV, fetchImpl: impl })
  return handler(args, {}).then((result) => ({ result, calls }))
}

/**
 * `structuredContent` trecut prin `outputSchema`, nu printr-un cast — vezi search-products.test.mjs.
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

// ---------------------------------------------------------------------------
// Control pozitiv: apelul chiar se face, cu filtrul corect.
// ---------------------------------------------------------------------------

test('control pozitiv: se interoghează v_products_with_pricing după slug', async () => {
  const { calls } = await run({ slug: 'tus-negru-30ml' }, { product: [SIMPLE_PRODUCT] })
  const call = calls.find((c) => c.url.includes('/v_products_with_pricing'))
  assert.ok(call, 'nu s-a interogat fișa produsului')
  const decoded = decodeURIComponent(call.url)
  assert.ok(decoded.includes('slug=eq.tus-negru-30ml'), 'filtrul de slug e greșit')
  assert.ok(decoded.includes('stock_qty'), 'select-ul nu cere stock_qty')
})

// ---------------------------------------------------------------------------
// Cele patru stări + granițele exacte dintre ele (produs simplu, stoc=12, cap=12).
// ---------------------------------------------------------------------------

test('in_stock: cerere sub stoc și sub plafon', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml', qty: 3 }, { product: [SIMPLE_PRODUCT] })
  const data = structured(result)
  assert.equal(data.state, 'in_stock')
  assert.equal(data.available_now, 3)
  assert.equal(data.backorder_qty, 0)
  assert.equal(data.max_orderable, 12)
})

test('graniță exactă: qty == stock == cap → max, NU in_stock', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml', qty: 12 }, { product: [SIMPLE_PRODUCT] })
  const data = structured(result)
  assert.equal(data.state, 'max')
  assert.equal(data.available_now, 12, 'la graniță tot cerută e onorabilă din stoc')
  assert.equal(data.backorder_qty, 0)
})

test('graniță exactă: qty == stock - 1 → tot in_stock, nu max', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml', qty: 11 }, { product: [SIMPLE_PRODUCT] })
  assert.equal(structured(result).state, 'in_stock')
})

test('partial: qty peste stoc, produsul NU e pe precomandă — răspunsul spune limita reală', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml', qty: 15 }, { product: [SIMPLE_PRODUCT] })
  const data = structured(result)
  assert.equal(data.state, 'partial')
  assert.equal(data.available_now, 12, 'limita comunicată trebuie să fie stocul real, nu cel cerut')
  assert.equal(data.backorder_qty, 3)
  const text = result.content[0].text
  assert.ok(text.includes('12'), 'textul nu menționează cantitatea reală disponibilă')
  assert.equal(text.includes('15 bucăți disponibile'), false, 'textul inventează disponibilitatea cerută')
})

test('graniță exactă: qty == stock + 1 → partial de la primul pas peste stoc', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml', qty: 13 }, { product: [SIMPLE_PRODUCT] })
  const data = structured(result)
  assert.equal(data.state, 'partial')
  assert.equal(data.available_now, 12)
  assert.equal(data.backorder_qty, 1)
})

test('preorder: stoc 0 → precomandă integrală, nu prezentată ca „în stoc"', async () => {
  const { result } = await run({ slug: 'tus-rosu-30ml', qty: 5 }, { product: [PREORDER_PRODUCT] })
  const data = structured(result)
  assert.equal(data.state, 'preorder')
  assert.equal(data.available_now, 0)
  assert.equal(data.backorder_qty, 5)
  assert.equal(data.max_orderable, MAX_QTY_PER_LINE, 'fără stoc, plafonul e cel global de linie')
  const text = result.content[0].text
  assert.equal(text.includes('în stoc'), false, 'precomanda nu trebuie prezentată ca stoc disponibil')
  assert.ok(text.toLowerCase().includes('precoman'), 'textul trebuie să spună explicit precomandă')
})

// ---------------------------------------------------------------------------
// Variante.
// ---------------------------------------------------------------------------

test('variant_id valid → stocul citit e al variantei, nu al produsului', async () => {
  const { result, calls } = await run(
    { slug: 'ace-cartus-selectabil', variant_id: 11, qty: 3 },
    { product: [VARIANT_PRODUCT], variants: VARIANTS },
  )
  const data = structured(result)
  assert.equal(data.state, 'in_stock')
  assert.equal(data.variant_id, 11)
  // Verificarea propriu-zisă: produsul are stock_qty 999 (irelevant), varianta 5.
  // Fără asta testul ar trece la fel de bine dacă handler-ul ar citi stocul
  // produsului (999) — starea ar fi tot 'in_stock' pentru qty=3 în ambele cazuri.
  assert.equal(data.max_orderable, 5, 'plafonul trebuie calculat din stocul VARIANTEI (5), nu al produsului (999)')
  const call = calls.find((c) => c.url.includes('/product_variants'))
  assert.ok(call, 'nu s-au interogat variantele')
  const decoded = decodeURIComponent(call.url)
  assert.ok(decoded.includes('product_id=eq.601'), 'variantele nu s-au cerut pentru product_id-ul corect')
})

test('fără variant_id pe produs cu variante → se folosește varianta implicită (is_default)', async () => {
  const { result } = await run(
    { slug: 'ace-cartus-selectabil', qty: 2 },
    { product: [VARIANT_PRODUCT], variants: VARIANTS },
  )
  const data = structured(result)
  assert.equal(data.variant_id, 11, 'nu s-a ales varianta is_default:true')
  assert.equal(data.state, 'in_stock')
})

test('variant_id inexistent pe acest produs → isError, fără date parțiale (cu control pozitiv)', async () => {
  // Control pozitiv: 12 EXISTĂ pe acest produs și trece.
  const { result: ok } = await run(
    { slug: 'ace-cartus-selectabil', variant_id: 12, qty: 1 },
    { product: [VARIANT_PRODUCT], variants: VARIANTS },
  )
  assert.equal(ok.isError, undefined)
  assert.equal(structured(ok).state, 'preorder', 'varianta 12 are stoc 0')

  // Verificarea propriu-zisă: 999 NU există pe acest produs.
  const { result: bad } = await run(
    { slug: 'ace-cartus-selectabil', variant_id: 999, qty: 1 },
    { product: [VARIANT_PRODUCT], variants: VARIANTS },
  )
  assert.equal(bad.isError, true)
  assert.equal(bad.structuredContent, undefined)
})

// ---------------------------------------------------------------------------
// Produs inexistent / erori de rețea — fără scurgeri.
// ---------------------------------------------------------------------------

test('produs inexistent → isError, fără structuredContent (cu control pozitiv pe slug valid)', async () => {
  const { result: ok } = await run({ slug: 'tus-negru-30ml' }, { product: [SIMPLE_PRODUCT] })
  assert.equal(ok.isError, undefined)

  const { result: bad } = await run({ slug: 'nu-exista' }, { product: [] })
  assert.equal(bad.isError, true)
  assert.equal(bad.structuredContent, undefined)
  assert.ok(bad.content[0].text.includes('tatuat.ro'))
})

test('PostgREST 500 pe fișa produsului → isError, fără host/status intern scurs', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml' }, { productStatus: 500 })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('supabase'), false, 'a scurs hostul intern')
  assert.equal(text.includes('500'), false, 'a scurs statusul HTTP brut')
})

// ---------------------------------------------------------------------------
// Plafon de cereri (rate limit) — cu control pozitiv și cheie per sesiune.
// ---------------------------------------------------------------------------

test('plafon depășit → isError, fără date parțiale', async () => {
  const { impl } = makeFetch({ product: [SIMPLE_PRODUCT] })
  const handler = createHandler({ env: ENV, fetchImpl: impl, limiter: async () => false })
  const result = await handler({ slug: 'tus-negru-30ml' }, {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
})

test('plafonul se cheie pe sesiune, nu global (control pozitiv: cererea trece)', async () => {
  /** @type {string[]} */
  const keys = []
  const { impl } = makeFetch({ product: [SIMPLE_PRODUCT] })
  const handler = createHandler({
    env: ENV,
    fetchImpl: impl,
    limiter: async (key) => {
      keys.push(key)
      return true
    },
  })
  const r1 = await handler({ slug: 'tus-negru-30ml' }, { sessionId: 'sess-1' })
  const r2 = await handler({ slug: 'tus-negru-30ml' }, { sessionId: 'sess-2' })
  assert.equal(r1.isError, undefined)
  assert.equal(r2.isError, undefined)
  assert.deepEqual(keys, ['get_stock:sess-1', 'get_stock:sess-2'])
})

// ---------------------------------------------------------------------------
// Schemă, annotations, contract.
// ---------------------------------------------------------------------------

test('inputSchema: qty implicit 1, respinge 0 și respinge peste MAX_QTY_PER_LINE', () => {
  const parsed = inputSchema.safeParse({ slug: 'x' })
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.qty, 1)
  assert.equal(inputSchema.safeParse({ slug: 'x', qty: 0 }).success, false)
  assert.equal(inputSchema.safeParse({ slug: 'x', qty: MAX_QTY_PER_LINE + 1 }).success, false)
  assert.equal(inputSchema.safeParse({ slug: 'x', qty: MAX_QTY_PER_LINE }).success, true)
})

test('URL-ul produsului folosește prefixul /product/', async () => {
  const { result } = await run({ slug: 'tus-negru-30ml' }, { product: [SIMPLE_PRODUCT] })
  assert.equal(structured(result).url, 'https://tatuat.ro/product/tus-negru-30ml')
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
