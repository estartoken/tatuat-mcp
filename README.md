# tatuat-mcp — server MCP public pentru TATUAT.RO

Server MCP (streamable HTTP) care expune catalogul tatuat.ro către ChatGPT, ca
plugin public. Read-only în faza 1; cumpărarea se finalizează pe tatuat.ro —
OpenAI cere explicit **external checkout** („Plugins should use external
checkout, directing users to complete purchases on your own domain").

Proiect separat de magazin, deliberat: un tool schimbat nu cere redeploy al
site-ului LIVE.

## Stare

**Implementat și verificat local. Nedeployat.** Nu există proiect Vercel publicat
și nu există DNS pe `api.tatuat.ro`. Fiecare dintre acestea cere OK explicit.

## Rute

| Rută | Metode | Ce face |
|---|---|---|
| `/mcp` | POST, GET, DELETE | Endpointul MCP. Toate trei sunt delegate pachetului, ca 405-ul erei 2025 să vină de la protocol, nu de la Next. |
| `/.well-known/openai-apps-challenge` | GET | Verificarea proprietății domeniului. Întoarce **DOAR** tokenul din `OPENAI_APPS_CHALLENGE_TOKEN`; **404** dacă tokenul lipsește. |

## 🔴 Serverul răspunde 403 oricărei gazde neînscrise

Marginea HTTP validează headerele `Host` și `Origin` împotriva unei allowlist
**statice** din `MCP_ALLOWED_HOSTS` (implicit `api.tatuat.ro`). Lista nu se
derivă niciodată din cererea însăși — o allowlist construită din propriul header
`Host` ar accepta trivial o pagină de DNS rebinding.

Consecințe de știut **înainte** de primul deploy, fiindcă arată ca defecțiuni:

- **Un URL de preview Vercel primește 403.** `https://tatuat-mcp-<hash>.vercel.app/mcp`
  nu e în allowlist. Ca să testezi pe preview, adaugă hostul în
  `MCP_ALLOWED_HOSTS` pentru acel environment — nu relaxa validarea.
- **Headerul `Host` absent → 403** (`missing_host`). Fail-closed deliberat:
  clienții MCP trimit mereu `Host`.
- **Headerul `Origin` absent → TRECE.** Polaritate opusă față de `Host`, măsurată
  în pachet: clienții non-browser nu trimit `Origin`, iar a-i respinge ar rupe
  exact clientul pentru care există serverul. Un `Origin` **prezent** dar de pe
  alt host, sau literalul `null` (contextul opac al unui browser), primește 403.
- Validarea e **port-agnostică** (`api.tatuat.ro:443` trece) și normalizează
  majusculele (`API.Tatuat.RO` trece).

Refuzul are forma JSON-RPC (`{"jsonrpc":"2.0","error":{"code":-32000,…},"id":null}`)
cu status 403, nu HTML — un client MCP poate să-l parseze.

## Variabile de mediu

Numele sunt în [`.env.example`](.env.example), fără valori. Valorile vin din
macOS Keychain la setup local și din env-ul proiectului Vercel în producție.

| Variabilă | Obligatorie | Notă |
|---|---|---|
| `SUPABASE_URL` | da | PostgREST, server-to-server |
| `SUPABASE_ANON_KEY` | da | Cheia **anon**, nu `service_role`: tot ce citesc tool-urile e deja public prin RLS |
| `MCP_ALLOWED_HOSTS` | nu | Implicit `api.tatuat.ro`. Listă separată prin virgulă |
| `TATUAT_SITE_URL` | nu | Implicit `https://tatuat.ro` |
| `AGENT_CHECKOUT_SECRET` | la faza checkout | Aceeași valoare și în proiectul Vercel al site-ului |
| `OPENAI_APPS_CHALLENGE_TOKEN` | la submission | Dat de portalul OpenAI. Fără el, endpointul de verificare dă 404 |

## Arhitectură

- **Logica trăiește în `.mjs`, glue-ul în `.ts`.** `app/**/route.ts` sunt delegări
  pure fără nicio decizie: repo-ul nu are teste pe `.ts`, deci un `.ts` nu are
  voie să conțină ceva care poate greși. Tot ce decide ceva e în `src/**/*.mjs`,
  acoperit de `node --test`.
- **Fără `@supabase/supabase-js`.** Accesul e direct pe PostgREST cu `fetch` —
  CORS e o restricție de browser, nu se aplică server-to-server.
- **Plafonul de rate limiting e singleton la nivel de modul.** `createMcpHandler`
  rulează factory-ul de server pe fiecare cerere; o găleată creată în factory s-ar
  reseta la fiecare cerere, adică un control care nu poate eșua. Plafonul e
  per-instanță de funcție, deci „best effort" — nu un plafon global.
- **RO-only deliberat.** `p_lang` nu se trimite, deci produsele doar-Ungaria
  (FROST, `lang='hu'`) nu apar. Fail-closed.
- **Prețul contractual e RON.** HUF nu se expune ca preț fără etichetă.

## Comenzi

```bash
npm run test         # node --test pe src/mcp, src/mcp/tools, src/well-known
npm run typecheck    # tsc --noEmit — vede și .mjs (checkJs + include)
npm run test:critical  # ambele
npm run dev          # Next dev pe :3000
npm run build        # next build
```

`npm run typecheck` acoperă și fișierele `.mjs` (`checkJs: true` plus `"**/*.mjs"`
în `include`). Fără acele două linii gate-ul privea zero fișiere și trecea mereu.

## Ce NU face acest server

- Nu scrie nimic în Supabase. Niciun tool nu mutează stare.
- Nu ține coș pe server. RLS pe `carts` e `auth.uid() = user_id`; un coș de guest
  pe server ar fi schemă nouă plus suprafață de scriere publică pe un magazin LIVE.
- Nu autentifică utilizatori. OAuth e faza 2, după aprobarea pluginului. Pachetul
  nu populează `authInfo` din headere și nu verifică tokenuri de la sine —
  autorizarea, când va exista, se scrie explicit aici.
- Nu procesează plăți. Checkout-ul se finalizează pe tatuat.ro.
