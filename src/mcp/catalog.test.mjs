/**
 * Teste pentru construirea query-urilor PostgREST din `catalog.mjs` — fără rețea
 * și fără env real: `fetchImpl` e stubuit, iar env-ul e un obiect cu exact cele
 * două chei pe care `credentials()` le cere.
 *
 * 🔴 CE MĂSOARĂ ACEST FIȘIER: că valorile venite de la model nu pot **schimba
 * structura** filtrului PostgREST, nu doar conținutul lui.
 *
 * `productsForShipping` construiește un combinator `or=(clauza1,clauza2)`.
 * `encodeURIComponent` — singura protecție de dinainte — **NU escapează `(` și
 * `)`** (sunt „unreserved" în RFC3986), iar virgulele pe care le escapează
 * (`%2C`) sunt percent-decodate de server ÎNAINTE ca PostgREST să parseze
 * gramatica filtrului. Deci un slug ca `x),slug.eq.y,slug.in.(z` închide clauza
 * curentă, adaugă clauze paralele și redeschide una — paranteze balansate,
 * interogare sintactic validă, cu totul alt sens.
 *
 * 🔑 De ce se afirmă pe forma DECODATĂ (`searchParams.get('or')`) și nu pe
 * query string-ul brut: PostgREST percent-decodează valoarea înainte de a o
 * parsa. Un test care se uită la brut ar măsura encodarea (unde `%2C` arată
 * inofensiv), nu ce ajunge de fapt la parser.
 *
 * Trei teste sunt CONTROALE POZITIVE care trebuie să treacă și înainte și după
 * reparație (inclusiv slug cu SPAȚIU — 3 produse reale au spațiu în slug,
 * măsurat în tatuat-site/lib/route-slug.ts, deci reparația nu are voie să fie
 * un allowlist alfanumeric). Fără ele, un RED din stub greșit sau modul lipsă
 * ar arăta identic cu un defect real.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { productsForShipping } from './catalog.mjs'

/** Exact cele două chei pe care `credentials()` le cere; altfel `requireEnv` aruncă. */
const STUB_ENV = {
  SUPABASE_URL: 'https://stub.invalid',
  SUPABASE_ANON_KEY: 'stub-anon-key-not-real',
}

/**
 * Stub de `fetch` care înregistrează URL-urile cerute.
 *
 * Forma răspunsului nu e arbitrară: `select()` citește `res.text()`, face
 * `JSON.parse`, apoi verifică `res.ok`, `Array.isArray(body)` și că fiecare rând
 * e obiect. `'[]'` e minimul care trece toate aceste verificări — orice altceva
 * ar arunca `PostgrestError` și testul ar fi RED din stub, nu din defect.
 *
 * Cast-ul dublu e deliberat: stubul implementează doar suprafața pe care
 * `select()` o atinge, iar exact acea suprafață e ce testul exersează.
 */
function makeStub() {
  /** @type {string[]} */
  const urls = []
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {unknown} */ url) => {
        urls.push(String(url))
        return { ok: true, status: 200, text: async () => '[]' }
      }
    )
  )
  return { urls, fetchImpl }
}

/**
 * Valoarea combinatorului `or`, așa cum o vede PostgREST (percent-decodată).
 *
 * @param {string} url
 * @returns {string}
 */
function orOf(url) {
  const value = new URL(url).searchParams.get('or')
  assert.ok(value, `URL-ul nu are parametrul or: ${url}`)
  return /** @type {string} */ (value)
}

/**
 * @param {string} url
 * @returns {string}
 */
function limitOf(url) {
  const value = new URL(url).searchParams.get('limit')
  assert.ok(value, `URL-ul nu are parametrul limit: ${url}`)
  return /** @type {string} */ (value)
}

test('CONTROL POZITIV: un slug normal produce exact o clauză slug.in', async () => {
  const { urls, fetchImpl } = makeStub()
  await productsForShipping({ slugs: ['ace-rotative-0-35'], ids: [] }, { fetchImpl, env: STUB_ENV })

  assert.equal(urls.length, 1, 's-a făcut alt număr de cereri decât una')
  assert.equal(orOf(urls[0]), '(slug.in.(ace-rotative-0-35))')
  assert.equal(limitOf(urls[0]), '1')
})

test('CONTROL POZITIV: un slug cu SPAȚIU rămâne interogabil (nu allowlist alfanumeric)', async () => {
  // 🔴 Garda contra reparației greșite. `tatuat-site/lib/route-slug.ts` documentează
  // măsurat că 3 produse REALE au spațiu în slug. Un allowlist `[a-z0-9-]` ar
  // „rezolva" injecția excluzând produse care există — regresie funcțională reală,
  // nu teoretică. Reparația corectă e un DENYLIST pe caracterele de structură.
  const { urls, fetchImpl } = makeStub()
  await productsForShipping({ slugs: ['frost proactive 30ml'], ids: [] }, { fetchImpl, env: STUB_ENV })

  assert.equal(urls.length, 1)
  assert.equal(orOf(urls[0]), '(slug.in.(frost proactive 30ml))')
  // Spațiul călătorește encodat prin URL, chiar dacă valoarea decodată îl conține.
  assert.ok(urls[0].includes('%20'), 'spațiul nu e encodat în URL')
})

test('CONTROL POZITIV: id-urile numerice produc clauza id.in', async () => {
  const { urls, fetchImpl } = makeStub()
  await productsForShipping({ slugs: [], ids: [1, 2] }, { fetchImpl, env: STUB_ENV })

  assert.equal(urls.length, 1)
  assert.equal(orOf(urls[0]), '(id.in.(1,2))')
  assert.equal(limitOf(urls[0]), '2')
})

test('un slug care închide combinatorul nu poate adăuga clauze OR', async () => {
  const { urls, fetchImpl } = makeStub()
  // Paranteze balansate, deci interogarea ar fi VALIDĂ pentru PostgREST: închide
  // `slug.in.(`, adaugă `slug.eq.y` ca a doua clauză a lui `or`, redeschide un
  // `slug.in.(` pentru paranteza finală generată de noi.
  const rows = await productsForShipping(
    { slugs: ['x),slug.eq.y,slug.in.(z'], ids: [] },
    { fetchImpl, env: STUB_ENV },
  )

  for (const url of urls) {
    assert.equal(
      orOf(url).includes('slug.eq.'),
      false,
      `slug-ul a injectat o clauză pe care codul nostru nu o construiește niciodată: ${orOf(url)}`,
    )
  }
  // Slugul e singurul din cerere și e imposibil de reprezentat într-o listă
  // `in.(…)` necitată — deci nu rămâne nimic de interogat. Zero cereri, nu
  // `or=()`, care ar fi o interogare malformată trimisă serverului.
  assert.equal(urls.length, 0, 's-a trimis o cerere deși nu rămăsese niciun filtru valid')
  assert.deepEqual(rows, [])
})

test('o virgulă singură în slug nu poate lărgi lista de valori', async () => {
  const { urls, fetchImpl } = makeStub()
  // Fără nicio paranteză: `slug.in.(a,b)` ar căuta DOUĂ slug-uri în loc de unul.
  // Nu e o eroare de sintaxă, e o lărgire tăcută a interogării — exact tipul de
  // defect care nu se vede în log-uri.
  const rows = await productsForShipping({ slugs: ['a,b'], ids: [] }, { fetchImpl, env: STUB_ENV })

  assert.equal(urls.length, 0, 'slug-ul cu virgulă a ajuns în filtru')
  assert.deepEqual(rows, [])
})

test('un slug nesigur e eliminat, restul cererii rămâne intactă', async () => {
  const { urls, fetchImpl } = makeStub()
  await productsForShipping(
    { slugs: ['ace-bune', 'x),slug.eq.y'], ids: [7] },
    { fetchImpl, env: STUB_ENV },
  )

  assert.equal(urls.length, 1)
  assert.equal(orOf(urls[0]), '(slug.in.(ace-bune),id.in.(7))')
  // `limit` se calculează din valorile care au rămas efectiv în filtru, nu din
  // cele cerute: un `limit` de 3 pe două valori ar fi o cifră fără referent.
  assert.equal(limitOf(urls[0]), '2')
})
