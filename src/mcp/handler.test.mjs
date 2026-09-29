/**
 * Teste pentru marginea HTTP: ce e respins ÎNAINTE de a ajunge la pachet, și că
 * serverul chiar se cablează (nu doar „se construiește fără să arunce").
 *
 * ⚠️ Cele două validări ale pachetului au POLARITĂȚI OPUSE la header absent —
 * măsurat în `dist/index.mjs`:
 *   - `validateHostHeader(null, …)`   → RESPINS (`missing_host`), 403.
 *   - `validateOriginHeader(null, …)` → ACCEPTAT (`{ok:true}`), deliberat:
 *     „non-browser clients do not send one".
 * Un test scris presupunând simetrie ar trece fals pe una din cele două, deci
 * fiecare polaritate e afirmată separat, cu valoarea ei măsurată.
 *
 * ⚠️ Fiecare test de respingere stă lângă un CONTROL POZITIV pe același drum:
 * un handler care ar respinge TOT ar trece toate testele de 403. Marker-ul
 * stubului (`STUB_STATUS`) e un status pe care nici validarea, nici pachetul nu
 * îl pot produce — dacă apare, cererea a ajuns efectiv la `inner`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Versiunea de protocol se IMPORTĂ, nu se scrie de mână: un string ghicit ar
// clasifica cererea în era greșită și ar măsura altceva decât cred.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'

import { createTatuatMcpHandler } from './handler.mjs'

/** Mediu fals. Valori inventate — nicio cheie reală în teste. */
const ENV = {
  SUPABASE_URL: 'https://example-ref.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key-not-real',
  TATUAT_SITE_URL: 'https://tatuat.ro',
  MCP_ALLOWED_HOSTS: 'api.tatuat.ro',
}

/** Status imposibil de produs de validare (403) sau de pachet. */
const STUB_STATUS = 299

/** `inner` fals, care înregistrează cererile ajunse până la el. */
function stubInner() {
  /** @type {Request[]} */
  const calls = []
  return {
    calls,
    inner: {
      /** @param {Request} req */
      fetch: async (req) => {
        calls.push(req)
        return new Response('inner', { status: STUB_STATUS })
      },
    },
  }
}

/**
 * Trimite o cerere prin margine, cu `inner` stubuit.
 * @param {Record<string, string>} headers
 */
async function through(headers) {
  const { inner, calls } = stubInner()
  const handler = createTatuatMcpHandler({ env: ENV, inner })
  const res = await handler.fetch(
    new Request('https://api.tatuat.ro/mcp', { method: 'POST', headers, body: '{}' }),
  )
  return { res, calls }
}

/**
 * Corpul unui refuz: forma JSON-RPC pe care o produce pachetul.
 * @param {Response} res
 */
async function refusalBody(res) {
  const parsed = await res.json()
  return /** @type {{ jsonrpc?: string, error?: { code?: number, message?: string } }} */ (parsed)
}

test('Host care nu e în allowlist → 403, cererea nu ajunge la server', async () => {
  const { res, calls } = await through({ host: 'tatuat-mcp-preview.vercel.app' })
  assert.equal(res.status, 403)
  assert.equal(calls.length, 0, 'cererea a trecut spre server deși hostul e străin')
  const body = await refusalBody(res)
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.error?.code, -32000)
})

test('CONTROL POZITIV: Host allowlistat ajunge la server', async () => {
  const { res, calls } = await through({ host: 'api.tatuat.ro' })
  assert.equal(res.status, STUB_STATUS, 'o cerere legitimă a fost respinsă la margine')
  assert.equal(calls.length, 1)
})

test('Host ABSENT → 403 (fail-closed), nu trecere', async () => {
  const { res, calls } = await through({})
  assert.equal(res.status, 403, 'lipsa headerului Host a fost tratată ca permisivă')
  assert.equal(calls.length, 0)
})

test('Host cu port trece: validarea e port-agnostică', async () => {
  const { res, calls } = await through({ host: 'api.tatuat.ro:443' })
  assert.equal(res.status, STUB_STATUS)
  assert.equal(calls.length, 1)
})

test('Host cu majuscule trece: comparația e pe hostname normalizat', async () => {
  const { res } = await through({ host: 'API.Tatuat.RO' })
  assert.equal(res.status, STUB_STATUS)
})

test('Origin de pe alt host → 403, chiar cu Host bun', async () => {
  const { res, calls } = await through({ host: 'api.tatuat.ro', origin: 'https://evil.example' })
  assert.equal(res.status, 403, 'un Origin străin a fost acceptat — suprafață de DNS rebinding')
  assert.equal(calls.length, 0)
})

test('Origin ABSENT → trece (polaritate OPUSĂ față de Host, deliberat în pachet)', async () => {
  const { res, calls } = await through({ host: 'api.tatuat.ro' })
  assert.equal(res.status, STUB_STATUS, 'clienții MCP non-browser nu trimit Origin și ar fi blocați')
  assert.equal(calls.length, 1)
})

test('Origin allowlistat → trece', async () => {
  const { res } = await through({ host: 'api.tatuat.ro', origin: 'https://api.tatuat.ro' })
  assert.equal(res.status, STUB_STATUS)
})

test('Origin „null" (context opac de browser) → 403', async () => {
  const { res } = await through({ host: 'api.tatuat.ro', origin: 'null' })
  assert.equal(res.status, 403, 'originul opac a fost acceptat')
})

test('MCP_ALLOWED_HOSTS acceptă mai multe gazde, fiecare validă', async () => {
  const env = { ...ENV, MCP_ALLOWED_HOSTS: 'api.tatuat.ro, mcp.tatuat.ro' }
  for (const host of ['api.tatuat.ro', 'mcp.tatuat.ro']) {
    const { inner, calls } = stubInner()
    const handler = createTatuatMcpHandler({ env, inner })
    const res = await handler.fetch(
      new Request('https://api.tatuat.ro/mcp', { method: 'POST', headers: { host }, body: '{}' }),
    )
    assert.equal(res.status, STUB_STATUS, `${host} a fost respins`)
    assert.equal(calls.length, 1)
  }
  const { inner, calls } = stubInner()
  const handler = createTatuatMcpHandler({ env, inner })
  const res = await handler.fetch(
    new Request('https://api.tatuat.ro/mcp', {
      method: 'POST',
      headers: { host: 'alt.tatuat.ro' },
      body: '{}',
    }),
  )
  assert.equal(res.status, 403, 'o gazdă neînscrisă a trecut')
  assert.equal(calls.length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// Cablaj real: fără `inner` stubuit, fără rețea.
// ─────────────────────────────────────────────────────────────────────────────

/** `fetch` care ARUNCĂ: dacă handshake-ul atinge rețeaua, testul cade zgomotos. */
const noNetwork = /** @type {typeof fetch} */ (
  async () => {
    throw new Error('handshake-ul MCP nu are voie să facă cereri de rețea')
  }
)

/**
 * Corpul JSON-RPC al unui răspuns, indiferent dacă a venit JSON sau SSE.
 * `responseMode` e `'auto'`, deci forma nu e garantată — o citim, nu o presupunem.
 * @param {Response} res
 */
async function rpcResult(res) {
  const text = await res.text()
  const type = res.headers.get('content-type') ?? ''
  const raw = type.includes('text/event-stream')
    ? (text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0)
        .pop() ?? '')
    : text
  assert.ok(raw.length > 0, `răspuns fără corp JSON-RPC (status ${res.status}): ${text.slice(0, 300)}`)
  return /** @type {{ result?: Record<string, any>, error?: { message?: string } }} */ (
    JSON.parse(raw)
  )
}

/**
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function realCall(body, extraHeaders = {}) {
  const handler = createTatuatMcpHandler({ env: ENV, fetchImpl: noNetwork })
  const res = await handler.fetch(
    new Request('https://api.tatuat.ro/mcp', {
      method: 'POST',
      headers: {
        host: 'api.tatuat.ro',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  )
  return { res, rpc: await rpcResult(res) }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'tatuat-mcp-test', version: '0.0.0' },
  },
}

test('initialize răspunde cu identitatea magazinului (merchant display name nenul)', async () => {
  const { res, rpc } = await realCall(INITIALIZE)
  assert.equal(res.status, 200, rpc.error?.message ?? '')
  assert.equal(rpc.error, undefined, rpc.error?.message ?? '')
  assert.equal(rpc.result?.serverInfo?.name, 'tatuat-ro')
  assert.equal(rpc.result?.serverInfo?.title, 'TATUAT.RO')
  assert.ok(rpc.result?.instructions?.includes('RON'), 'instrucțiunile nu ajung la client')
})

/**
 * Annotations așteptate pentru un tool strict de citire — copiate din constanta
 * MĂSURATĂ pe disc (`schemas.mjs`, `READ_ONLY_ANNOTATIONS`), nu din plan.
 *
 * 🔴 PATRU câmpuri, nu trei. Planul aprobat al lucrării enumera doar
 * `readOnlyHint`/`destructiveHint`/`openWorldHint`; codul livrat are și
 * `idempotentHint`, iar acela e exact câmpul care DIFERĂ între cele două
 * constante de annotations. Un test scris din plan ar fi ratat singurul câmp
 * în plus care le deosebește.
 */
const READ_ONLY_EXPECTED = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/**
 * Setul COMPLET de tool-uri pe care serverul are voie să le expună, cu
 * annotations proprii fiecăruia.
 *
 * 🔑 De ce o tabelă și nu o afirmație uniformă: `create_checkout` e deliberat
 * asimetric. `readOnlyHint: false` fiindcă produce un artefact cu efect
 * comercial (un link care, deschis, pornește o comandă reală), iar
 * `idempotentHint: false` fiindcă fiecare apel generează un `nonce` nou, deci
 * același input produce un link DIFERIT. O buclă care ar afirma
 * `readOnlyHint === true` pe toate șase ar fi FALSĂ — și ar ascunde tocmai
 * proprietatea pe care OpenAI o verifică: annotations greșite ÎN DIRECȚIA
 * PERMISIVĂ sunt motiv de respingere.
 */
const EXPECTED_TOOLS = {
  search_products: READ_ONLY_EXPECTED,
  browse_category: READ_ONLY_EXPECTED,
  get_product: READ_ONLY_EXPECTED,
  get_stock: READ_ONLY_EXPECTED,
  calculate_shipping: READ_ONLY_EXPECTED,
  create_checkout: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}

test('tools/list expune EXACT cele 6 tool-uri, fiecare cu schemas și annotations proprii', async () => {
  const { res, rpc } = await realCall(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
  )
  assert.equal(res.status, 200, rpc.error?.message ?? '')
  assert.equal(rpc.error, undefined, rpc.error?.message ?? '')
  // JSON venit pe sârmă: forma nu e garantată de tipuri, deci e declarată ca
  // atare. Câmpurile citite mai jos sunt afirmate individual, nu presupuse.
  const tools = /** @type {Array<Record<string, any>>} */ (rpc.result?.tools ?? [])

  // Afirmație pe SETUL de nume, nu doar pe prezența fiecăruia: un tool nou
  // înregistrat fără annotations declarate aici trebuie să pice, nu să treacă
  // neobservat. Registrul expus modelului e o suprafață de securitate.
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    Object.keys(EXPECTED_TOOLS).sort(),
    'setul de tool-uri expuse diferă de cel declarat în EXPECTED_TOOLS',
  )

  for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
    const found = tools.find((t) => t.name === name)
    assert.ok(found, `${name} nu e înregistrat; înregistrate: ${tools.map((t) => t.name).join(', ')}`)
    assert.ok(found.title, `${name}: fără titlu human-readable — OpenAI îl cere explicit`)
    assert.ok(found.description, `${name}: fără descriere pentru model`)
    assert.ok(found.inputSchema, `${name}: fără inputSchema`)
    assert.ok(found.outputSchema, `${name}: fără outputSchema — OpenAI o cere explicit`)
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(
        found.annotations?.[field],
        value,
        `${name}: annotations.${field} e ${JSON.stringify(found.annotations?.[field])}, se aștepta ${JSON.stringify(value)}`,
      )
    }
  }
})
