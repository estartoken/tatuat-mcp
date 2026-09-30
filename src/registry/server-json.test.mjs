/**
 * Gardă pe `server.json` — documentul trimis la `registry.modelcontextprotocol.io`.
 *
 * De ce există: registrul validează la PUBLICARE, nu la scriere. O greșeală aici
 * nu se vede local — se vede ca un refuz după ce ai dat `mcp-publisher publish`,
 * sau, mai rău, ca o intrare publicată care indică greșit. Testul mută verificarea
 * înaintea publicării.
 *
 * Regulile de mai jos NU sunt inventate: sunt citite din schema oficială
 * `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
 * (inspectată 30.09.2026) și din `docs/reference/server-json/official-registry-requirements.md`.
 * Cea care chiar ne-ar fi picat publicarea: `description` are **maxLength 100**,
 * iar descrierea din server card avea 130 de caractere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { mcpServerCardResponse, CARD_TOOLS } from '../well-known/mcp-server-card.mjs'
import { SERVER_VERSION } from '../mcp/server.mjs'

/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const server = JSON.parse(read('../../server.json'))
const pkg = JSON.parse(read('../../package.json'))

/**
 * Cardul, EXACT cum îl produce ruta: fără argumente, deci pe valorile lui implicite.
 * ⚠️ A-i injecta `server.version` ar face testul de divergență tautologic — l-am
 * scris întâi așa și mutația „versiune divergentă" a scăpat nedetectată.
 */
async function card() {
  return await mcpServerCardResponse({}).json()
}

test('schema e fixată pe o versiune, nu pe „latest"', () => {
  // O schemă nefixată s-ar putea schimba sub noi și ar transforma un server.json
  // valid azi într-unul respins mâine, fără nicio modificare din partea noastră.
  assert.equal(
    server.$schema,
    'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  )
})

test('numele respectă namespace-ul pe care îl putem dovedi cu autentificare GitHub', () => {
  // Registrul refuză publicarea dacă namespace-ul nu corespunde metodei de auth:
  // cu GitHub auth, numele TREBUIE să înceapă cu `io.github.<user>/`.
  assert.match(server.name, /^io\.github\.estartoken\/[a-zA-Z0-9._-]+$/)
  // Pattern-ul din schemă: exact un slash, doar caractere permise.
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
  assert.ok(server.name.length >= 3 && server.name.length <= 200)
})

test('descrierea încape în cele 100 de caractere ale schemei', () => {
  assert.ok(server.description.length >= 1, 'descriere goală')
  assert.ok(
    server.description.length <= 100,
    `descrierea are ${server.description.length} caractere, maximul e 100`,
  )
})

test('titlul încape în cele 100 de caractere ale schemei', () => {
  assert.ok(server.title.length >= 1 && server.title.length <= 100)
})

test('versiunea e semver', () => {
  assert.match(server.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
})

test('versiunea e aceeași în toate cele patru locuri unde e scrisă de mână', () => {
  // Repo-ul sincronizează versiunea MANUAL (vezi comentariul din
  // `app/.well-known/mcp-server-card.json/route.ts`): `package.json`,
  // `SERVER_VERSION` din `src/mcp/server.mjs`, valoarea implicită din
  // `mcp-server-card.mjs` și — de acum — `server.json`. Registrul refuză
  // republicarea aceleiași versiuni, deci o versiune rămasă în urmă aici e o
  // publicare eșuată; una sărită peste e o intrare care minte despre ce rulează.
  assert.equal(server.version, pkg.version, 'server.json ≠ package.json')
  assert.equal(server.version, SERVER_VERSION, 'server.json ≠ SERVER_VERSION')
})

test('serverul e declarat ca remote streamable-http pe endpointul live', () => {
  assert.equal(server.remotes.length, 1)
  const [remote] = server.remotes
  assert.equal(remote.type, 'streamable-http')
  assert.equal(remote.url, 'https://api.tatuat.ro/mcp')
  assert.match(remote.url, /^https:\/\//)
})

test('nu declarăm `packages` — n-am publicat niciun artefact și n-am putea dovedi proprietatea', () => {
  // Orice intrare în `packages` declanșează „package ownership verification":
  // registrul cere un marker (`mcpName` în package.json pentru npm etc.) în
  // artefactul publicat. Noi nu publicăm artefacte, deci cheia trebuie să lipsească.
  assert.equal(server.packages, undefined)
})

test('iconul e HTTPS și de pe domeniul propriu', () => {
  assert.equal(server.icons.length, 1)
  const [icon] = server.icons
  assert.match(icon.src, /^https:\/\/tatuat\.ro\//)
  assert.ok(icon.src.length <= 255)
  // Schema acceptă doar aceste MIME-uri.
  assert.ok(
    ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'].includes(icon.mimeType),
  )
})

test('repository indică repo-ul public real', () => {
  assert.equal(server.repository.url, 'https://github.com/estartoken/tatuat-mcp')
  assert.equal(server.repository.source, 'github')
  // ID-ul e stabil la redenumire — de-asta îl ținem, nu doar URL-ul.
  assert.equal(server.repository.id, '1398388993')
})

test('server.json și server card-ul nu divergă pe identitatea publică', async () => {
  // Comentariul din `mcp-server-card.mjs` cere explicit ca cele două să oglindească
  // aceeași identitate. Descrierile pot diferi (cardul o are pe cea lungă în RO,
  // registrul impune ≤100), dar numele, versiunea, site-ul și endpointul NU au voie.
  const c = await card()
  assert.equal(server.name, c.name)
  assert.equal(server.version, c.version)
  assert.equal(server.websiteUrl, c.websiteUrl)
  assert.equal(server.remotes[0].url, c.remotes[0].url)
})

test('cele 6 tool-uri anunțate de card sunt cele pe care le promitem public', () => {
  // Nu intră în server.json (schema n-are câmp `tools`), dar dacă lista se schimbă
  // trebuie revizuită descrierea trimisă la registru — de-asta e prinsă aici.
  assert.equal(CARD_TOOLS.length, 6)
})
