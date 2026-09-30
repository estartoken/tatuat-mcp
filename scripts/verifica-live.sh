#!/bin/zsh
# Verificare LIVE a serverului tatuat-mcp deployat. Manuală, cu rețea — de-aia nu e
# în `npm test`. Folosire: scripts/verifica-live.sh https://api.tatuat.ro
#
# Trei capcane pe care versiunile anterioare ale acestei verificări le-au călcat.
# Sunt scrise aici ca să nu fie recălcate, fiecare a costat timp real:
#
# 1) `content-type` singur NU e de-ajuns. Transportul streamable-HTTP întoarce 406
#    fără `accept: application/json, text/event-stream`, iar 406-ul arată exact ca
#    un deploy stricat. Răspunsul poate veni ca SSE — se citește, nu se presupune.
#
# 2) `tools/list` NU dovedește că serverul funcționează. Trece identic pe un server
#    fără SUPABASE_URL/ANON_KEY. De-aia pasul 2 cheamă un tool REAL și numără
#    produsele întoarse.
#
# 3) Allowlist-ul NU se probează pe `Host`. Pe Vercel, un `Host` din afara
#    proiectului e refuzat de EDGE cu 404 `x-vercel-error: DEPLOYMENT_NOT_FOUND`,
#    înainte să ajungă la codul nostru — deci un 404 acolo nu spune nimic despre
#    garda din aplicație. Proba care măsoară chiar codul e pe `Origin`, care trece
#    prin edge. Măsurat 30.09.2026.
#
# Fiecare pas care poate „trece" dintr-un motiv greșit are CONTROL POZITIV.

set -u
BASE="${1:?folosire: verifica-live.sh https://api.tatuat.ro}"
HDRS=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
FAIL=0

# Citește un răspuns JSON-RPC, indiferent dacă vine JSON simplu sau SSE.
rpc() {
  curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -d "$1" | /usr/bin/python3 -c "
import sys
raw=sys.stdin.read()
if 'data:' in raw:
    parts=[l[5:].strip() for l in raw.split('\n') if l.startswith('data:') and l[5:].strip()]
    raw=parts[-1] if parts else ''
sys.stdout.write(raw)
"
}
status() {  # $@ = headere extra; întoarce doar codul HTTP
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" "${HDRS[@]}" "$@" \
    -d '{"jsonrpc":"2.0","id":99,"method":"tools/list","params":{}}'
}
ok()  { print -r -- "  ✅ $1" }
bad() { print -r -- "  ❌ $1"; FAIL=1 }

print -r -- "=== 1. tools/list — exact cele 6 tool-uri din server.json/ard.json ==="
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | /usr/bin/python3 -c "
import sys,json
d=json.load(sys.stdin)
got=sorted(t['name'] for t in d['result']['tools'])
want=sorted(['search_products','get_product','get_stock','browse_category','calculate_shipping','create_checkout'])
print('  got :', got)
if got==want: print('  ✅ potrivire exactă cu documentele publicate')
else:
    print('  ❌ DRIFT față de server.json/ard.json — nu publica'); print('  want:', want); raise SystemExit(1)
" || FAIL=1

print -r -- "=== 2. tools/call search_products — dovada că env-ul e legat la catalogul real ==="
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"masina de tatuat","limit":3}}}' | /usr/bin/python3 -c "
import sys,json
d=json.load(sys.stdin); r=d.get('result',{})
txt=' '.join(c.get('text','') for c in r.get('content',[]))
if r.get('isError'):
    print('  ❌ tool-ul a întors eroare:', txt[:200])
    if 'Configurație lipsă' in txt: print('     → lipsesc variabilele de mediu în Vercel')
    raise SystemExit(1)
sc=r.get('structuredContent') or {}
prods=sc.get('products') or sc.get('results') or []
print('  produse întoarse:', len(prods))
if not prods: print('  ❌ zero produse — serverul nu vede catalogul'); raise SystemExit(1)
p=prods[0]
print('  primul:', str(p.get('name',''))[:60], '|', p.get('price'), p.get('currency'))
print('  ✅ catalog real, PostgREST legat')
" || FAIL=1

print -r -- "=== 3. /.well-known/mcp-server-card.json (ținta câmpului url din ard.json) ==="
CARD=$(/usr/bin/mktemp)
curl -sS -D - -o "$CARD" "$BASE/.well-known/mcp-server-card.json" \
  | /usr/bin/grep -iE '^(HTTP/|content-type|access-control-allow-origin|cache-control)' | /usr/bin/sed 's/^/  /'
/usr/bin/python3 -c "
import json,sys
d=json.load(open('$CARD'))
print('  name:', d.get('name'), '| version:', d.get('version'))
print('  remotes:', [r.get('url') for r in d.get('remotes',[])])
if not d.get('name') or not d.get('remotes'): print('  ❌ card incomplet'); raise SystemExit(1)
print('  ✅ card servit, identitate publică prezentă')
" || FAIL=1
/bin/rm -f "$CARD"

print -r -- "=== 4. garda de Origin — codul NOSTRU, nu edge-ul Vercel (vezi capcana 3) ==="
ST=$(status -H 'origin: https://evil.example')
if [[ "$ST" == "403" ]]; then ok "403 pe Origin străin"; else bad "Origin străin: aștept 403, am primit $ST"; fi
ST=$(status -H 'origin: null')
if [[ "$ST" == "403" ]]; then ok "403 pe Origin „null\" (context opac de browser)"; else bad "Origin null: aștept 403, am primit $ST"; fi
# CONTROL POZITIV: fără ele, un server care refuză TOT ar trece cele două de sus.
ST=$(status -H "origin: $BASE")
if [[ "$ST" == "200" ]]; then ok "CONTROL POZITIV: Origin legitim → 200"; else bad "Origin legitim respins cu $ST — garda respinge tot"; fi
ST=$(status)
if [[ "$ST" == "200" ]]; then ok "CONTROL POZITIV: fără Origin (client non-browser) → 200"; else bad "cerere fără Origin respinsă cu $ST"; fi

print -r -- "=== 5. create_checkout — link semnat, ȘI ținta lui chiar REZOLVĂ ==="
# De ce nu e destul să ne uităm la FORMA linkului: pe 30.09.2026 linkul avea forma perfectă
# (`/cos-din-conversatie` + `c=` + `sig=`) și totuși ducea în **404**, fiindcă pagina de aterizare
# (`01daa19`) trăia doar pe ramura `feat/chatgpt-agent-mcp`, nemerge-uită în ce era deployat pe
# `tatuat.ro`. Un link care arată corect dar nu duce nicăieri e tot un checkout stricat.
# Și atenție la capcana simetrică: un link cu semnătura STRICATĂ dădea tot 404, deci „respins" și
# „ruta nu există" arătau identic — de aceea aici se cere 200 pe linkul VALID, ca control pozitiv.
CO=$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_checkout","arguments":{"items":[{"product_id":1,"variant_id":null,"qty":1,"options":{}}]}}}')
LINK=$(print -r -- "$CO" | /usr/bin/python3 -c "
import sys,json,re
d=json.load(sys.stdin); r=d.get('result',{})
if r.get('isError'):
    txt=' '.join(c.get('text','') for c in r.get('content',[]))
    sys.stderr.write('  ❌ create_checkout a întors eroare: '+txt[:180]+'\n')
    if 'Configurație lipsă' in txt:
        sys.stderr.write('     → AGENT_CHECKOUT_SECRET lipsește pe proiectul MCP\n')
    raise SystemExit(1)
url=(r.get('structuredContent') or {}).get('url') or ''
if not url:
    txt=' '.join(c.get('text','') for c in r.get('content',[]))
    m=re.search(r'https://\S+', txt); url=m.group(0) if m else ''
if not url:
    sys.stderr.write('  ❌ răspuns fără link\n'); raise SystemExit(1)
missing=[n for n in ('/cos-din-conversatie','c=','sig=') if n not in url]
if missing:
    sys.stderr.write('  ❌ linkul nu conține '+', '.join(missing)+'\n'); raise SystemExit(1)
print(url)
") || FAIL=1

if [[ -n "$LINK" ]]; then
  print -r -- "  link: ${LINK:0:72}…"
  ok "forma e corectă: /cos-din-conversatie + payload + semnătură"
  ST=$(curl -s -o /dev/null -w '%{http_code}' -L "$LINK")
  if [[ "$ST" == "200" ]]; then
    ok "ținta REZOLVĂ (HTTP $ST) — pagina de aterizare e deployată"
  else
    bad "ținta linkului întoarce HTTP $ST, nu 200 — checkout-ul agentului duce în gol"
    print -r -- "     Verifică pe ce ramură trăiește pagina:"
    print -r -- "     git -C ../tatuat-site log --all --oneline --diff-filter=A -- '*cos-din-conversatie*'"
  fi
  print -r -- "  🔴 Validarea semnăturii rulează în JS-ul paginii, nu pe server: curl vede 200 și"
  print -r -- "     pentru un link falsificat. Proba de falsificare se face DOAR în browser — și"
  print -r -- "     doar după ce verificarea de mai sus e verde, altfel măsori ruta, nu semnătura."
fi

rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_checkout","arguments":{"items":[{"product_id":1455,"variant_id":null,"qty":1,"options":{}}]}}}' | /usr/bin/python3 -c "
import sys,json
d=json.load(sys.stdin); r=d.get('result',{})
txt=' '.join(c.get('text','') for c in r.get('content',[]))
# 1455 = Tattoo Soothe 10g, 5% lidocaină — pe lista de excluse din src/mcp/policy.mjs.
if r.get('isError') or 'http' not in txt:
    print('  ✅ produsul exclus 1455 e refuzat:', txt[:90])
else:
    print('  ❌ SCURGERE: 1455 a primit link de checkout'); raise SystemExit(1)
" || FAIL=1

print -r -- ""
if [[ $FAIL -eq 0 ]]; then print -r -- "REZULTAT: TOATE VERDE"; else print -r -- "REZULTAT: 🔴 CEL PUȚIN O VERIFICARE A PICAT"; fi
exit $FAIL
