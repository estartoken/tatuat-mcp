/**
 * Construcția instanței MCP — un singur loc în care se înregistrează tool-urile.
 *
 * 🔑 MĂSURAT în @modelcontextprotocol/server@2.0.0:
 *  - `constructor(serverInfo: Implementation, options?: ServerOptions)`
 *    (`dist/createMcpHandler-CLhGwQTn.d.mts:3198`).
 *  - `Implementation = { name, title?, icons?, version, websiteUrl?, description? }`.
 *    `title` e „merchant display name"-ul pe care OpenAI cere să fie nenul.
 *  - `ServerOptions` (`:2762`) are `instructions?` — locul potrivit pentru „cum se
 *    folosește serverul", fiindcă OpenAI cere ca modelul să poată termina
 *    workflow-ul FĂRĂ componentă de UI.
 *  - `capabilities` NU se declară manual: docstringul spune că `McpServer` le
 *    gestionează automat pentru ce se înregistrează prin el. Declararea unei
 *    capability fără handler ar încălca spec-ul.
 *
 * ⚠️ Funcția asta se apelează PE FIECARE CERERE HTTP („one serving unit: one HTTP
 * request under createMcpHandler"), deci nu face I/O, nu citește secrete și nu
 * construiește nimic scump. Tot ce e per-instanță-de-proces (limiterul) se
 * injectează prin `deps`, altfel plafonul s-ar reseta la fiecare cerere.
 */

import { McpServer } from '@modelcontextprotocol/server'

import * as searchProducts from './tools/search-products.mjs'
import * as calculateShipping from './tools/calculate-shipping.mjs'
import * as getStock from './tools/get-stock.mjs'
import * as createCheckout from './tools/create-checkout.mjs'
import * as browseCategory from './tools/browse-category.mjs'
import * as getProduct from './tools/get-product.mjs'

/** Versiunea raportată clientului. Ține pas cu `package.json`, nu cu spec-ul MCP. */
export const SERVER_VERSION = '0.1.0'

/**
 * Ce trebuie să știe modelul înainte de a apela primul tool. Scrise ca reguli,
 * nu ca marketing: fiecare propoziție previne un răspuns greșit pe care l-am
 * văzut deja în magazin (preț în moneda greșită, produs doar-HU oferit unui
 * client român, promisiune de plată în chat).
 */
export const INSTRUCTIONS = [
  'Tool-urile astea citesc catalogul magazinului de echipament de tatuaj și piercing tatuat.ro.',
  '',
  'Reguli:',
  '- Prețurile sunt în RON și includ TVA. Nu converti în altă monedă și nu inventa un preț: dacă un tool nu a întors un preț, spune că nu îl poți confirma.',
  '- Catalogul servit aici e cel pentru România. Produsele disponibile exclusiv în Ungaria nu apar deliberat; nu le deduce și nu le promite.',
  '- Disponibilitatea și stocul se citesc doar din răspunsul tool-urilor. „În stoc" fără confirmare de la un tool e o afirmație pe care nu ai cum să o susții.',
  '- Plata NU se face în conversație. Comanda se finalizează pe tatuat.ro; trimite clientul pe linkul întors de tool-uri.',
  '- Pentru detalii despre un produs anume folosește slug-ul întors de search_products, nu numele reformulat.',
].join('\n')

/**
 * @typedef {object} ServerDeps
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('./rate-limit.mjs').Limiter} [limiter]
 * @property {(err: unknown) => void} [onError]
 */

/**
 * @param {ServerDeps} [deps]
 * @returns {McpServer}
 */
export function buildTatuatMcpServer(deps = {}) {
  const server = new McpServer(
    {
      name: 'tatuat-ro',
      title: 'TATUAT.RO',
      version: SERVER_VERSION,
      websiteUrl: 'https://tatuat.ro',
      description:
        'Catalogul magazinului tatuat.ro: echipament de tatuaj și piercing — ace, cartușe, mașini, tușuri, consumabile. Preț în RON, stoc și link direct la fișa de produs.',
    },
    { instructions: INSTRUCTIONS },
  )

  searchProducts.register(server, deps)
  calculateShipping.register(server, deps)
  getStock.register(server, deps)
  browseCategory.register(server, deps)
  getProduct.register(server, deps)
  createCheckout.register(server, deps)

  return server
}
