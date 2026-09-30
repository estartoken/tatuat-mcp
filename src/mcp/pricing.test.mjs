/**
 * Teste pentru prețul afișat modelului la produsele CU VARIANTE.
 *
 * 🔴 DEFECTUL MĂSURAT ÎN PRODUCȚIE (29.09.2026, api.tatuat.ro). La produsele cu variante,
 * `v_products_with_pricing.price` e 0 — prețul real stă pe variantă. `effectivePrice` citea doar
 * `price`/`sale_price`, deci `search_products` întorcea literal `price: 0, currency: "RON"`.
 * Un model care citește asta îi spune clientului că produsul e GRATIS. Două produse reale:
 *
 *   ace-de-tatuat-cartus-limited-rl   price=0, cele 19 variante toate 5.70  → „5.70 RON"
 *   ace-de-tatuat-cartus-pro-plus-rm  price=0, variantele 3.97 … 6.97       → „de la 3.97 RON"
 *
 * 🔑 DE CE NU E DE AJUNS SĂ PUNEM `from_price` ȘI GATA. Cele două cazuri de mai sus arată
 * DIFERIT pentru client. La al doilea, „3.97 RON" fără „de la" e o minciună: clientul care alege
 * altă variantă plătește până la 6.97. De-asta cardul poartă și `price_from`, iar testele de mai
 * jos cer AMBELE — un fix care întoarce cifra corectă fără eticheta corectă rămâne un fix fals.
 *
 * Regula e PORTATĂ, nu inventată: `effectivePrice` din `tatuat-site/lib/queries.ts:49-58`, cu
 * comentariul de acolo — „la produsele cu VARIANTE se taxează prețul variantei — afișăm «de la»
 * prețul real al variantelor, nu prețul de bază al produsului (afișat ≠ taxat)". Ordinea ramurilor
 * contează: varianta bate promoția pe produsul de bază, nu invers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { effectivePrice } from './format.mjs'
import { toProductCard, summaryLine } from './schemas.mjs'

const ctx = { origin: 'https://tatuat.ro' }

/** Rând de catalog minim valid; `extra` suprascrie ce interesează testul. */
const rand = (/** @type {Record<string, unknown>} */ extra) => ({
  id: 1,
  slug: 'produs',
  name: 'Produs',
  price: null,
  sale_price: null,
  from_price: null,
  from_price_was: null,
  from_price_max: null,
  variant_count: 0,
  in_stock: true,
  ...extra,
})

// ─────────────────────────────────────────────────────────────────────────────
// Cele două produse reale, exact cum arată rândurile lor în catalog.
// ─────────────────────────────────────────────────────────────────────────────

test('produs cu variante uniforme: prețul e cel al variantei, NU 0, și nu e „de la"', () => {
  // ace-de-tatuat-cartus-limited-rl — 19 variante, toate 5.70.
  const row = rand({
    slug: 'ace-de-tatuat-cartus-limited-rl',
    price: 0,
    from_price: 5.7,
    from_price_max: 5.7,
    variant_count: 19,
  })
  const card = toProductCard(row, ctx)
  assert.ok(card, 'rândul e valid, cardul nu trebuie să fie null')
  assert.equal(card.price, 5.7, 'prețul trebuie să fie al variantei, nu 0')
  assert.equal(card.price_from, false, 'variantele costă la fel — „de la" ar fi derutant')
  assert.match(summaryLine(card), /5\.70 RON/)
  assert.doesNotMatch(summaryLine(card), /de la/, 'nu se anunță „de la" la preț uniform')
})

test('produs cu variante la prețuri DIFERITE: cel mai mic preț, marcat „de la"', () => {
  // ace-de-tatuat-cartus-pro-plus-rm — variantele între 3.97 și 6.97.
  const row = rand({
    slug: 'ace-de-tatuat-cartus-pro-plus-rm',
    price: 0,
    from_price: 3.97,
    from_price_max: 6.97,
    variant_count: 4,
  })
  const card = toProductCard(row, ctx)
  assert.ok(card)
  assert.equal(card.price, 3.97, 'cel mai mic preț dintre variante')
  assert.equal(card.price_from, true, 'variantele diferă — clientul trebuie să știe că e un minim')
  assert.match(summaryLine(card), /de la 3\.97 RON/)
})

test('🔴 ZERO nu mai iese NICIODATĂ ca preț când produsul are variante cu preț', () => {
  // Aserțiunea care prinde regresia în forma ei exactă: cifra pe care o citea modelul era `0`.
  for (const vc of [1, 4, 19]) {
    const card = toProductCard(rand({ price: 0, from_price: 5.7, variant_count: vc }), ctx)
    assert.ok(card)
    assert.notEqual(card.price, 0, `variant_count=${vc}: 0 RON înseamnă „gratis" pentru model`)
    assert.equal(card.price, 5.7)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Ordinea ramurilor — partea pe care un fix naiv o greșește.
// ─────────────────────────────────────────────────────────────────────────────

test('varianta bate prețul de bază NENUL — se taxează varianta, nu produsul', () => {
  // Cazul în care produsul are și `price`, și variante. Site-ul alege varianta (queries.ts:52),
  // fiindcă asta se taxează efectiv la checkout. Un fix care pune `from_price` doar ca fallback
  // pe `price === 0` ar întoarce aici 100 — un preț pe care nimeni nu-l plătește.
  const card = toProductCard(
    rand({ price: 100, from_price: 42, from_price_max: 90, variant_count: 3 }),
    ctx,
  )
  assert.ok(card)
  assert.equal(card.price, 42, 'prețul taxat e al variantei, nu cel de bază')
  // ⚠️ AICI ne despărțim INTENȚIONAT de site: `ProductCard.tsx:120` n-ar pune „de la", fiindcă cere
  // în plus ca prețul de bază să lipsească. Dar variantele chiar merg 42…90, deci 42 chiar e un
  // minim, iar într-un canal unde un model repetă eticheta ca afirmație, adevărul bate paritatea.
  // Dacă cineva „restaurează paritatea" ștergând asta, reintroduce o afirmație falsă. Vezi format.mjs.
  assert.equal(card.price_from, true, 'variantele merg până la 90 — 42 e un minim, nu un preț exact')
})

test('„de la" și „redus de la" pot apărea împreună, fără să se contrazică', () => {
  // Combinație posibilă logic (variante 3.97…6.97, cea mai ieftină redusă de la 5.00) pe care
  // niciun alt test n-o exercita. Ambele etichete sunt adevărate simultan și trebuie să se citească
  // ca o singură propoziție coerentă, nu ca două prețuri concurente.
  const card = toProductCard(
    rand({ price: 0, from_price: 3.97, from_price_was: 5, from_price_max: 6.97, variant_count: 4 }),
    ctx,
  )
  assert.ok(card)
  assert.equal(card.price_from, true)
  assert.equal(card.price_before, 5)
  assert.match(summaryLine(card), /de la 3\.97 RON · \(redus de la 5\.00 RON\)/)
})

test('reducerea pe VARIANTĂ se anunță ca „redus de la", din from_price_was', () => {
  const card = toProductCard(
    rand({ price: 0, from_price: 30, from_price_was: 50, from_price_max: 30, variant_count: 5 }),
    ctx,
  )
  assert.ok(card)
  assert.equal(card.price, 30)
  assert.equal(card.price_before, 50, 'prețul dinainte vine din from_price_was la produse cu variante')
})

test('from_price_was care NU e o reducere reală nu inventează o promoție', () => {
  const card = toProductCard(
    rand({ price: 0, from_price: 30, from_price_was: 30, from_price_max: 30, variant_count: 5 }),
    ctx,
  )
  assert.ok(card)
  assert.equal(card.price_before, null, 'from_price_was <= from_price nu e reducere')
})

test('from_price_was MAI MIC decât prețul curent nu devine „reducere" pe dos', () => {
  // 🔴 Găsit prin mutație: `fromWas > fromPrice` slăbit la `fromWas !== fromPrice` trecea toate
  // testele. Cu el, un produs care s-a SCUMPIT (era 20, acum 30) ar fi anunțat drept „redus de la
  // 20.00 RON" — o promoție inventată, și încă una inversată: prețul „dinainte" sub cel curent.
  const card = toProductCard(
    rand({ price: 0, from_price: 30, from_price_was: 20, from_price_max: 30, variant_count: 5 }),
    ctx,
  )
  assert.ok(card)
  assert.equal(card.price_before, null, 'un preț anterior MAI MIC nu e o reducere')
  assert.doesNotMatch(summaryLine(card), /redus de la/)
})

test('variant_count LIPSĂ se citește ca 0, nu ca „are variante"', () => {
  // 🔴 Găsit prin mutație: `?? 0` schimbat în `?? 1` trecea toate testele — adică orice rând
  // căruia îi lipsește coloana ar fi fost tratat ca având variante, iar `from_price` ar fi
  // înlocuit prețul de bază real. Coloana chiar poate lipsi: nu toate căile de citire o cer.
  const { variant_count: _omis, ...faraColoana } = rand({ price: 100, from_price: 42, from_price_max: 90 })
  const card = toProductCard(faraColoana, ctx)
  assert.ok(card)
  assert.equal(card.price, 100, 'coloană absentă ⇒ presupunem „fără variante", nu invers')
  assert.equal(card.price_from, false)
})

test('from_price_max necunoscut (null) ⇒ marcăm „de la", prudent', () => {
  // Nu putem dovedi că variantele costă la fel, iar greșeala ieftină e „de la" în plus;
  // greșeala scumpă e un preț exact anunțat greșit. Aceeași alegere ca în ProductCard.tsx:120.
  const card = toProductCard(rand({ price: 0, from_price: 9, from_price_max: null, variant_count: 2 }), ctx)
  assert.ok(card)
  assert.equal(card.price_from, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// Controale POZITIVE: fixul nu are voie să strice produsele simple.
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL: produsul simplu rămâne neatins, fără „de la"', () => {
  const card = toProductCard(rand({ price: 2700, variant_count: 0 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 2700)
  assert.equal(card.price_before, null)
  assert.equal(card.price_from, false, 'un produs fără variante n-are de ce să fie „de la"')
  assert.doesNotMatch(summaryLine(card), /de la/)
})

test('CONTROL: promoția pe produs simplu se păstrează exact ca înainte', () => {
  const card = toProductCard(rand({ price: 100, sale_price: 70, variant_count: 0 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 70)
  assert.equal(card.price_before, 100)
  assert.equal(card.price_from, false)
})

test('CONTROL: produs fără niciun preț rămâne null, nu devine 0', () => {
  const card = toProductCard(rand({ price: null, variant_count: 0 }), ctx)
  assert.ok(card)
  assert.equal(card.price, null, 'absent ≠ gratis')
  assert.equal(card.price_from, false)
})

test('🔴 from_price ZERO nu e un preț — nu devine „de la 0.00 RON"', () => {
  // Găsit prin testare de mutație: slăbirea gărzii `from_price > 0` la `!== null` nu pica niciun
  // test, fiindcă toate controalele foloseau `from_price: null`. Dar `from_price` e MIN-ul
  // prețurilor de variantă, iar o variantă fără preț setat îl duce la 0 — exact regresia de la
  // care a pornit tot fixul, doar pe altă coloană, și de data asta ETICHETATĂ „de la", ceea ce o
  // face să pară deliberată.
  const card = toProductCard(rand({ price: 0, from_price: 0, from_price_max: 9, variant_count: 3 }), ctx)
  assert.ok(card)
  assert.equal(card.price_from, false, '0 nu e un minim credibil — nu se anunță „de la"')
  assert.doesNotMatch(summaryLine(card), /de la 0/)
})

test('produs cu variante dar FĂRĂ from_price: rămâne 0, prin decizie explicită a owner-ului', () => {
  // ⚠️ DECIZIE A OWNER-ULUI, 30.09.2026 — nu o schimba fără să-l întrebi din nou.
  //
  // Comentariul care stătea aici („nu-l fabricăm") se contrazicea singur: `0` ESTE un preț
  // fabricat, spre deosebire de `null`. Asimetria e reală și cunoscută:
  //   produs SIMPLU fără preț          → null → „preț indisponibil"
  //   produs CU VARIANTE fără from_price → 0  → „0.00 RON"
  // Adică exact bugul „gratis" de la care a pornit tot fixul, pe o cale ocolitoare: `from_price`
  // lipsă sau 0 nu intră pe ramura variantelor, iar ramura simplă citește `products.price`, care
  // la produsele cu variante e 0.
  //
  // Reverificatorul a cerut `null`. Owner-ul a ales `0`, informat asupra riscului. Testul ăsta
  // FIXEAZĂ alegerea, ca să fie deliberată și nu întâmplătoare — fără el, mutațiile pe ramura
  // asta treceau nedetectate. Nemăsurat: dacă vreun produs din catalogul viu e azi în starea asta.
  const card = toProductCard(rand({ price: 0, from_price: null, variant_count: 3 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 0, 'alegere deliberată a owner-ului, nu o scăpare — vezi comentariul')
  assert.equal(card.price_from, false, 'fără from_price nu există „de la"')
})

test('🔴 from_price ZERO: și cifra e fixată, nu doar eticheta', () => {
  // Testul-frate de mai sus (`from_price ZERO nu e un preț`) verifica DOAR `price_from`, deci
  // trecea indiferent ce cifră ieșea. Găsit de reverificator prin mutație.
  const card = toProductCard(rand({ price: 0, from_price: 0, from_price_max: 9, variant_count: 3 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 0, 'aceeași decizie ca mai sus, fixată și pe valoare')
})

test('preț de bază 0 FĂRĂ variante: from_price salvează cifra (ramura „bază lipsă")', () => {
  // 🔴 Găsit prin mutație: slăbirea lui `bazaLipsa` de la `=== null || === 0` la doar `=== null`
  // trecea toate cele 255 de teste. Ramura există tocmai pentru un rând cu preț de bază 0 care
  // are totuși un `from_price` utilizabil; nimic nu o fixa.
  const card = toProductCard(rand({ price: 0, from_price: 5.7, from_price_max: 5.7, variant_count: 0 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 5.7, 'preț de bază 0 nu e un preț — se folosește from_price')
})

test('preț de bază REAL fără variante: from_price NU are voie să-l înlocuiască', () => {
  // 🔴 Găsit prin mutație: `variantCount > 0` slăbit la `>= 0` trecea toate testele, adică ORICE
  // produs ar fi intrat pe ramura variantelor. Fără variante, prețul taxat e cel de bază.
  const card = toProductCard(rand({ price: 100, from_price: 42, from_price_max: 90, variant_count: 0 }), ctx)
  assert.ok(card)
  assert.equal(card.price, 100, 'fără variante nu există „prețul variantei" care să bată baza')
  assert.equal(card.price_from, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// `effectivePrice` e folosit ȘI pe rânduri de VARIANTĂ (get-product.mjs), care n-au
// nici `variant_count`, nici `from_price`. Ramurile noi nu au voie să le atingă.
// ─────────────────────────────────────────────────────────────────────────────

test('rândul de VARIANTĂ (fără variant_count/from_price) trece prin regula veche', () => {
  assert.equal(effectivePrice({ price: 5.7, sale_price: null }), 5.7)
  assert.equal(effectivePrice({ price: 10, sale_price: 8 }), 8, 'reducerea reală se aplică')
  assert.equal(effectivePrice({ price: 10, sale_price: 0 }), 10, 'sale_price 0 nu e reducere')
  assert.equal(effectivePrice({ price: 10, sale_price: 12 }), 10, 'sale mai mare nu se aplică')
  assert.equal(effectivePrice({ price: null, sale_price: null }), null)
})

test('effectivePrice ignoră valorile nefinite în loc să le propage', () => {
  assert.equal(effectivePrice({ price: Number.NaN, sale_price: null }), null)
  assert.equal(effectivePrice({ price: 10, sale_price: Number.POSITIVE_INFINITY }), 10)
})
