/**
 * Endpointul de verificare a proprietății domeniului, cerut de portalul OpenAI
 * Apps înainte de submission: `/.well-known/openai-apps-challenge`.
 *
 * 🔴 Contractul măsurat la sursă (developers.openai.com, 27.09.2026): răspunsul
 * conține **DOAR** tokenul. Fără wrapper JSON, fără mai multe valori, fără text
 * explicativ, fără newline final. Orice ambalaj face verificarea să eșueze, iar
 * eșecul nu spune de ce — de aici testele care afirmă forma exactă a corpului.
 *
 * ⚠️ Fail-closed la token lipsă: 404, nu 200 cu corp gol.
 * Un 200 gol e cazul periculos în ambele direcții — ar putea fi citit ca o
 * verificare cu token gol, și ar ascunde o variabilă de mediu neconfigurată în
 * spatele unui răspuns care arată sănătos. 404 spune adevărul: aici nu există
 * (încă) nimic de verificat.
 *
 * ⚠️ Tokenul NU e un secret criptografic — portalul îl publică exact pentru a fi
 * servit public — dar rămâne o valoare de configurare: trăiește în env, nu în
 * repo, și nu se loghează.
 */

/** Numele variabilei de mediu care ține tokenul dat de portalul OpenAI. */
export const TOKEN_ENV_VAR = 'OPENAI_APPS_CHALLENGE_TOKEN'

/**
 * Răspunsul pentru `GET /.well-known/openai-apps-challenge`.
 *
 * `env` e injectabil ca testele să nu atingă `process.env` real: un test care
 * ar depinde de mediul mașinii ar trece sau cădea din motive care n-au legătură
 * cu codul.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Response}
 */
export function challengeResponse(env = process.env) {
  const raw = env[TOKEN_ENV_VAR]
  const token = typeof raw === 'string' ? raw.trim() : ''

  if (token === '') {
    // Corp gol deliberat și pe 404: nimic de spus unui client care nu e OpenAI,
    // și nicio confirmare că variabila există dar e greșită.
    return new Response('', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  }

  return new Response(token, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Tokenul se poate roti în portal. Un răspuns cache-uit de un CDN ar servi
      // tokenul vechi după rotire, iar verificarea ar eșua fără cauză vizibilă.
      'Cache-Control': 'no-store',
      // Corpul e exact tokenul, deci nu poate fi „sniffat" ca altceva — dar
      // headerul e gratuit și închide categoria.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
