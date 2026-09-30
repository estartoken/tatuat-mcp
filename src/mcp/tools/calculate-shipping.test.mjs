/**
 * Teste pentru `calculate_shipping` — transport, prag gratuit, cadouri la prag.
 *
 * Praguri/tarife portate din tatuat-site (măsurate, nu din memorie):
 *  - lib/product-extra.ts: SHIP_THRESHOLD=300, SHIP_FEE=24
 *  - lib/gifts.ts: GIFT_THRESHOLD=500, GIFT2_THRESHOLD=800, cartShipping (heavy
 *    ÎNLOCUIEȘTE tariful standard, nu se adună la el)
 *
 * ⚠️ Ca în search-products.test.mjs: fiecare test de refuz/limită stă lângă un
 * CONTROL POZITIV pe același drum, ca un handler care ar respinge TOT să nu treacă
 * toate testele de refuz din greșeală.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createHandler,
  inputSchema,
  outputSchema,
  config,
  SHIP_THRESHOLD,
  SHIP_FEE,
  GIFT_THRESHOLD,
  GIFT2_THRESHOLD,
  GIFT_PRODUCT_NAME,
  GIFT2_PRODUCT_NAME,
  MAX_QUANTITY,
} from './calculate-shipping.mjs'
import { EXCLUDED_PRODUCTS } from '../policy.mjs'

/** Mediu fals. Valori inventate — nicio cheie reală în teste. */
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key-not-real',
}

/**
 * Stub de fetch pentru tabela `products` (singura interogată de acest tool).
 * @param {{ rows?: unknown, status?: number }} [plan]
 */
function makeFetch(plan = {}) {
  /** @type {{ url: string, method: string }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })
    if (href.includes('/products?')) {
      const status = plan.status ?? 200
      return new Response(JSON.stringify(plan.rows ?? []), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Rută neașteptată în test: ${href}`)
  }
  return { impl, calls }
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ rows?: unknown, status?: number }} [plan]
 */
function run(args, plan) {
  const { impl, calls } = makeFetch(plan)
  const handler = createHandler({ env: ENV, fetchImpl: impl })
  return handler(args, {}).then((result) => ({ result, calls }))
}

/**
 * `structuredContent` trecut prin `outputSchema`, nu printr-un cast — vezi
 * search-products.test.mjs pentru justificare.
 * @param {import('../tool-result.mjs').ToolResult} result
 */
function structured(result) {
  assert.ok(result.structuredContent, 'răspunsul nu are structuredContent')
  const parsed = outputSchema.safeParse(result.structuredContent)
  assert.ok(parsed.success, parsed.error ? String(parsed.error) : 'output invalid')
  return parsed.data
}

// ── subtotal direct, fără produse grele ──────────────────────────────────────

test('subtotal EXACT pe prag (300) → transport gratuit', async () => {
  const { result } = await run({ subtotal: SHIP_THRESHOLD })
  const out = structured(result)
  assert.equal(out.shipping_fee, 0)
  assert.equal(out.free_shipping, true)
  assert.equal(out.amount_to_free_shipping, 0)
})

test('subtotal SUB prag (299.99) → transport plătit, diferența corectă', async () => {
  const { result } = await run({ subtotal: 299.99 })
  const out = structured(result)
  assert.equal(out.shipping_fee, SHIP_FEE)
  assert.equal(out.free_shipping, false)
  assert.equal(out.amount_to_free_shipping, 0.01)
})

test('subtotal PESTE prag (301) → transport gratuit', async () => {
  const { result } = await run({ subtotal: 301 })
  const out = structured(result)
  assert.equal(out.shipping_fee, 0)
  assert.equal(out.free_shipping, true)
})

test('subtotal cu rotunjire flotantă exact pe prag nu cade de partea greșită', async () => {
  // 0.1 + 0.2 !== 0.3 în float — aceeași capcană documentată în product-extra.ts.
  const { result } = await run({ subtotal: 299.999999999999 })
  const out = structured(result)
  assert.equal(out.shipping_fee, 0, 'rotunjirea la 2 zecimale trebuia să tragă subtotalul la 300')
})

// ── coș gol ───────────────────────────────────────────────────────────────────

test('coș gol (lines: []) → subtotal 0, transport standard, ZERO cereri de rețea', async () => {
  const { result, calls } = await run({ lines: [] })
  const out = structured(result)
  assert.equal(out.subtotal, 0)
  assert.equal(out.shipping_fee, SHIP_FEE)
  assert.equal(out.free_shipping, false)
  assert.equal(out.amount_to_free_shipping, SHIP_THRESHOLD)
  assert.equal(calls.length, 0, 'coșul gol nu are ce produs să interogheze în catalog')
})

// ── linii de coș, prin catalog ────────────────────────────────────────────────

test('linie după slug: subtotalul se calculează din prețul REAL din catalog, nu dintr-unul declarat', async () => {
  const { result, calls } = await run(
    { lines: [{ slug: 'ace-cartus-0-30-rl', quantity: 2 }] },
    { rows: [{ id: 101, slug: 'ace-cartus-0-30-rl', price: 40, sale_price: null, shipping_override: null, weight_g: null }] },
  )
  // CONTROL POZITIV — dacă asta cade, stub-ul e rupt, nu logica testată.
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes('/products?'))

  const out = structured(result)
  assert.equal(out.subtotal, 80, '2 × 40 RON')
})

test('linie după product_id: la fel ca după slug', async () => {
  const { result } = await run(
    { lines: [{ product_id: 101, quantity: 1 }] },
    { rows: [{ id: 101, slug: 'x', price: 50, sale_price: null, shipping_override: null, weight_g: null }] },
  )
  assert.equal(structured(result).subtotal, 50)
})

test('preț redus: subtotalul folosește sale_price, ca effectivePrice din catalog', async () => {
  const { result } = await run(
    { lines: [{ slug: 'x', quantity: 1 }] },
    { rows: [{ id: 1, slug: 'x', price: 100, sale_price: 70, shipping_override: null, weight_g: null }] },
  )
  assert.equal(structured(result).subtotal, 70)
})

test('produs necunoscut în catalog: linia nu contribuie la subtotal (fail-closed, nu preț inventat)', async () => {
  const { result } = await run({ lines: [{ slug: 'nu-exista', quantity: 5 }] }, { rows: [] })
  assert.equal(structured(result).subtotal, 0)
})

// ── produse grele (shipping_override) ─────────────────────────────────────────

test('coș cu produs greu: transportul e SUMA override × cantitate, nu tariful standard', async () => {
  const { result } = await run(
    { lines: [{ slug: 'scaun-hidraulic', quantity: 1 }] },
    { rows: [{ id: 9, slug: 'scaun-hidraulic', price: 900, sale_price: null, shipping_override: 150, weight_g: 60000 }] },
  )
  const out = structured(result)
  assert.equal(out.subtotal, 900, 'CONTROL: subtotalul rămâne prețul real, indiferent de override')
  assert.equal(out.shipping_fee, 150, 'override × 1 buc')
  assert.equal(out.heavy_shipping, true)
})

test('produs greu cu cantitate 2: override se ADUNĂ pe cantitate', async () => {
  const { result } = await run(
    { lines: [{ slug: 'scaun-hidraulic', quantity: 2 }] },
    { rows: [{ id: 9, slug: 'scaun-hidraulic', price: 900, sale_price: null, shipping_override: 150, weight_g: 60000 }] },
  )
  assert.equal(structured(result).shipping_fee, 300, '150 × 2')
})

test('produs greu SUB pragul de transport gratuit: override ÎNLOCUIEȘTE tariful standard', async () => {
  // 🔴 RETRACTARE 29.09.2026 — comentariul care stătea aici afirma că producția a avut un bug
  // real la transportul produselor grele sub pragul de gratuitate. AFIRMAȚIA E FALSĂ și a costat
  // deja o sesiune întreagă de re-derivare a unui bug care n-a existat. Dovada, în ordine:
  //   • Forma `heavy && roundedSubtotal >= SHIP_THRESHOLD ? …` a existat pe disc DOAR între
  //     12:36:47 și 12:50:16 (28.09), ca MUTANT deliberat, pus ca să dovedească faptul că testul
  //     de mai jos discriminează. A fost restaurată după 13,5 minute.
  //   • O altă sesiune a citit fișierul la 12:46:16, adică din interiorul acelei ferestre, și a
  //     luat mutantul drept cod livrat.
  //   • Deploy-ul de producție (dpl_GamXVbxnjWeMkywkGt4hd5wz5uMB, READY) a rulat la 16:23:17 —
  //     la 1h33m DUPĂ restaurare. Mutantul n-a ajuns niciodată la un client.
  // Forma din `calculate-shipping.mjs` (~linia 220) a fost și este cea corectă:
  //   heavy ? round2(heavyTotal) : roundedSubtotal >= SHIP_THRESHOLD ? 0 : SHIP_FEE
  //
  // CE RĂMÂNE ADEVĂRAT și de ce merită testul: până la el, toate cazurile de produs greu aveau
  // subtotal 900 (peste pragul de 300), unde forma corectă și cea greșită dau ACELAȘI rezultat.
  // Testul de aici, cu subtotal 50, e singurul punct în care divergează: 20 (corect) vs 24
  // (mutant). Era un gol real de acoperire — dar un gol, nu un bug în producție.
  //
  // ⚠️ Lecția, pentru oricine citește codul altei sesiuni: un fișier prins la mijlocul unui test
  // de mutație nu e cod livrat. Verifică ce s-a DEPLOYAT, nu ce era pe disc la o secundă anume.
  //
  // Afirmă ÎNTREGUL structuredContent, nu doar `shipping_fee`: valorile sunt
  // derivate din cod (heavyFeeFor × qty, freeShipping === fee 0, round2(300-50),
  // nextGift la 500), nu calibrate pe o rulare.
  const { result } = await run(
    { lines: [{ slug: 'cutie-mica-dar-grea', quantity: 1 }] },
    { rows: [{ id: 42, slug: 'cutie-mica-dar-grea', price: 50, sale_price: null, shipping_override: 20, weight_g: 30000 }] },
  )
  const out = structured(result)
  assert.equal(out.subtotal, 50, 'CONTROL: prețul real din catalog')
  assert.equal(out.heavy_shipping, true)
  assert.equal(out.shipping_fee, 20, 'override 20 × 1 buc — NU tariful standard 24, NU 0')
  assert.equal(out.free_shipping, false)
  assert.equal(out.amount_to_free_shipping, SHIP_THRESHOLD - 50)
  assert.deepEqual(out.gifts_reached, [])
  assert.ok(out.next_gift)
  assert.equal(out.next_gift.name, GIFT_PRODUCT_NAME)
  assert.equal(out.next_gift.amount_needed, GIFT_THRESHOLD - 50)
})

test('produs greu peste pragul de transport gratuit: tariful override rămâne, NU devine 0', async () => {
  // cartShipping din gifts.ts: „if (heavy > 0) return heavy" — heavy nu se anulează la prag.
  const { result } = await run(
    { lines: [{ slug: 'scaun-hidraulic', quantity: 1 }] },
    { rows: [{ id: 9, slug: 'scaun-hidraulic', price: 900, sale_price: null, shipping_override: 150, weight_g: 60000 }] },
  )
  const out = structured(result)
  assert.equal(out.shipping_fee, 150)
  assert.equal(out.heavy_shipping, true)
})

// ── cadouri la prag ────────────────────────────────────────────────────────────

test('sub ambele praguri: niciun cadou atins, next_gift e primul (500)', async () => {
  const { result } = await run({ subtotal: 100 })
  const out = structured(result)
  assert.deepEqual(out.gifts_reached, [])
  assert.ok(out.next_gift)
  assert.equal(out.next_gift.name, GIFT_PRODUCT_NAME)
  assert.equal(out.next_gift.amount_needed, GIFT_THRESHOLD - 100)
})

test('EXACT pe primul prag de cadou (500): cadoul 1 atins, next_gift e al doilea (800)', async () => {
  const { result } = await run({ subtotal: GIFT_THRESHOLD })
  const out = structured(result)
  assert.deepEqual(out.gifts_reached, [GIFT_PRODUCT_NAME])
  assert.ok(out.next_gift)
  assert.equal(out.next_gift.name, GIFT2_PRODUCT_NAME)
  assert.equal(out.next_gift.amount_needed, GIFT2_THRESHOLD - GIFT_THRESHOLD)
})

test('EXACT pe al doilea prag de cadou (800): ambele cadouri atinse, next_gift null', async () => {
  const { result } = await run({ subtotal: GIFT2_THRESHOLD })
  const out = structured(result)
  assert.deepEqual(out.gifts_reached, [GIFT_PRODUCT_NAME, GIFT2_PRODUCT_NAME])
  assert.equal(out.next_gift, null)
})

test('peste al doilea prag: ambele cadouri rămân atinse', async () => {
  const { result } = await run({ subtotal: GIFT2_THRESHOLD + 500 })
  const out = structured(result)
  assert.deepEqual(out.gifts_reached, [GIFT_PRODUCT_NAME, GIFT2_PRODUCT_NAME])
  assert.equal(out.next_gift, null)
})

// ── validare de input (refuz + control pozitiv) ───────────────────────────────

test('subtotal negativ: RESPINS de inputSchema', () => {
  assert.equal(inputSchema.safeParse({ subtotal: -1 }).success, false)
})
test('control: subtotal 0 (valid, coș gol prin subtotal) e ACCEPTAT', () => {
  assert.equal(inputSchema.safeParse({ subtotal: 0 }).success, true)
})

test('subtotal absurd de mare: RESPINS de inputSchema', () => {
  assert.equal(inputSchema.safeParse({ subtotal: 50_000_000 }).success, false)
})
test('control: subtotal mare dar plauzibil e ACCEPTAT', () => {
  assert.equal(inputSchema.safeParse({ subtotal: 5000 }).success, true)
})

test('cantitate 0 sau peste plafon: RESPINSE de inputSchema', () => {
  assert.equal(inputSchema.safeParse({ lines: [{ slug: 'x', quantity: 0 }] }).success, false)
  assert.equal(inputSchema.safeParse({ lines: [{ slug: 'x', quantity: MAX_QUANTITY + 1 }] }).success, false)
})
test('control: cantitate validă în plafon e ACCEPTATĂ', () => {
  assert.equal(inputSchema.safeParse({ lines: [{ slug: 'x', quantity: MAX_QUANTITY }] }).success, true)
})

test('linie cu AMBELE slug și product_id: RESPINSĂ', () => {
  assert.equal(
    inputSchema.safeParse({ lines: [{ slug: 'x', product_id: 1, quantity: 1 }] }).success,
    false,
  )
})
test('linie fără slug ȘI fără product_id: RESPINSĂ', () => {
  assert.equal(inputSchema.safeParse({ lines: [{ quantity: 1 }] }).success, false)
})
test('control: linie cu EXACT unul dintre slug/product_id e ACCEPTATĂ', () => {
  assert.equal(inputSchema.safeParse({ lines: [{ slug: 'x', quantity: 1 }] }).success, true)
  assert.equal(inputSchema.safeParse({ lines: [{ product_id: 1, quantity: 1 }] }).success, true)
})

test('AMBELE lines și subtotal date: RESPINS — sursa de adevăr a subtotalului ar fi ambiguă', () => {
  assert.equal(inputSchema.safeParse({ lines: [], subtotal: 10 }).success, false)
})
test('NICIUNUL din lines/subtotal dat: RESPINS', () => {
  assert.equal(inputSchema.safeParse({}).success, false)
})
test('control: exact unul dintre lines/subtotal e ACCEPTAT', () => {
  assert.equal(inputSchema.safeParse({ lines: [] }).success, true)
  assert.equal(inputSchema.safeParse({ subtotal: 10 }).success, true)
})

// ── infrastructură partajată (rate limit, erori, moneda) ──────────────────────

test('PostgREST 500 pe /products → isError, fără structuredContent și fără detalii interne', async () => {
  const { result } = await run({ lines: [{ slug: 'x', quantity: 1 }] }, { status: 500 })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
  const text = result.content[0].text
  assert.equal(text.includes('supabase'), false, 'a scurs hostul intern')
  assert.equal(text.includes('500'), false, 'a scurs statusul HTTP brut')
})
test('control: catalogul răspunde 200 → rezultat valid, nu eroare', async () => {
  const { result } = await run({ lines: [{ slug: 'x', quantity: 1 }] }, { rows: [] })
  assert.equal(result.isError, undefined)
})

test('plafon depășit → isError, fără date parțiale', async () => {
  const handler = createHandler({ env: ENV, fetchImpl: makeFetch().impl, limiter: async () => false })
  const result = await handler({ subtotal: 10 }, {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent, undefined)
})
test('control: sub plafon → rezultat valid', async () => {
  const handler = createHandler({ env: ENV, fetchImpl: makeFetch().impl, limiter: async () => true })
  const result = await handler({ subtotal: 10 }, {})
  assert.equal(result.isError, undefined)
})

test('plafonul se cheie pe sesiune, nu global', async () => {
  /** @type {string[]} */
  const keys = []
  const handler = createHandler({
    env: ENV,
    fetchImpl: makeFetch().impl,
    limiter: async (key) => {
      keys.push(key)
      return true
    },
  })
  await handler({ subtotal: 10 }, { sessionId: 'sess-1' })
  await handler({ subtotal: 10 }, { sessionId: 'sess-2' })
  assert.deepEqual(keys, ['calculate_shipping:sess-1', 'calculate_shipping:sess-2'])
})

test('moneda e etichetată RON', async () => {
  const { result } = await run({ subtotal: 10 })
  assert.equal(structured(result).currency, 'RON')
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 PRODUSE CU VARIANTE — aceeași clasă de defect ca la `search_products`, ratată în primul val.
//
// Măsurat 29.09.2026 pe tabela `products` (sursa ACESTUI tool, nu view-ul): produsul
// `ace-de-tatuat-cartus-limited-rl` are acolo `price = 0.00`; prețul real, 5.70, stă pe cele 19
// variante. 55 din cele 1664 de produse active sunt așa. `effectivePrice` întorcea `0` — finit,
// deci contribuia 0 la subtotal, nu era sărit ca o valoare lipsă — iar clientul cu coșul plin era
// anunțat că mai are de cumpărat sute de lei până la transport gratuit.
//
// 🔑 DE CE MINIMUL E RĂSPUNSUL CORECT AICI. Tool-ul nu primește `variant_id` (vezi `inputSchema`),
// deci nu poate ști ce variantă a ales clientul. Minimul variantelor greșește în direcția SIGURĂ:
// subestimează subtotalul, deci nu promite niciodată un transport gratuit pe care clientul nu-l
// primește. Supraestimarea ar face exact invers. Măsurat pe tot catalogul: la 0 din cele 63 de
// produse cu variante minimul vine de la o variantă fără stoc, deci nu anunțăm un preț de neatins.
// ─────────────────────────────────────────────────────────────────────────────

/** Rândul real al produsului, cu variantele îmbricate cum le întoarce PostgREST. */
const RAND_CU_VARIANTE = {
  id: 8312,
  slug: 'ace-de-tatuat-cartus-limited-rl',
  price: 0,
  sale_price: null,
  shipping_override: null,
  weight_g: 10,
  product_variants: [
    { price: 5.7, sale_price: null },
    { price: 5.7, sale_price: null },
  ],
}

test('produs cu variante: subtotalul folosește prețul variantei, nu 0', async () => {
  const { result } = await run(
    { lines: [{ slug: 'ace-de-tatuat-cartus-limited-rl', quantity: 100 }] },
    { rows: [RAND_CU_VARIANTE] },
  )
  assert.equal(structured(result).subtotal, 570, '100 × 5.70, nu 100 × 0')
})

test('🔴 coșul care DEPĂȘEȘTE pragul nu mai e anunțat ca sub prag', async () => {
  // Defectul în forma lui vizibilă clientului: 570 RON e peste pragul de 300, deci transportul e
  // gratuit. Înainte, tool-ul răspundea „mai sunt necesari 300.00 RON pentru transport gratuit".
  const { result } = await run(
    { lines: [{ slug: 'ace-de-tatuat-cartus-limited-rl', quantity: 100 }] },
    { rows: [RAND_CU_VARIANTE] },
  )
  assert.equal(structured(result).shipping_fee, 0, 'peste prag ⇒ transport gratuit')
  assert.equal(structured(result).free_shipping, true)
  assert.equal(structured(result).amount_to_free_shipping, 0)
  assert.doesNotMatch(result.content[0].text, /pentru transport gratuit/)
})

test('variante la prețuri diferite: se ia MINIMUL, nu maximul și nu media', async () => {
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 10 }] },
    {
      rows: [
        {
          ...RAND_CU_VARIANTE,
          slug: 'p',
          product_variants: [{ price: 6.97 }, { price: 3.97 }, { price: 5.5 }],
        },
      ],
    },
  )
  assert.equal(structured(result).subtotal, 39.7, '10 × 3.97 — subestimare, nu supraestimare')
})

test('preț de bază NENUL + variante: se taxează varianta, nu prețul de bază', async () => {
  // 🔴 Găsit prin testare de mutație: ștergerea lui `variant_count` din `withVariantPricing` nu
  // pica niciun test, fiindcă toate fixture-urile aveau `price: 0` — acolo ramura se intră oricum
  // prin `bazaLipsa`. La un produs cu preț de bază nenul ȘI variante, `variant_count` e SINGURA
  // cale de intrare, iar fără el subtotalul ar folosi prețul de bază: bani, nu etichetă.
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 3 }] },
    { rows: [{ ...RAND_CU_VARIANTE, slug: 'p', price: 100, product_variants: [{ price: 42 }, { price: 90 }] }] },
  )
  assert.equal(structured(result).subtotal, 126, '3 × 42 (varianta), nu 3 × 100 (prețul de bază)')
})

test('reducerea pe variantă intră în subtotal, nu prețul întreg al variantei', async () => {
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 4 }] },
    { rows: [{ ...RAND_CU_VARIANTE, slug: 'p', product_variants: [{ price: 20, sale_price: 12 }] }] },
  )
  assert.equal(structured(result).subtotal, 48, '4 × 12, prețul chiar plătit')
})

test('CONTROL: produsul simplu nu e atins de ramura variantelor', async () => {
  const { result } = await run(
    { lines: [{ slug: 'simplu', quantity: 2 }] },
    { rows: [{ id: 1, slug: 'simplu', price: 100, sale_price: 70, shipping_override: null, weight_g: 10 }] },
  )
  assert.equal(structured(result).subtotal, 140, 'reducerea reală se aplică, exact ca înainte')
})

test('CONTROL: variante fără preț valid nu fabrică un subtotal', async () => {
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 3 }] },
    { rows: [{ ...RAND_CU_VARIANTE, slug: 'p', product_variants: [{ price: 0 }, { price: null }] }] },
  )
  assert.equal(structured(result).subtotal, 0, 'fără preț cunoscut nu inventăm unul')
})

test('o variantă cu preț 0 amestecată cu una validă NU trage minimul la 0', async () => {
  // 🔴 Găsit de verificatorul adversarial prin mutația `p > 0` → `p >= 0`, care rămânea verde pe
  // toate cele 253 de teste. Singurul test cu „variante fără preț valid" le are pe AMBELE
  // invalide, deci nu discriminează: și codul corect, și mutantul dau 0 acolo. Cazul care
  // discriminează e AMESTECUL — o variantă cu preț 0 lângă una reală. Cu mutantul, minimul devine
  // 0 și subtotalul unui coș de 57 RON iese 0: exact regresia „preț 0" de la care a pornit tot
  // fixul, reintrodusă pe altă coloană.
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 10 }] },
    { rows: [{ ...RAND_CU_VARIANTE, slug: 'p', product_variants: [{ price: 0 }, { price: 5.7 }] }] },
  )
  assert.equal(structured(result).subtotal, 57, '10 × 5.70 — varianta cu preț 0 nu e un preț')
})

test('produsul EXCLUS din canal nu-și scurge prețul prin calculate_shipping', async () => {
  // Drumul de shipping citește direct tabela `products`, nu view-ul, deci are propriul apel la
  // `filterAllowedProducts`. Niciun test nu-l acoperea: inversarea ordinii lui față de
  // `withVariantPricing` rămânea verde. Aici e un anestezic cu lidocaină — dacă ar intra în
  // subtotal, tool-ul ar confirma implicit că produsul e cumpărabil prin canalul ChatGPT.
  const [exclus] = EXCLUDED_PRODUCTS
  const { result } = await run(
    { lines: [{ product_id: exclus.id, quantity: 4 }] },
    { rows: [{ ...RAND_CU_VARIANTE, id: exclus.id, slug: 'anestezic', price: 120, product_variants: [] }] },
  )
  assert.equal(structured(result).subtotal, 0, `${exclus.name} trebuie tratat ca produs necunoscut`)
})

test('CONTROL: taxa de colet greu supraviețuiește schimbării de interogare', async () => {
  const { result } = await run(
    { lines: [{ slug: 'p', quantity: 2 }] },
    { rows: [{ ...RAND_CU_VARIANTE, slug: 'p', shipping_override: 50 }] },
  )
  assert.equal(structured(result).shipping_fee, 100, '2 × 50, override-ul nu s-a pierdut')
  assert.equal(structured(result).heavy_shipping, true, 'ramura „greu", nu tariful standard')
})

test('interogarea cere efectiv variantele — altfel fixul n-ar avea de unde ști prețul', async () => {
  const { calls } = await run(
    { lines: [{ slug: 'ace-de-tatuat-cartus-limited-rl', quantity: 1 }] },
    { rows: [RAND_CU_VARIANTE] },
  )
  const url = decodeURIComponent(calls[0].url)
  assert.match(url, /product_variants\(/, 'select-ul trebuie să îmbrice variantele')
  assert.match(url, /shipping_override/, 'coloanele vechi rămân — taxa de colet greu nu se pierde')
  assert.equal(calls.length, 1, 'o singură cerere de rețea, nu una în plus pentru variante')
})

// ---------------------------------------------------------------------------
// Restricția „doar Ungaria" pe coș (01.10.2026).
//
// Transportul rămâne calculat corect — cifra nu se falsifică. Ce se adaugă e
// avertismentul că un coș cu acel produs va fi refuzat la plasare pentru o
// livrare în România, ca agentul să nu ducă clientul până la formular.
// ---------------------------------------------------------------------------

/** Rândul real: produsul `lang='hu'`, 50 RON (măsurat live 01.10.2026). */
const HU_ROW = { id: 90000001, slug: 'produs-sintetic-doar-hu', price: 50, sale_price: null, shipping_override: null, weight_g: null, lang: 'hu' }
const RO_ROW = { id: 101, slug: 'tus-negru-30ml', price: 17, sale_price: null, shipping_override: null, weight_g: null, lang: null }

test('linie cu produs lang="hu": coșul declară restricția, iar subtotalul rămâne real', async () => {
  const { result } = await run({ lines: [{ slug: 'produs-sintetic-doar-hu', quantity: 3 }] }, { rows: [HU_ROW] })
  const out = structured(result)
  assert.equal(out.order_restriction, 'hu_only')
  assert.equal(out.subtotal, 150, '3 × 50 RON — cifra nu se schimbă, doar se adaugă avertismentul')
  assert.ok(/Ungaria/.test(result.content.map((c) => c.text).join(' ')))
})

test('CONTROL NEGATIV: coș numai cu produse RO → nicio restricție', async () => {
  const { result } = await run({ lines: [{ slug: 'tus-negru-30ml', quantity: 1 }] }, { rows: [RO_ROW] })
  const out = structured(result)
  assert.equal(out.order_restriction, null)
  assert.equal(out.subtotal, 17)
  assert.ok(!/Ungaria/.test(result.content.map((c) => c.text).join(' ')))
})

test('un singur produs restricționat într-un coș mixt e destul', async () => {
  const { result } = await run(
    { lines: [{ slug: 'tus-negru-30ml', quantity: 1 }, { slug: 'produs-sintetic-doar-hu', quantity: 1 }] },
    { rows: [RO_ROW, HU_ROW] },
  )
  const out = structured(result)
  assert.equal(out.order_restriction, 'hu_only')
  assert.equal(out.subtotal, 67, '17 + 50 — ambele linii contribuie')
})

test('linie NEREZOLVATĂ nu pune avertismentul pe un coș în care produsul n-a intrat', async () => {
  // Discriminantul care deosebește „citit din `rows`" de „citit din linia care a
  // CONTRIBUIT": catalogul întoarce produsul HU, dar linia cerută e alt slug, deci
  // produsul nu ajunge în coș — nici subtotal, nici avertisment.
  const { result } = await run({ lines: [{ slug: 'alt-slug-nepotrivit', quantity: 1 }] }, { rows: [HU_ROW] })
  const out = structured(result)
  assert.equal(out.subtotal, 0, 'linia nerezolvată nu contribuie')
  assert.equal(out.order_restriction, null, 'avertisment pe un produs care nu e în coș')
})

test('ramura cu `subtotal` dat de apelant: restricția e null, nu inventată', async () => {
  // Fără linii, tool-ul nu știe ce produse sunt în coș. `null` = „nu am ce declara",
  // și nu se face nicio cerere de rețea din care s-ar putea ghici.
  const { result, calls } = await run({ subtotal: 50 }, { rows: [HU_ROW] })
  assert.equal(calls.length, 0, 'ramura cu subtotal nu are voie să interogheze catalogul')
  assert.equal(structured(result).order_restriction, null)
})
