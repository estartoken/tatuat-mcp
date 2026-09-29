/**
 * Citirea configurației, fail-closed.
 *
 * Nicio valoare implicită pentru un secret: dacă lipsește, tool-ul care avea
 * nevoie de el întoarce o eroare, nu „trece necontrolat". Modelul din
 * `app/api/asistent/route.ts` din tatuat-site.
 */

/** Aruncat când o variabilă de mediu obligatorie lipsește. */
export class McpConfigError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`Configurație lipsă: ${name}`)
    this.name = 'McpConfigError'
    /** @type {string} */
    this.varName = name
  }
}

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} [source]
 * @returns {string}
 */
export function requireEnv(name, source = process.env) {
  const raw = source[name]
  if (typeof raw !== 'string' || raw.trim() === '') throw new McpConfigError(name)
  return raw.trim()
}

/**
 * @param {string} name
 * @param {string} fallback
 * @param {Record<string, string | undefined>} [source]
 * @returns {string}
 */
export function optionalEnv(name, fallback, source = process.env) {
  const raw = source[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  return raw.trim()
}

/**
 * Allowlist STATICĂ de hostname-uri acceptate pentru cererile MCP.
 *
 * Deliberat NU se derivă din headerul `Host` al cererii: o listă construită din
 * cererea însăși ar accepta trivial o pagină de DNS rebinding. Clienții MCP care
 * nu sunt browsere nu trimit `Origin` și nu sunt afectați în niciun fel.
 *
 * @param {Record<string, string | undefined>} [source]
 * @returns {string[]}
 */
export function allowedHostnames(source = process.env) {
  const raw = optionalEnv('MCP_ALLOWED_HOSTS', 'api.tatuat.ro', source)
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
}

/**
 * Originea magazinului către care trimite `create_checkout`.
 * @param {Record<string, string | undefined>} [source]
 * @returns {string}
 */
export function siteOrigin(source = process.env) {
  return optionalEnv('TATUAT_SITE_URL', 'https://tatuat.ro', source).replace(/\/+$/, '')
}
