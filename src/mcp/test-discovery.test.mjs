/**
 * Gardă pe DESCOPERIREA testelor — că scriptul `test` din `package.json` chiar
 * rulează fiecare fișier `*.test.mjs` de pe disc.
 *
 * De ce există: scriptul enumeră globuri PER DIRECTOR
 * (`src/mcp/*.test.mjs`, `src/mcp/tools/*.test.mjs`, …). Un fișier de test pus
 * într-un director nou NU e prins de niciunul, iar `node --test` nu se plânge —
 * raportează liniștit „toate verzi" pe o suită incompletă. Eșecul e tăcut și în
 * direcția cea mai proastă: cu cât testul nou e mai important, cu atât mai mult
 * crezi că a rulat.
 *
 * Nu e ipotetic. S-a întâmplat pe 30.09.2026: `src/registry/server-json.test.mjs`
 * a apărut ca al patrulea director de teste, iar globul a trebuit lărgit manual.
 * Dacă lărgirea ar fi fost uitată, cele 11 aserțiuni care apără documentul trimis
 * la `registry.modelcontextprotocol.io` ar fi fost sărite fără nicio urmă — exact
 * garda de care depinde publicarea.
 *
 * Contextul care face asta să conteze: CI-ul pe GitHub Actions e blocat pe billing
 * din 08.09.2026 (zero rulări reușite). Singura poartă reală e `.githooks/pre-push`,
 * care rulează `npm run test:critical` local. Dacă scriptul ăla vede o suită
 * incompletă, poarta e deschisă și nimic nu o mai verifică în amonte.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

/** Rădăcina repo-ului, dedusă din locul acestui fișier — nu din `cwd`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * De ce `cwd: ROOT` explicit: `node --test` poate fi pornit din orice director,
 * iar un glob relativ la un `cwd` diferit s-ar potrivi cu zero fișiere — adică
 * garda ar trece exact când n-ar trebui.
 */
/** @param {readonly string[]} patterns @returns {Set<string>} */
const expand = (patterns) =>
  new Set(patterns.flatMap((p) => [...globSync(p, { cwd: ROOT })].map((f) => String(f).replaceAll('\\', '/'))))

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

/** Globurile din scriptul `test`, exact cum le vede shell-ul (sunt în ghilimele simple). */
const scriptGlobs = [...(pkg.scripts.test ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])

test('scriptul `test` conține globuri — altfel nu se poate verifica nimic', () => {
  assert.ok(
    scriptGlobs.length > 0,
    'n-am găsit niciun glob în ghilimele simple în scripts.test; garda a devenit oarbă, ' +
      'nu verde — dacă forma scriptului s-a schimbat, actualizează extragerea de aici',
  )
})

test('fiecare *.test.mjs de pe disc e prins de scriptul `test`', () => {
  const peDisc = expand(['src/**/*.test.mjs'])
  const rulate = expand(scriptGlobs)

  // CONTROL POZITIV: fără el, un `src/` gol ar face testul să treacă tautologic.
  assert.ok(peDisc.size >= 10, `am găsit doar ${peDisc.size} fișiere de test pe disc — enumerarea e ruptă`)

  const orfane = [...peDisc].filter((f) => !rulate.has(f)).sort()
  assert.deepEqual(
    orfane,
    [],
    `fișiere de test care NU rulează în \`npm test\`:\n  ${orfane.join('\n  ')}\n` +
      `globurile actuale: ${scriptGlobs.join(' ')}\n` +
      'lărgește scripts.test în package.json (sau mută fișierul într-un director deja acoperit)',
  )

  // Inversul: un glob care nu prinde nimic e un director șters/redenumit, lăsat în urmă.
  const goale = scriptGlobs.filter((p) => expand([p]).size === 0)
  assert.deepEqual(goale, [], `globuri care nu potrivesc niciun fișier (director dispărut?): ${goale.join(' ')}`)
})

test('CONTROL NEGATIV: un set de globuri incomplet e chiar detectat', () => {
  // Fără asta, `deepEqual(orfane, [])` de mai sus ar putea trece pentru motivul
  // greșit — de pildă dacă `expand` ar întoarce mereu mulțimi identice.
  const peDisc = expand(['src/**/*.test.mjs'])
  const ciuntit = scriptGlobs.filter((p) => !p.includes('src/mcp/tools/'))
  assert.notEqual(ciuntit.length, scriptGlobs.length, 'presupunerea testului a expirat: nu mai există glob pe src/mcp/tools/')
  const orfane = [...peDisc].filter((f) => !expand(ciuntit).has(f))
  assert.ok(
    orfane.length > 0,
    'am scos globul pe src/mcp/tools/ și comparația n-a găsit nicio orfană — mecanismul gărzii e rupt',
  )
})

test('garda se auto-include: propriul fișier e printre cele rulate', () => {
  // O gardă pe care scriptul n-o rulează nu e o gardă. Verificarea e ieftină și
  // închide singura cale prin care tot fișierul ăsta ar putea deveni decorativ.
  const eu = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/')
  assert.ok(expand(scriptGlobs).has(eu), `${eu} nu e prins de scripts.test — garda nu se apără pe sine`)
})
