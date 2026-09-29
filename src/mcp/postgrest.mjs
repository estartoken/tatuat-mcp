/**
 * Acces la catalog prin PostgREST, server-to-server, cu cheia ANON.
 *
 * De ce anon și nu service_role: tot ce citesc tool-urile e deja public prin RLS
 * (`products`, `brands`, `categories`, `product_images`, `product_categories`,
 * `product_related` sunt `for select using (true)`). O cheie service_role ar da
 * serverului MCP putere pe care niciun tool nu o folosește — și pe care un bug
 * ar putea-o folosi. CORS e o restricție de browser și nu se aplică aici.
 *
 * ⚠️ PostgREST trunchiază TĂCUT la 1000 de rânduri. Fiecare apelant trebuie să
 * trimită un `limit` explicit; tool-urile plafonează la mult sub 1000.
 */

import { requireEnv } from './env.mjs'

/** Timeout implicit pentru o cerere PostgREST, ms. */
export const DEFAULT_TIMEOUT_MS = 8000

/** Eroare de la PostgREST sau de transport. Fail-closed: nicio valoare de rezervă. */
export class PostgrestError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'PostgrestError'
    /** @type {number} 0 = nu s-a primit niciun răspuns HTTP (timeout, DNS, reset). */
    this.status = opts.status ?? 0
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, key: string }}
 */
function credentials(env = process.env) {
  return {
    url: requireEnv('SUPABASE_URL', env).replace(/\/+$/, ''),
    key: requireEnv('SUPABASE_ANON_KEY', env),
  }
}

/**
 * @param {string} key
 * @returns {Record<string, string>}
 */
function baseHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

/**
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function readJson(res) {
  const text = await res.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new PostgrestError('Răspuns PostgREST care nu e JSON valid', {
      status: res.status,
      cause: err,
    })
  }
}

/**
 * Apelează o funcție RPC Postgres.
 *
 * `opts.select` proiectează coloanele PE REZULTATUL RPC-ului — PostgREST permite asta,
 * iar magazinul se bazează pe ea: aceleași RPC-uri întorc altfel TOATE coloanele
 * (inclusiv `search_tsv` și descrierile), ~321KB la 20 de produse.
 *
 * @param {string} fn numele funcției, fără prefix
 * @param {Record<string, unknown>} args chei cu `undefined` se elimină, ca RPC-ul să
 *   folosească defaultul serverului (așa se obține fail-closed pe `p_lang`)
 * @param {{ select?: string, timeoutMs?: number, fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<unknown>}
 */
export async function rpc(fn, args, opts = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) {
    throw new PostgrestError(`Nume de funcție RPC nevalid: ${fn}`)
  }
  const { url, key } = credentials(opts.env)
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload = Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined),
  )
  const qs = opts.select ? `?select=${encodeURIComponent(opts.select)}` : ''

  let res
  try {
    res = await doFetch(`${url}/rest/v1/rpc/${fn}${qs}`, {
      method: 'POST',
      headers: baseHeaders(key),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new PostgrestError(`RPC ${fn} nu a primit răspuns`, { cause: err })
  }
  if (!res.ok) {
    throw new PostgrestError(`RPC ${fn} a răspuns ${res.status}`, { status: res.status })
  }
  return readJson(res)
}

/**
 * Citire tabelară. `query` e deja un query string PostgREST construit de apelant
 * (`select=…&slug=eq.…&limit=…`), fiindcă tool-urile poartă query-urile portate
 * 1:1 din tatuat-site și trebuie să rămână recognoscibile lângă original.
 *
 * @param {string} table
 * @param {string} query
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function select(table, query, opts = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new PostgrestError(`Nume de tabel nevalid: ${table}`)
  }
  const { url, key } = credentials(opts.env)
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let res
  try {
    res = await doFetch(`${url}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: baseHeaders(key),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new PostgrestError(`Citirea din ${table} nu a primit răspuns`, { cause: err })
  }
  if (!res.ok) {
    throw new PostgrestError(`Citirea din ${table} a răspuns ${res.status}`, {
      status: res.status,
    })
  }
  const body = await readJson(res)
  if (!Array.isArray(body)) {
    throw new PostgrestError(`Citirea din ${table} nu a întors o listă`, {
      status: res.status,
    })
  }
  // Tipul de retur promite obiecte, deci se VERIFICĂ, nu se afirmă printr-un cast.
  // Un rând care nu e obiect nu se filtrează tăcut (ar scădea numărul de produse
  // fără ca nimeni să afle) — aruncă, ca orice alt răspuns pe care nu-l înțelegem.
  if (!body.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
    throw new PostgrestError(`Citirea din ${table} a întors un rând care nu e obiect`, {
      status: res.status,
    })
  }
  return /** @type {Record<string, unknown>[]} */ (body)
}
