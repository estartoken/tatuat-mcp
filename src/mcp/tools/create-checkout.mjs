/**
 * `create_checkout` — construiește un link de finalizare a comenzii pe
 * tatuat.ro, semnat HMAC. Vezi `search-products.mjs` pentru forma canonică
 * de tool; acest fișier o urmează, cu două diferențe deliberate: nu citește
 * catalogul (nu face nicio cerere de rețea) și annotations e altul (vezi mai
 * jos, lângă `CREATE_CHECKOUT_ANNOTATIONS`).
 *
 * 🔴 PREȚUL NU CIRCULĂ PRIN LINK. Coșul trimis aici e o INTENȚIE de comandă
 * (produs, variantă, cantitate, opțiuni) — prețul autoritar se recitește pe
 * site la checkout, din catalogul live, nu din ce a calculat modelul în
 * conversație. Vezi `checkout-link.mjs` pentru semnarea propriu-zisă.
 *
 * Secretul HMAC (`AGENT_CHECKOUT_SECRET`) vine din env prin `requireEnv`:
 * dacă lipsește, tool-ul întoarce `isError` — NICIODATĂ un link nesemnat.
 * Fail-closed, ca în `env.mjs`/`postgrest.mjs`.
 */

import { z } from 'zod'
import { requireEnv, siteOrigin } from '../env.mjs'
import { okResult, errorResult, guarded } from '../tool-result.mjs'
import { enforce } from '../rate-limit.mjs'
import { buildCheckoutUrl } from '../checkout-link.mjs'
import { isAllowedProductId } from '../policy.mjs'
import { MAX_QTY_PER_LINE } from './get-stock.mjs'

export const name = 'create_checkout'

/** Cât timp rămâne valabil link-ul de checkout, în secunde. */
export const CHECKOUT_TTL_SECS = 900
/** Câte linii poate avea coșul într-un singur link. */
export const MAX_ITEMS = 20

/**
 * Plafoanele pe opțiunile unei linii. OGLINDĂ a celor din `lib/agent-items.mjs` din tatuat-site,
 * unde linkul e validat la sosire.
 *
 * 🔴 DE CE EXISTĂ AICI, nu doar acolo: site-ul respinge ÎN BLOC un coș care încalcă orice limită, iar
 * clientul vede „Linkul nu a putut fi verificat" — exact mesajul de la o semnătură falsificată, deci
 * fără nicio indicație și fără drum înapoi. Un refuz la apel îi spune modelului ce să corecteze,
 * înainte ca linkul să plece în conversație. Aceeași logică pentru `MAX_QTY_PER_LINE`, importat din
 * `get-stock.mjs` ca să nu apară un al doilea 9999 care poate devia.
 *
 * ⚠️ Cele două repo-uri se deployează separat. Dacă limitele se schimbă dincolo, se schimbă și aici,
 * în aceeași trecere — altfel divergența revine, tăcut.
 */
export const MAX_OPTIONS = 20
export const MAX_OPTION_KEY = 64
export const MAX_OPTION_VALUE = 200

/**
 * Cât de lung poate fi URL-ul emis, în caractere.
 *
 * 🔴 DE CE NU E DE AJUNS validarea pe câmpuri: fiecare limită de mai sus poate fi respectată și
 * totuși să iasă un link nelivrabil. Măsurat 29.09.2026, coșul maximal legitim (20 de linii × 20 de
 * opțiuni × 200 de caractere) dă un URL de ~113.000 de caractere. Nu ajunge nicăieri:
 *   • Vercel refuză cererile cu URL peste ~14KB, deci nici nu atinge ruta site-ului;
 *   • ruta `/api/agent-cart` taie corpurile peste `MAX_BODY = 64_000` și răspunde `bad_payload`,
 *     pe care clientul îl citește ca „Linkul nu a putut fi verificat" — mesajul de la o semnătură
 *     falsificată. Adică un zid fără explicație și fără drum înapoi.
 *
 * 🔑 CIFRA E DERIVATĂ DIN PLATFORMĂ, nu din coșul maximal. Tentația e s-o alegi „cât să încapă
 * maximul teoretic" — dar maximul teoretic e de 145.701 de caractere, deci n-are cum. Tentația
 * opusă, s-o strângi la cel mai mare coș pe care-l vezi în teste, taie coșuri legitime. Ancora e
 * limita reală de URL a platformei (~14KB pe Vercel), cu o margine pentru prefixul de origine și
 * pentru anteturile care intră în același buget.
 *
 * Măsurat 29.09.2026, toate cu 20 de linii, variantă și cantitate maximă:
 *     7.355 car — două opțiuni realiste (ex. mărime + culoare)  ← coșul de zi cu zi
 *     8.901 car — o opțiune cu cheia și valoarea la plafon      ← legitim, TREBUIE să treacă
 *    16.101 car — două opțiuni la plafon                        ← deja peste limita platformei
 *   145.701 car — maximul teoretic al schemei                   ← nelivrabil de 10 ori
 * 12.000 lasă să treacă tot ce e livrabil și taie exact zona în care linkul ar muri tăcut.
 */
export const MAX_LINK_CHARS = 12_000

/**
 * Textul refuzului pentru o linie exclusă din canalul ChatGPT.
 *
 * Nu spune „produsul nu există" — ar fi fals și ar trimite clientul să caute
 * altundeva. Spune ce poate face mai departe: produsul se cumpără pe site.
 * Id-urile concrete se adaugă la final, iar ele vin din argumentele
 * modelului (întregi pozitivi validați de Zod), nu din vreo eroare internă —
 * deci nu e o scurgere de diagnostic, e ecoul cererii lui.
 */
export const EXCLUDED_ITEMS_MESSAGE =
  'Unele produse din coș nu pot fi comandate prin acest canal și se cumpără direct pe tatuat.ro. Scoate-le din coș și încearcă din nou.'

const CartItem = z.object({
  product_id: z
    .number()
    .int()
    .positive()
    .describe('Identificatorul numeric stabil al produsului, ca cel întors de search_products.'),
  variant_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe('Varianta aleasă a produsului, sau null dacă produsul nu are variante.'),
  qty: z
    .number()
    .int()
    .min(1)
    .max(MAX_QTY_PER_LINE)
    .describe(
      `Cantitatea cerută din acest produs. Minim 1 — un coș nu poate avea o cantitate zero sau negativă — și maximum ${MAX_QTY_PER_LINE}.`,
    ),
  options: z
    .record(z.string().min(1).max(MAX_OPTION_KEY), z.string().max(MAX_OPTION_VALUE))
    .refine((o) => Object.keys(o).length <= MAX_OPTIONS, {
      message: `Cel mult ${MAX_OPTIONS} opțiuni pe linie.`,
    })
    .default({})
    .describe(
      `Opțiuni alese pentru produs, ca pereche nume-valoare (ex. {"culoare":"negru"}), dacă produsul are. Cel mult ${MAX_OPTIONS} opțiuni; numele până la ${MAX_OPTION_KEY} caractere, valoarea până la ${MAX_OPTION_VALUE}.`,
    ),
})

export const inputSchema = z.object({
  items: z
    .array(CartItem)
    .min(1)
    .max(MAX_ITEMS)
    .describe(`Coșul de cumpărat: cel puțin un produs, maximum ${MAX_ITEMS} linii.`),
})

export const outputSchema = z.object({
  url: z
    .string()
    .describe(
      'Link de finalizare a comenzii pe tatuat.ro. Prețul se confirmă pe site la finalizare, nu prin acest link.',
    ),
  expires_in_seconds: z
    .number()
    .int()
    .describe('Cât timp, în secunde, mai e valabil link-ul înainte să trebuiască generat din nou.'),
})

/**
 * 🔴 ANNOTATIONS DIFERITE de restul valului — NU `READ_ONLY_ANNOTATIONS` din
 * `schemas.mjs`. Motivul, câmp cu câmp:
 *  - `readOnlyHint: false` — tool-ul produce un artefact cu efect comercial
 *    (un link care, deschis, pornește o comandă reală). Nu schimbă nimic în
 *    starea SERVERULUI MCP, dar OpenAI respinge pentru annotations permisive
 *    ÎN DIRECȚIA GREȘITĂ, iar a marca `readOnly` un tool care poate iniția o
 *    cumpărătură e exact acea direcție.
 *  - `destructiveHint: false` — nu șterge, nu suprascrie nimic existent.
 *  - `idempotentHint: false` — fiecare apel generează un `nonce` nou (vezi
 *    `checkout-link.mjs`); același input produce un link DIFERIT de fiecare
 *    dată, deci apelul nu e idempotent.
 *  - `openWorldHint: false` — interacționează doar cu tatuat.ro, nu cu o
 *    lume exterioară nedeterminată.
 */
export const CREATE_CHECKOUT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

export const config = {
  title: 'Creează link de finalizare comandă pe tatuat.ro',
  description:
    'Generează un link semnat către checkout-ul tatuat.ro pentru coșul dat (produse, variante, cantități, opțiuni). Linkul e valabil un timp limitat și NU conține prețuri — prețul final se confirmă pe site. Folosește acest tool când clientul e decis să cumpere; pentru a găsi produse sau prețuri folosește search_products/get_product înainte.',
  inputSchema,
  outputSchema,
  annotations: CREATE_CHECKOUT_ANNOTATIONS,
}

/**
 * @typedef {object} Deps
 * @property {Record<string, string | undefined>} [env]
 * @property {import('../rate-limit.mjs').Limiter} [limiter]
 * @property {() => number} [now]
 * @property {(err: unknown) => void} [onError]
 */

/**
 * @param {Deps} [deps]
 */
export function createHandler(deps = {}) {
  /**
   * @param {{ items: { product_id: number, variant_id: number | null, qty: number, options: Record<string, string> }[] }} args
   * @param {{ sessionId?: string }} [ctx]
   * @returns {Promise<import('../tool-result.mjs').ToolResult>}
   */
  return async function handler(args, ctx = {}) {
    return guarded(async () => {
      if (deps.limiter) {
        await enforce(deps.limiter, `${name}:${ctx.sessionId ?? 'anon'}`)
      }

      const env = deps.env ?? process.env
      const secret = requireEnv('AGENT_CHECKOUT_SECRET', env)
      const origin = siteOrigin(env)
      const now = deps.now ?? Date.now
      const exp = Math.floor(now() / 1000) + CHECKOUT_TTL_SECS

      // 🔴 POLITICA SE APLICĂ AICI, nu în catalog. `create_checkout` e singurul
      // tool care nu citește catalogul, deci filtrul din `catalog.mjs` nu-l
      // acoperă: `product_id` vine DIRECT de la model și, fără gardul de mai jos,
      // ar ajunge nefiltrat în linkul semnat. Regula OpenAI e verbatim „enforce
      // authorization in the MCP server for every request; never rely on the
      // model to decide whether a user has access".
      //
      // Refuz ÎNTREG, nu link cu linia lipsă: un coș tăcut incomplet ar duce
      // clientul pe tatuat.ro cu altceva decât ce i s-a confirmat în conversație,
      // iar lipsa nu s-ar vedea nici în UI, nici într-un test de formă.
      //
      // `isAllowedProductId` e pur și sincron ⇒ nu cere `fetchImpl` în `Deps` și
      // nu face nicio cerere de rețea pe drumul acestui tool.
      const blocked = args.items.filter((item) => !isAllowedProductId(item.product_id))
      if (blocked.length > 0) {
        const ids = [...new Set(blocked.map((item) => item.product_id))].join(", ")
        return errorResult(`${EXCLUDED_ITEMS_MESSAGE} Produse: ${ids}.`)
      }

      const items = args.items.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id,
        qty: item.qty,
        options: item.options,
      }))

      const { url } = buildCheckoutUrl(origin, { items, exp, secret })

      // Ultimul filtru, pe produsul FINIT: limitele pe câmpuri pot fi toate respectate și linkul să
      // iasă totuși nelivrabil (vezi `MAX_LINK_CHARS`). Refuzăm aici, unde modelul poate reacționa,
      // nu după ce linkul a plecat în conversație și clientul lovește un zid fără explicație.
      if (url.length > MAX_LINK_CHARS) {
        return errorResult(
          'Coșul are prea multe detalii pentru un singur link (opțiunile alese îl fac prea mare). ' +
            'Împarte-l în mai multe comenzi, cu mai puține produse sau mai puține opțiuni pe produs.',
        )
      }

      const minutes = Math.round(CHECKOUT_TTL_SECS / 60)
      return okResult(
        `Link de finalizare comandă pe tatuat.ro (valabil ${minutes} minute, prețul se confirmă pe site): ${url}`,
        { url, expires_in_seconds: CHECKOUT_TTL_SECS },
      )
    }, { onError: deps.onError })
  }
}

/**
 * ⚠️ Vezi nota din `search-products.mjs`: tipul e `McpServer`-ul real, nu o
 * formă structurală minimă — `registerTool` e generică și un parametru mai
 * larg dă TS2345.
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Deps} [deps]
 */
export function register(server, deps = {}) {
  return server.registerTool(name, config, createHandler(deps))
}
