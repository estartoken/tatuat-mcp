/**
 * GATE STRUCTURAL — „fiecare tool trece prin `guarded`".
 *
 * De ce există: `guarded` NU e structural. Se aplică prin APEL EXPLICIT în
 * corpul fiecărui tool (`return guarded(async () => …)`). Toate cele șase
 * tool-uri de azi o fac, dar nimic nu obligă al șaptelea: un tool care omite
 * apelul lasă excepția să iasă din handler, iar `err.message` — care la o
 * eroare de configurare conține NUMELE variabilei de mediu — pleacă spre model.
 * Punctul 7 din `HANDOFF-MCP-SESIUNE-3c-29-09.md`.
 *
 * Cum prinde omisiunea: tool-urile se DESCOPERĂ de pe disc, nu se enumeră aici.
 * Fiecare primește un `fetchImpl` care aruncă un canar și un mediu FĂRĂ
 * `AGENT_CHECKOUT_SECRET`, deci fiecare ajunge garantat pe o cale de eroare.
 * Un tool nou fără intrare în `INPUTURI` pică gate-ul în loc să fie sărit tăcut.
 *
 * ⚠️ Mesajele canonice NU sunt rescrise aici. Se obțin RULÂND `guarded` pe
 * fiecare tip de eroare — un test care le-ar retipări ar putea pica pe forma
 * Unicode a diacriticelor (ș U+0219 vs ş U+015F) fără ca nimic să fie stricat.
 *
 * ⚠️ Discriminant: gate-ul e rulat și pe două module-fixture scrise în
 * `os.tmpdir()` — unul FĂRĂ `guarded` (trebuie să PICE) și unul CU (trebuie să
 * treacă). Fără controlul negativ, un gate care nu verifică nimic ar fi verde.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { guarded } from '../tool-result.mjs'
import { PostgrestError } from '../postgrest.mjs'
import { RateLimitError } from '../rate-limit.mjs'
import { McpConfigError } from '../env.mjs'

const AICI = dirname(fileURLToPath(import.meta.url))
const URL_TOOL_RESULT = pathToFileURL(join(AICI, '..', 'tool-result.mjs')).href

/** Marker care NU trebuie să apară niciodată în răspunsul întors modelului. */
const CANAR = 'CANAR_SCURGERE_sk-live-nu-e-o-cheie-reala'

/**
 * Mediu fals, fără `AGENT_CHECKOUT_SECRET`: `create_checkout` nu face fetch,
 * deci singura lui cale de eroare garantată e configurarea lipsă.
 */
const MEDIU_FARA_SECRET = { TATUAT_SITE_URL: 'https://tatuat.ro' }

/** Substringuri interzise în orice răspuns: canarul și numele variabilei de mediu. */
const INTERZISE = [CANAR, 'AGENT_CHECKOUT_SECRET', 'SUPABASE']

/**
 * Cele patru texte pe care `guarded` are voie să le întoarcă, citite din codul
 * real prin rulare, nu retipărite.
 *
 * @param {unknown} err
 * @returns {Promise<string>}
 */
async function mesajulLui(err) {
  const rezultat = await guarded(async () => {
    throw err
  })
  return rezultat.content[0].text
}

const MESAJE_CANONICE = new Set(
  await Promise.all([
    mesajulLui(new RateLimitError('cheie')),
    mesajulLui(new PostgrestError('detaliu intern care nu are voie să iasă')),
    mesajulLui(new McpConfigError('AGENT_CHECKOUT_SECRET')),
    mesajulLui(new Error(CANAR)),
  ]),
)

/**
 * Inputuri minime valide, unul per tool. Cheia e `name`-ul exportat de modul.
 * Un tool nou apărut pe disc fără intrare aici PICĂ gate-ul — intenționat.
 *
 * `calculate_shipping` primește `lines`, nu `subtotal`: cu `subtotal` tool-ul
 * nu atinge deloc catalogul și n-ar mai ajunge pe nicio cale de eroare.
 *
 * @type {Record<string, Record<string, unknown>>}
 */
const INPUTURI = {
  search_products: { query: 'ace', limit: 5 },
  browse_category: { category_id: null, sort: 'popular', limit: 5, offset: 0 },
  get_product: { slug: 'ace-rotative-0-35' },
  get_stock: { slug: 'ace-rotative-0-35', qty: 1 },
  calculate_shipping: { lines: [{ slug: 'ace-rotative-0-35', quantity: 1 }] },
  create_checkout: { items: [{ product_id: 101, variant_id: null, qty: 1, options: {} }] },
}

/** Modulele de tool, descoperite de pe disc (fără fișierele de test). */
const FISIERE_TOOL = readdirSync(AICI)
  .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
  .sort()

const MODULE = await Promise.all(
  FISIERE_TOOL.map(async (fisier) => ({
    fisier,
    mod: await import(pathToFileURL(join(AICI, fisier)).href),
  })),
)

/**
 * Rulează un tool pe o cale de eroare garantată și verifică tot ce trebuie să
 * fie adevărat despre răspuns. Aruncă dacă tool-ul nu e gardat.
 *
 * @param {{ createHandler: (deps?: Record<string, unknown>) => (args: Record<string, unknown>, ctx?: { sessionId?: string }) => Promise<import('../tool-result.mjs').ToolResult> }} mod
 * @param {Record<string, unknown>} input
 * @param {string} eticheta
 */
async function verificaGardat(mod, input, eticheta) {
  /** @type {unknown[]} */
  const erori = []
  const handler = mod.createHandler({
    env: MEDIU_FARA_SECRET,
    fetchImpl: () => {
      throw new Error(CANAR)
    },
    /** @param {unknown} err */
    onError: (err) => erori.push(err),
  })

  // Dacă tool-ul omite `guarded`, apelul RESPINGE aici și testul pică — exact
  // omisiunea pe care gate-ul o caută.
  const rezultat = await handler(input, { sessionId: 'gate-guard-coverage' })

  assert.equal(rezultat.isError, true, `${eticheta}: eroarea n-a fost raportată ca eroare`)
  assert.equal(
    rezultat.structuredContent,
    undefined,
    `${eticheta}: un eșec nu are voie să ducă date structurate`,
  )

  const text = rezultat.content[0].text
  assert.ok(
    MESAJE_CANONICE.has(text),
    `${eticheta}: textul întors nu e unul dintre mesajele canonice ale lui guarded: ${JSON.stringify(text)}`,
  )

  const tot = JSON.stringify(rezultat)
  for (const interzis of INTERZISE) {
    assert.ok(!tot.includes(interzis), `${eticheta}: răspunsul scurge „${interzis}"`)
  }

  // Discriminant: fără asta, un tool care întoarce isError FĂRĂ să fi aruncat
  // ceva ar trece vacuu. `guarded` cheamă `onError` exact pe calea prinsă.
  assert.ok(erori.length >= 1, `${eticheta}: onError n-a fost chemat — nicio eroare n-a fost prinsă`)
}

test('contract: fiecare modul de tool exportă name, config, createHandler și register', () => {
  assert.ok(MODULE.length > 0, 'niciun modul de tool descoperit — calea de descoperire e greșită')
  for (const { fisier, mod } of MODULE) {
    assert.equal(typeof mod.name, 'string', `${fisier}: lipsește exportul name`)
    assert.ok(mod.name.length > 0, `${fisier}: name e gol`)
    assert.equal(typeof mod.config, 'object', `${fisier}: lipsește exportul config`)
    assert.equal(typeof mod.createHandler, 'function', `${fisier}: lipsește createHandler`)
    assert.equal(typeof mod.register, 'function', `${fisier}: lipsește register`)
  }
})

test('acoperire: mulțimea tool-urilor de pe disc coincide cu cea din INPUTURI', () => {
  const peDisc = MODULE.map(({ mod }) => mod.name).sort()
  const acoperite = Object.keys(INPUTURI).sort()
  assert.deepEqual(
    peDisc,
    acoperite,
    'un tool nou trebuie adăugat în INPUTURI ca să fie verificat, nu sărit tăcut',
  )
})

for (const { fisier, mod } of MODULE) {
  test(`${mod.name}: excepția e prinsă de guarded, fără scurgere spre model (${fisier})`, async () => {
    const input = INPUTURI[mod.name]
    assert.ok(input, `${mod.name}: fără input în INPUTURI`)
    await verificaGardat(mod, input, mod.name)
  })
}

test('CONTROL NEGATIV: un tool care omite guarded PICĂ același gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tatuat-guard-gate-'))
  const cale = join(dir, 'fake-nengardat.mjs')
  writeFileSync(
    cale,
    [
      "export const name = 'fake_nengardat'",
      "export const config = { title: 'fixture' }",
      'export function createHandler(deps = {}) {',
      '  return async function handler() {',
      '    await deps.fetchImpl()',
      '    return { content: [] }',
      '  }',
      '}',
    ].join('\n'),
  )
  const mod = await import(pathToFileURL(cale).href)

  await assert.rejects(
    () => verificaGardat(mod, {}, 'fake_nengardat'),
    /CANAR_SCURGERE/,
    'gate-ul a lăsat să treacă un tool fără guarded',
  )
})

test('CONTROL POZITIV: un tool fixture CU guarded trece gate-ul', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tatuat-guard-gate-'))
  const cale = join(dir, 'fake-gardat.mjs')
  writeFileSync(
    cale,
    [
      `import { guarded } from ${JSON.stringify(URL_TOOL_RESULT)}`,
      "export const name = 'fake_gardat'",
      "export const config = { title: 'fixture' }",
      'export function createHandler(deps = {}) {',
      '  return async function handler() {',
      '    return guarded(async () => {',
      '      await deps.fetchImpl()',
      '      return { content: [] }',
      '    }, { onError: deps.onError })',
      '  }',
      '}',
    ].join('\n'),
  )
  const mod = await import(pathToFileURL(cale).href)

  await verificaGardat(mod, {}, 'fake_gardat')
})
