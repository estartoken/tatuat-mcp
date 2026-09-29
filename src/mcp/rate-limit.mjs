/**
 * Plafon de debit pe cereri MCP.
 *
 * ⚠️ CE E ȘI CE NU E ACEST MODUL
 *
 * Nu e un control de acces. Controlul de acces în faza 1 e structural: fiecare
 * tool citește strict date deja publice prin RLS, iar niciun tool nu scrie
 * nimic. Modulul de aici există doar ca un client care o ia razna să nu consume
 * inutil cota PostgREST a magazinului.
 *
 * Store-ul implicit e în memoria instanței. Pe o platformă serverless instanțele
 * sunt efemere și paralele, deci plafonul e per-instanță, „best effort" —
 * declarat aici ca să nu fie citit vreodată ca o garanție.
 *
 * Există în DB `rate_limit_hit(p_key text, p_max int, p_window_secs int)
 * → boolean` (văzut în tipurile generate ale magazinului), care ar da un plafon
 * global real. NU e folosit încă: migrarea lui nu e în repo, deci nu se știe dacă
 * rolul `anon` are `execute` pe el, iar singurul fel de a afla ar fi un apel care
 * SCRIE în Supabase de producție. Până la o măsurătoare autorizată, seam-ul e
 * `createRpcLimiter()` mai jos — se schimbă un singur argument, nu logica.
 */

import { rpc } from './postgrest.mjs'

/** Câte cereri se acceptă pe fereastră, per cheie. */
export const DEFAULT_MAX = 60
/** Lungimea ferestrei, în secunde. */
export const DEFAULT_WINDOW_SECS = 60

/**
 * @typedef {(key: string, max: number, windowSecs: number) => Promise<boolean>} Limiter
 * Întoarce `true` dacă cererea e permisă, `false` dacă a depășit plafonul.
 */

/**
 * Plafon în memoria instanței. Fereastră fixă, nu glisantă — destul pentru a opri
 * o buclă, prea grosier pentru a fi numit protecție.
 *
 * @param {{ now?: () => number }} [opts] `now` injectabil pentru teste
 * @returns {Limiter}
 */
export function createMemoryLimiter(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const windows = new Map()

  return async function hit(key, max, windowSecs) {
    const t = now()
    const existing = windows.get(key)
    if (existing === undefined || existing.resetAt <= t) {
      windows.set(key, { count: 1, resetAt: t + windowSecs * 1000 })
      // Curățare oportunistă: fără ea, Map-ul crește cu fiecare cheie văzută.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k)
      }
      return true
    }
    existing.count += 1
    return existing.count <= max
  }
}

/**
 * Plafon global prin RPC. Fail-closed: dacă limiterul nu răspunde, cererea e
 * respinsă — un limiter indisponibil nu devine „trece necontrolat".
 *
 * Neactivat în faza 1 (vezi nota din capul fișierului).
 *
 * @returns {Limiter}
 */
export function createRpcLimiter() {
  return async function hit(key, max, windowSecs) {
    const allowed = await rpc('rate_limit_hit', {
      p_key: key,
      p_max: max,
      p_window_secs: windowSecs,
    })
    return allowed === true
  }
}

/** Aruncat când o cerere depășește plafonul. */
export class RateLimitError extends Error {
  /** @param {string} key */
  constructor(key) {
    super('Prea multe cereri. Încearcă din nou în scurt timp.')
    this.name = 'RateLimitError'
    this.key = key
  }
}

/**
 * @param {Limiter} limiter
 * @param {string} key
 * @param {{ max?: number, windowSecs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function enforce(limiter, key, opts = {}) {
  const allowed = await limiter(
    key,
    opts.max ?? DEFAULT_MAX,
    opts.windowSecs ?? DEFAULT_WINDOW_SECS,
  )
  if (!allowed) throw new RateLimitError(key)
}
