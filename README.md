# TATUAT.RO — server MCP

**Catalogul [tatuat.ro](https://tatuat.ro) — echipament de tatuaj și piercing — disponibil
pentru ChatGPT, Claude și orice agent AI.** Caută produse, verifică stocul real, calculează
transportul și generează un link de comandă, direct din conversație.

🟢 **Live:** `https://api.tatuat.ro/mcp` · transport streamable HTTP · fără autentificare

> **English** — MCP server exposing the [TATUAT.RO](https://tatuat.ro) catalog (tattoo &
> piercing supplies, Romania) to AI agents. Live at `https://api.tatuat.ro/mcp`, streamable
> HTTP, no auth required. Six tools: product search, category browsing, product detail,
> real-time stock, shipping calculator, and a signed checkout link. Prices in RON.
> Read-only except the checkout link — the purchase is completed on tatuat.ro.

---

## Ce poate face un agent

| Tool | Ce face |
|---|---|
| `search_products` | Caută după nume, brand sau tip de produs. Întoarce preț în RON, disponibilitate și link direct la fișă. |
| `browse_category` | O pagină de produse dintr-o categorie (sau din tot catalogul), cu sortare. |
| `get_product` | Fișa completă: descriere, preț efectiv, preț dinainte de reducere, brand, variante cu preț și stoc propriu. |
| `get_stock` | Disponibilitatea reală pentru o cantitate cerută. Patru stări: integral, parțial, pe comandă, indisponibil. |
| `calculate_shipping` | Cost de transport, pragul de transport gratuit și cadourile atinse la prag. |
| `create_checkout` | Link semnat către coșul de pe tatuat.ro. Valabil 15 minute. |

Primele cinci sunt **read-only** — nu scriu nimic. Al șaselea generează doar un link; nu
plasează comanda și nu atinge baza de date.

### Exemplu

> — *Am nevoie de cartușe 0.30 RL, vreo 20 de bucăți. Cât mă costă cu transport?*

Agentul apelează `search_products` → `get_stock` → `calculate_shipping`, răspunde cu prețul
real și cu cât mai trebuie până la transport gratuit, apoi `create_checkout` dă linkul pe
care clientul finalizează comanda pe tatuat.ro.

## Cum îl conectezi

**Claude Code**

```bash
claude mcp add --transport http tatuat https://api.tatuat.ro/mcp
```

**Claude Desktop** — Settings → Connectors → Add custom connector → `https://api.tatuat.ro/mcp`

**Orice client MCP** — endpoint streamable HTTP, protocol `2025-06-18`, fără token.

## Prețuri și monedă

Prețul contractual e **RON**, etichetat explicit în fiecare răspuns. Magazinul are și prețuri
în HUF (rată fixă), dar nu se expun aici: un preț fără etichetă de monedă, citit de un model,
e exact felul în care un client ajunge să creadă că plătește altă sumă.

La produsele cu variante (mărimi, configurații) prețul întors e **minimul dintre variante**,
marcat `price_from: true` ca agentul să spună „de la X RON", nu „X RON".

## Ce NU face

- **Nu scrie nimic** în baza de date. Niciun tool nu mutează stare.
- **Nu ține coș pe server.** Coșul trăiește pe tatuat.ro.
- **Nu autentifică utilizatori.** OAuth e fază ulterioară.
- **Nu procesează plăți.** Checkout-ul se finalizează pe tatuat.ro — cerință explicită OpenAI
  pentru plugin-uri („external checkout").
- **Linkul de checkout nu conține prețuri.** Transportă doar intenția (produs, variantă,
  cantitate); prețul final se calculează și se confirmă pe site.

---

# Pentru dezvoltatori

## Rute

| Rută | Metode | Ce face |
|---|---|---|
| `/mcp` | POST, GET, DELETE | Endpointul MCP. Toate trei delegate pachetului, ca 405-ul să vină de la protocol, nu de la Next. |
| `/.well-known/mcp-server-card.json` | GET | Cartea de vizită a serverului. |
| `/.well-known/openai-apps-challenge` | GET | Verificarea proprietății domeniului. Întoarce **doar** tokenul din `OPENAI_APPS_CHALLENGE_TOKEN`; **404** dacă lipsește. |

## Allowlist de gazde

Marginea HTTP validează `Host` și `Origin` împotriva unei allowlist **statice** din
`MCP_ALLOWED_HOSTS` (implicit `api.tatuat.ro`). Lista nu se derivă niciodată din cererea
însăși — o allowlist construită din propriul header `Host` ar accepta trivial o pagină de
DNS rebinding.

Consecințe care **arată ca defecțiuni, dar sunt intenționate**:

- Un URL de preview Vercel primește 403 — nu e în allowlist. Adaugă hostul în
  `MCP_ALLOWED_HOSTS` pentru acel environment; nu relaxa validarea.
- `Host` absent → 403 (`missing_host`), fail-closed: clienții MCP trimit mereu `Host`.
- `Origin` absent → **trece**. Polaritate opusă față de `Host`: clienții non-browser nu
  trimit `Origin`, iar a-i respinge ar rupe exact clientul pentru care există serverul. Un
  `Origin` prezent dar de pe alt host, sau literalul `null`, primește 403.
- Validarea e port-agnostică și normalizează majusculele.

Refuzul are formă JSON-RPC cu status 403, nu HTML — un client MCP îl poate parsa.

## Variabile de mediu

Numele sunt în [`.env.example`](.env.example), fără valori. Valorile vin din env-ul
proiectului Vercel în producție și din macOS Keychain la setup local — niciodată din repo.

| Variabilă | Obligatorie | Notă |
|---|---|---|
| `SUPABASE_URL` | da | PostgREST, server-to-server |
| `SUPABASE_ANON_KEY` | da | Cheia **anon**, nu `service_role`: tot ce citesc tool-urile e deja public prin RLS |
| `AGENT_CHECKOUT_SECRET` | pentru `create_checkout` | Aceeași valoare și în proiectul site-ului |
| `MCP_ALLOWED_HOSTS` | nu | Implicit `api.tatuat.ro`. Listă separată prin virgulă |
| `TATUAT_SITE_URL` | nu | Implicit `https://tatuat.ro` |
| `OPENAI_APPS_CHALLENGE_TOKEN` | la submission | Dat de portalul OpenAI |

## Arhitectură

- **Logica în `.mjs`, glue-ul în `.ts`.** `app/**/route.ts` sunt delegări pure, fără nicio
  decizie: repo-ul nu are teste pe `.ts`, deci un `.ts` nu are voie să conțină ceva care
  poate greși. Tot ce decide ceva e în `src/**/*.mjs`, acoperit de `node --test`.
- **Fără `@supabase/supabase-js`.** Acces direct pe PostgREST cu `fetch` — CORS e o
  restricție de browser, nu se aplică server-to-server.
- **Rate limiting singleton la nivel de modul.** `createMcpHandler` rulează factory-ul pe
  fiecare cerere; o găleată creată în factory s-ar reseta de fiecare dată. Plafonul e
  per-instanță de funcție, deci „best effort", nu global.
- **RO-only deliberat.** `p_lang` nu se trimite, deci produsele doar-Ungaria nu apar.
  Fail-closed.
- **Proiect separat de magazin**, ca un tool schimbat să nu ceară redeploy al site-ului.

## Comenzi

```bash
npm run test           # node --test pe src/mcp, src/mcp/tools, src/well-known
npm run typecheck      # tsc --noEmit — vede și .mjs (checkJs + include)
npm run test:critical  # ambele
npm run dev            # Next dev pe :3000
npm run build          # next build
```

`npm run typecheck` acoperă și fișierele `.mjs` (`checkJs: true` plus `"**/*.mjs"` în
`include`). Fără acele două linii, gate-ul privea zero fișiere și trecea mereu.

---

Magazinul: **[tatuat.ro](https://tatuat.ro)** — echipament profesional de tatuaj și piercing.
