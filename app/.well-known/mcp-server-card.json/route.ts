/**
 * `GET /.well-known/mcp-server-card.json` — delegare pură, ca
 * `app/.well-known/openai-apps-challenge/route.ts`.
 *
 * Forma exactă a răspunsului (câmpuri, Content-Type, CORS, cache) e decisă și
 * testată în `src/well-known/mcp-server-card.mjs` (7 teste, `node --test`).
 *
 * 🔑 De ce fără argumente: `mcpServerCardResponse()` are implicit `env =
 * process.env` (citit la runtime, reflectă `MCP_ALLOWED_HOSTS` fără rebuild) și
 * `version = '0.1.0'` — ACELAȘI literal sincronizat manual cu `package.json` și
 * cu `SERVER_VERSION` din `src/mcp/server.mjs` (convenția reală din acest repo,
 * verificată direct: niciun fișier de-aici nu importă `package.json` la runtime).
 * A importa `server.mjs` doar pt versiune ar cupla ruta la toate cele 6 tool-uri
 * înregistrate acolo, degeaba — un cost de bundle fără niciun beneficiu aici.
 *
 * Nu `force-dynamic`, deliberat, spre deosebire de `openai-apps-challenge`: acolo
 * un răspuns cache-uit ar servi un token rotit greșit; aici documentul e static
 * per-deploy și cache-ul e voit (`Cache-Control: public, max-age=300`, controlat
 * din `mcp-server-card.mjs`, nu de optimizarea de build a Next).
 */

import { mcpServerCardResponse } from '@/src/well-known/mcp-server-card.mjs'

export const runtime = 'nodejs'

export function GET(): Response {
  return mcpServerCardResponse()
}
