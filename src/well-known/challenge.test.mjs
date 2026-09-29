/**
 * Teste pentru `/.well-known/openai-apps-challenge`.
 *
 * 🔴 Cerința măsurată la sursă (developers.openai.com, 27.09.2026): endpointul
 * întoarce **DOAR** tokenul — fără wrapper JSON, fără valori multiple, fără text
 * în jur. Orice altceva face verificarea de domeniu să eșueze.
 *
 * ⚠️ Fail-closed, nu fail-open: dacă tokenul NU e configurat, răspunsul e 404.
 * Un 200 cu corp gol ar fi cazul periculos — ar putea „verifica" domeniul pentru
 * un token gol, sau (mai probabil) ar ascunde o configurare lipsă în spatele
 * unui răspuns care arată sănătos.
 *
 * ⚠️ Fiecare verificare de refuz stă lângă un CONTROL POZITIV: un endpoint care
 * ar întoarce 404 mereu ar trece toate testele de fail-closed fără să servească
 * vreodată tokenul.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { challengeResponse } from './challenge.mjs'

/** Token inventat, cu forma unui token opac. Nicio valoare reală în teste. */
const TOKEN = 'oai-challenge-Zm9vYmFyMTIzNDU2Nzg5'

test('CONTROL POZITIV: token configurat → 200 cu EXACT tokenul în corp', async () => {
  const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: TOKEN })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.equal(body, TOKEN, 'corpul nu e exact tokenul — verificarea de domeniu eșuează')
})

test('corpul NU e împachetat în JSON și nu are newline în plus', async () => {
  const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: TOKEN })
  const body = await res.text()
  assert.equal(body.includes('{'), false, 'răspuns împachetat în JSON')
  assert.equal(body.includes('"'), false, 'răspuns citat')
  assert.equal(body.endsWith('\n'), false, 'newline final în corp')
  assert.equal(body.trim(), body, 'spații în jurul tokenului')
})

test('Content-Type e text/plain, nu JSON și nu HTML', async () => {
  const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: TOKEN })
  const type = res.headers.get('content-type') ?? ''
  assert.ok(type.startsWith('text/plain'), `content-type neașteptat: ${type}`)
})

test('token ABSENT → 404 (fail-closed), nu 200 cu corp gol', async () => {
  const res = challengeResponse({})
  assert.equal(res.status, 404, 'lipsa tokenului a fost servită ca răspuns valid')
  const body = await res.text()
  assert.equal(body.includes(TOKEN), false)
})

test('token setat pe șir gol sau doar spații → 404, nu 200 gol', async () => {
  for (const value of ['', '   ', '\n']) {
    const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: value })
    assert.equal(res.status, 404, `valoarea ${JSON.stringify(value)} a trecut ca token valid`)
  }
})

test('tokenul se trimite curățat de spațiile din env, nu brut', async () => {
  const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: `  ${TOKEN}\n` })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), TOKEN, 'spațiile din variabila de mediu au ajuns în corp')
})

test('răspunsul nu e cache-abil: un token rotit nu trebuie servit din cache', () => {
  const res = challengeResponse({ OPENAI_APPS_CHALLENGE_TOKEN: TOKEN })
  const cc = res.headers.get('cache-control') ?? ''
  assert.ok(cc.includes('no-store'), `cache-control lipsă sau permisiv: ${cc}`)
})
