/**
 * `GET /.well-known/openai-apps-challenge` — verificarea proprietății domeniului
 * din portalul OpenAI Apps.
 *
 * ⚠️ Delegare pură, fără logică proprie — ca `app/mcp/route.ts`. Forma exactă a
 * răspunsului (corpul = DOAR tokenul, 404 fail-closed la token lipsă) e decisă
 * și testată în `src/well-known/challenge.mjs`, unde `node --test` o acoperă.
 *
 * 🔑 De ce o rută dinamică și nu un fișier în `public/.well-known/`:
 * tokenul trăiește în env, nu în repo — un fișier static ar însemna un secret de
 * configurare comis. Ruta îl citește la cerere, deci rotirea tokenului în portal
 * cere doar schimbarea variabilei, fără commit.
 */

import { challengeResponse } from '@/src/well-known/challenge.mjs'

/** `process.env` la runtime, nu la build: tokenul se poate schimba fără rebuild. */
export const runtime = 'nodejs'

/**
 * Fără cache. Un răspuns cache-uit ar servi tokenul vechi după o rotire în
 * portal, iar verificarea ar eșua fără cauză vizibilă.
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return challengeResponse()
}
