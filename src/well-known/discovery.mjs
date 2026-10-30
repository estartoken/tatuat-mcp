/** Public documentation, independent of catalog credentials or MCP sessions. */
export const MCP_URL = 'https://api.tatuat.ro/mcp'

const tools = [
  ['search_products', 'Caută produse după nume, brand sau tip, cu preț în RON și link direct.'],
  ['get_product', 'Citește detaliile produsului și variantele, inclusiv ID-ul și prețul fiecărei variante.'],
  ['get_stock', 'Verifică disponibilitatea unei cantități pentru produsul sau varianta aleasă.'],
  ['browse_category', 'Răsfoiește catalogul sau o categorie cunoscută, cu sortare și paginare.'],
  ['calculate_shipping', 'Calculează transportul și pragurile de cadouri din produsele și variantele alese.'],
  ['create_checkout', 'Generează un link semnat, temporar, către finalizarea comenzii pe tatuat.ro.'],
]

export function homepageResponse() {
  return new Response(`<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TATUAT.RO MCP — catalog pentru asistenți AI</title>
<meta name="description" content="Conectează un client MCP la catalogul TATUAT.RO: produse de tatuaj și piercing, prețuri RON, stoc, transport și link de comandă. Endpoint public Streamable HTTP.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://api.tatuat.ro/">
<link rel="stylesheet" href="/docs.css">
<link rel="alternate" type="text/plain" href="/llms.txt" title="Documentație pentru asistenți AI">
</head>
<body>
<header><a class="brand" href="https://tatuat.ro">TATUAT.RO</a><a href="https://tatuat.ro">Mergi la magazin ↗</a></header>
<main>
<p class="eyebrow">CATALOG PENTRU ASISTENȚI AI</p>
<h1>Produsele potrivite.<br>Date direct din magazin.</h1>
<p class="intro">Serverul MCP TATUAT.RO conectează asistenții AI la catalogul nostru de echipamente de tatuaj, piercing și consumabile. Caută produse, verifică prețuri și stocuri, apoi continuă comanda pe tatuat.ro.</p>
<div class="details"><span>6 unelte</span><span>Prețuri în RON, cu TVA</span><span>Fără autentificare</span></div>
<section id="conectare">
<h2>Conectare</h2>
<p>Adaugă acest URL într-un client care acceptă servere MCP la distanță:</p>
<pre><code>${MCP_URL}</code></pre>
<p>Transport: <strong>Streamable HTTP</strong>. Conectarea se face prin protocolul MCP; deschiderea URL-ului în browser poate răspunde cu <code>405 Method Not Allowed</code>, deoarece serverul nu oferă un flux separat la cereri GET.</p>
<p>Clientul negociază protocolul prin <code>initialize</code>, apoi descoperă uneltele și schemele lor prin <code>tools/list</code>. Conectarea unui client MCP și publicarea într-un director nu înseamnă că orice asistent AI activează automat această integrare.</p>
</section>
<section id="unelte">
<h2>Ce poți face</h2>
<dl>${tools.map(([name, description]) => `<div><dt><code>${name}</code></dt><dd>${description}</dd></div>`).join('\n')}</dl>
<p>Primele cinci unelte citesc sau calculează informații. <code>create_checkout</code> generează un link; plata și confirmarea comenzii se fac pe tatuat.ro.</p>
</section>
<section id="utilizare">
<h2>De la întrebare la comandă</h2>
<ol>
<li>Caută produsul cu <code>search_products</code> și citește detaliile cu <code>get_product</code>.</li>
<li>Alege varianta potrivită. Folosește <code>variant_id</code> la verificarea stocului și la calculul transportului; pentru variante cu prețuri diferite, selecția este necesară.</li>
<li>După ce clientul decide să cumpere, generează linkul de checkout. Prețul final și livrarea se confirmă pe site.</li>
</ol>
<p>Catalogul de căutare este destinat României. Pe fișele accesate direct, respectă orice <code>order_restriction</code> întoarsă de server. Un preț „de la” reprezintă cel mai mic preț al variantelor, nu prețul oricărei variante. Disponibilitatea trebuie verificată la momentul comenzii.</p>
</section>
<section lang="en" id="english">
<h2>For AI clients and developers</h2>
<p>TATUAT.RO is a Romanian tattoo and piercing supplies store. This public MCP server provides product search, product details, stock checks, catalog browsing, shipping calculations and temporary checkout links. Prices are in RON, including VAT. Connect using Streamable HTTP at <code>${MCP_URL}</code>, without an API key. Purchases are completed on the store website.</p>
</section>
<nav aria-label="Resurse pentru integrare">
<a href="/.well-known/mcp-server-card.json">Server card JSON</a>
<a href="/llms.txt">llms.txt</a>
<a href="https://github.com/estartoken/tatuat-mcp">Cod și documentație</a>
<a href="https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.estartoken/tatuat-mcp">Registrul oficial MCP</a>
<a href="https://tatuat.ro/llms.txt">Resursele magazinului</a>
</nav>
</main>
<footer><p>TATUAT.RO · SC VLC DIVISION SRL · Sibiu, România</p><p><a href="https://tatuat.ro/contact">Contact</a> · <a href="https://tatuat.ro">Magazin</a></p></footer>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export function robotsResponse() {
  return new Response(`User-agent: *
Allow: /
Disallow: /mcp
Disallow: /.well-known/openai-apps-challenge
`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export function llmsResponse() {
  return new Response(`# TATUAT.RO MCP

> Public MCP server for the Romanian TATUAT.RO tattoo and piercing supplies store. Prices are in RON, including VAT. Purchases are completed on tatuat.ro.

## Connect

- Endpoint: ${MCP_URL}
- Transport: Streamable HTTP
- Authentication: none
- Registry name: io.github.estartoken/tatuat-mcp
- Initialize the MCP connection, then use tools/list to obtain the current schemas.
- GET /mcp returns HTTP 405 because a separate server event stream is not offered; this is not a connection failure.

## Tools

- search_products: Find products by name, brand or type.
- get_product: Read a product and its variants, prices and IDs.
- get_stock: Check product or variant availability for the requested quantity.
- browse_category: Browse the catalog or a known category with sorting and pagination.
- calculate_shipping: Calculate shipping and gift thresholds. Include variant_id for differently priced variants. Unknown products or variants stop the calculation rather than producing a partial total.
- create_checkout: Generate a temporary signed checkout link after the customer decides to buy. This does not place an order or process payment.

## Usage

Use search_products, then get_product to select an exact variant. Pass that variant_id to get_stock and calculate_shipping. A price_from value is a minimum variant price, not a quote for every variant. Respect order_restriction and confirm stock and final pricing at checkout. Search and browsing cover the Romanian catalog.

## Links

- [Public documentation](https://api.tatuat.ro/)
- [MCP server card](https://api.tatuat.ro/.well-known/mcp-server-card.json)
- [Source and setup](https://github.com/estartoken/tatuat-mcp)
- [Store](https://tatuat.ro/)
- [Store resources](https://tatuat.ro/llms.txt)
- [Product feed](https://tatuat.ro/product-feed.json)
`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
