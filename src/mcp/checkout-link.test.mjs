/**
 * Teste pentru semnarea/verificarea link-ului de checkout — modul pur, fără
 * rețea și fără env: secretul e un string inventat, injectat direct.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_CART_PATH,
  buildCheckoutUrl,
  signCheckoutPayload,
  verifyCheckoutLink,
  decodeCheckoutPayload,
  verifyCheckoutSignature,
} from './checkout-link.mjs'

const SECRET = 'test-hmac-secret-not-real'
const ORIGIN = 'https://tatuat.ro'

/** @type {{ product_id: number, variant_id: number | null, qty: number, options: Record<string,string> }[]} */
const ITEMS = [{ product_id: 101, variant_id: null, qty: 2, options: {} }]

function futureExp(offsetSecs = 900) {
  return Math.floor(Date.now() / 1000) + offsetSecs
}

/** @param {string} url */
function paramsOf(url) {
  const u = new URL(url)
  const c = u.searchParams.get('c')
  const sig = u.searchParams.get('sig')
  assert.ok(c, 'linkul nu are parametrul c')
  assert.ok(sig, 'linkul nu are parametrul sig')
  return { c: /** @type {string} */ (c), sig: /** @type {string} */ (sig) }
}

/**
 * Mută un token base64url astfel încât **VALOAREA DECODATĂ** să se schimbe, și
 * afirmă că s-a schimbat.
 *
 * 🔑 De ce primul caracter și nu ultimul: în base64 primul caracter poartă toți
 * cei 6 biți semnificativi ai primului octet, deci orice schimbare a lui schimbă
 * octeții. **Ultimul** caracter poartă, în funcție de `len % 4`, doar 4 sau chiar
 * 2 biți semnificativi — restul e umplutură, iar un flip acolo poate fi no-op pe
 * octeți. De aici venea nedeterminismul: un test „manipulat → respins" care
 * mută ultimul caracter testează, în ~1/16 din rulări, cu totul altă proprietate
 * (non-canonicitatea encodării), și cade dacă implementarea o acceptă.
 *
 * Garda de mai jos e miezul lecției: un test de mutație trebuie să afirme că s-a
 * schimbat **valoarea**, nu scrierea ei. `assert.notEqual(mutat, original)` pe
 * string-uri e o gardă care nu poate prinde un no-op.
 *
 * @param {string} token base64url
 * @returns {string} același token cu valoarea decodată schimbată
 */
function mutaValoarea(token) {
  const primul = token[0]
  const inlocuitor = primul === 'A' ? 'B' : 'A'
  const mutat = inlocuitor + token.slice(1)
  assert.notEqual(mutat, token, 'string-ul nu s-a schimbat — testul nu măsoară')
  assert.equal(
    Buffer.from(mutat, 'base64url').equals(Buffer.from(token, 'base64url')),
    false,
    'mutația e NO-OP pe octeți — testul ar măsura non-canonicitatea, nu falsificarea',
  )
  return mutat
}

// ─── CALEA LINKULUI: DE CE NU `/checkout` ─────────────────────────────────────────
// Verificat 29.09.2026 în sursă, pe ambele platforme:
//   • iOS — `public/.well-known/apple-app-site-association` din tatuat-site revendică `/checkout`
//     (378 de căi EXACTE pentru appID 4HK8M5U243.ro.tatuat.TATUAT-RO, plus 51 cu wildcard);
//   • Android — `mobile/app.json`, `intentFilters` cu `autoVerify: true`, conține `/checkout`,
//     `/en/checkout` și `/hu/checkout` (660 de căi exacte și 102 `pathPrefix`).
//
// 🔴 Aplicația NU citește `c`/`sig` (`mobile/app/checkout.tsx`). Deci linkul emis aici, apăsat
// într-o conversație ChatGPT pe un telefon cu aplicația instalată, DESCHIDE APLICAȚIA — care își
// arată propriul coș, gol — fără nicio eroare și fără niciun indiciu. Coșul construit în conversație
// dispare tăcut, exact pe canalul pe care trăiește acest tool. Nu e un caz marginal: telefonul e
// locul normal în care cineva citește un răspuns de chat.
//
// De aceea linkul pleacă pe o cale NEREVENDICATĂ de niciuna dintre cele două liste. Site-ul o preia,
// pune produsele în coș și trece la `/checkout` printr-o navigare CLIENT-SIDE — care nu e o încărcare
// nouă de document, deci nu re-declanșează nici universal link (iOS), nici App Link (Android).
//
// ⚠️ Generatorul de revendicări (`tatuat-aplicatie-noua/scripts/deep-link-claims.mjs`) derivă lista
// din arborele APLICAȚIEI, nu din al site-ului — deci o rută nouă pe site nu se auto-revendică. Dacă
// vreodată apare un ecran de aplicație cu acest nume, calea redevine revendicată; garda care prinde
// asta stă în site (`lib/agent-cart-path.test.mjs`), unde fișierul AASA chiar există pe disc.
test('linkul NU pleacă pe o cale revendicată de aplicația mobilă', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { pathname } = new URL(url)

  assert.equal(pathname, AGENT_CART_PATH, `linkul nu folosește calea agentului: ${pathname}`)
  // Literalul e fixat aici ca o redenumire să nu poată fi tăcută: ruta trăiește în CELĂLALT repo
  // (tatuat-site, `app/cos-din-conversatie/`), care se deployează separat. Schimbată doar aici,
  // linkul ar duce la 404 — o pagină goală, nu o eroare pe care cineva s-o observe în teste.
  assert.equal(AGENT_CART_PATH, '/cos-din-conversatie')
  // Verbatim din AASA și din `intentFilters`, nu parafrazate.
  for (const revendicat of ['/checkout', '/en/checkout', '/hu/checkout']) {
    assert.notEqual(
      pathname,
      revendicat,
      `calea e revendicată de aplicația mobilă, care nu știe să citească c/sig: ${pathname}`,
    )
  }
})

test('round-trip: link generat de noi trece verificarea (CONTROL POZITIV)', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  const result = verifyCheckoutLink({ c, sig, secret: SECRET })
  assert.equal(result.valid, true)
  assert.deepEqual(result.valid ? result.payload.items : null, ITEMS)
})

test('payload manipulat (un bit schimbat) → respins', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  // CONTROL POZITIV — dacă asta cade, testul de mai jos nu măsoară nimic.
  assert.equal(verifyCheckoutLink({ c, sig, secret: SECRET }).valid, true)

  assert.equal(verifyCheckoutLink({ c: mutaValoarea(c), sig, secret: SECRET }).valid, false)
})

test('sig manipulat → respins', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  assert.equal(verifyCheckoutLink({ c, sig, secret: SECRET }).valid, true) // CONTROL POZITIV

  // Proprietatea măsurată aici e strict: **altă valoare de semnătură → respinsă**.
  // Non-canonicitatea (alt string, ACEEAȘI valoare) are testul ei separat mai jos —
  // două proprietăți distincte, două teste, ca un eșec să spună CARE a căzut.
  assert.equal(verifyCheckoutLink({ c, sig: mutaValoarea(sig), secret: SECRET }).valid, false)
})

/**
 * Găsește DETERMINIST (fără `randomBytes`) un payload a cărui semnătură se
 * termină cu 'A'. O semnătură HMAC-SHA256 are 32 de octeți = 256 de biți, dar
 * base64url o scrie în 43 de caractere = 258 de biți: **ultimul caracter are
 * doar 4 biți semnificativi și 2 de umplutură**, deci patru caractere distincte
 * (`A`,`B`,`C`,`D` — măsurat: 16 clase de câte 4) decodează la același octet.
 *
 * De aceea un flip `'A'→'B'` pe ultimul caracter e o mutație de STRING fără
 * niciun efect pe OCTEȚI — motivul pentru care testele de mai sus au fost
 * nedeterministe: cădeau exact când semnătura se termina în 'A' (≈1/16 din
 * rulări, măsurat 4,5% pe 200 de eșantioane).
 */
function payloadCuSigNonCanonicabila() {
  for (let n = 0; n < 500; n += 1) {
    const payload = { items: ITEMS, nonce: `nonce-determinist-${n}`, exp: 2_000_000_000 }
    const { c, sig } = signCheckoutPayload(payload, SECRET)
    if (sig.at(-1) === 'A') return { c, sig }
  }
  throw new Error('niciun nonce cu sig terminat în A în 500 de încercări — testul nu poate rula')
}

test('sig NON-CANONIC (alt string, ACEIAȘI octeți) → respins', () => {
  const { c, sig } = payloadCuSigNonCanonicabila()
  assert.equal(verifyCheckoutSignature(c, sig, SECRET), true) // CONTROL POZITIV

  const variant = `${sig.slice(0, -1)}B`
  assert.notEqual(variant, sig, 'stringul nu s-a schimbat — testul nu măsoară')
  // 🔑 Controlul care LIPSEA din testele de manipulare: aici se afirmă că mutația
  // e no-op pe octeți. Fără el, un test „manipulat → respins" nu știe dacă a
  // schimbat valoarea sau doar scrierea ei.
  assert.ok(
    Buffer.from(variant, 'base64url').equals(Buffer.from(sig, 'base64url')),
    'presupunerea testului a căzut: octeții DIFERĂ, deci nu se mai testează non-canonicitatea',
  )

  // Serverul emite o singură formă a semnăturii. Acceptând patru, ar accepta un
  // șir pe care nu l-a produs niciodată — malleabilitate: 4 link-uri distincte
  // cu aceeași semnătură „validă", periculos în orice dedup care cheie pe `sig`.
  assert.equal(verifyCheckoutSignature(c, variant, SECRET), false)
})

test('sig cu padding `=` sau alfabet base64 clasic → respins (encodare pe care n-o emitem)', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  assert.equal(verifyCheckoutSignature(c, sig, SECRET), true) // CONTROL POZITIV

  assert.equal(verifyCheckoutSignature(c, `${sig}=`, SECRET), false)
  assert.equal(verifyCheckoutSignature(c, `${sig}==`, SECRET), false)
  // base64 clasic: `-`→`+` și `_`→`/`. Aceiași octeți, alfabet diferit.
  const clasic = sig.replaceAll('-', '+').replaceAll('_', '/')
  if (clasic !== sig) {
    assert.ok(
      Buffer.from(clasic, 'base64url').equals(Buffer.from(sig, 'base64url')),
      'presupunerea testului a căzut: alfabetul clasic nu decodează la aceiași octeți',
    )
    assert.equal(verifyCheckoutSignature(c, clasic, SECRET), false)
  }
})

test('exp expirat → respins', () => {
  const past = Math.floor(Date.now() / 1000) - 10
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: past, secret: SECRET })
  const { c, sig } = paramsOf(url)
  // CONTROL POZITIV — semnătura în sine e validă, doar exp-ul a picat.
  assert.equal(verifyCheckoutSignature(c, sig, SECRET), true)
  const result = verifyCheckoutLink({ c, sig, secret: SECRET })
  assert.equal(result.valid, false)
  assert.equal(result.valid ? null : result.reason, 'expired')
})

test('nonce prezent și diferit între două apeluri', () => {
  const a = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const b = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  assert.ok(typeof a.payload.nonce === 'string' && a.payload.nonce.length > 0)
  assert.ok(typeof b.payload.nonce === 'string' && b.payload.nonce.length > 0)
  assert.notEqual(a.payload.nonce, b.payload.nonce)
})

test('c și sig sunt base64url: fără +, /, =', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  for (const token of [c, sig]) {
    assert.equal(token.includes('+'), false, `token conține '+': ${token}`)
    assert.equal(token.includes('/'), false, `token conține '/': ${token}`)
    assert.equal(token.includes('='), false, `token conține '=': ${token}`)
  }
})

test('timingSafeEqual nu aruncă pe lungimi diferite (sig scurt și sig lung)', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  // CONTROL POZITIV — sig-ul corect trece.
  assert.equal(verifyCheckoutSignature(c, sig, SECRET), true)

  assert.doesNotThrow(() => verifyCheckoutSignature(c, 'AA', SECRET))
  assert.equal(verifyCheckoutSignature(c, 'AA', SECRET), false)

  const long = sig + sig + sig
  assert.doesNotThrow(() => verifyCheckoutSignature(c, long, SECRET))
  assert.equal(verifyCheckoutSignature(c, long, SECRET), false)
})

test('secret greșit → semnătura nu verifică (control pozitiv pe secretul corect)', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c, sig } = paramsOf(url)
  assert.equal(verifyCheckoutSignature(c, sig, SECRET), true) // CONTROL POZITIV
  assert.equal(verifyCheckoutSignature(c, sig, 'alt-secret-total-diferit'), false)
})

test('decodeCheckoutPayload întoarce items/nonce/exp pe un payload valid', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c } = paramsOf(url)
  const decoded = decodeCheckoutPayload(c)
  assert.ok(decoded)
  assert.deepEqual(decoded?.items, ITEMS)
  assert.equal(typeof decoded?.nonce, 'string')
  assert.equal(typeof decoded?.exp, 'number')
})

test('decodeCheckoutPayload pe base64url invalid → null, nu excepție', () => {
  assert.doesNotThrow(() => decodeCheckoutPayload('%%% nu e base64url %%%'))
  assert.equal(decodeCheckoutPayload('%%% nu e base64url %%%'), null)
})

test('niciun preț în payload-ul decodat', () => {
  const { url } = buildCheckoutUrl(ORIGIN, { items: ITEMS, exp: futureExp(), secret: SECRET })
  const { c } = paramsOf(url)
  const decoded = decodeCheckoutPayload(c)
  const raw = JSON.stringify(decoded)
  assert.equal(raw.includes('price'), false, 'a scurs un preț în payload-ul de checkout')
})
