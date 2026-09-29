/**
 * Teste pentru `/.well-known/mcp-server-card.json`.
 *
 * Contractul verificat: document JSON static, servibil cross-origin, cu EXACT
 * cele 6 tool-uri reale ale serverului — nu o listă care poate desincroniza
 * tăcut de `src/mcp/tools/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mcpServerCardResponse, CARD_TOOLS } from './mcp-server-card.mjs'

test('CONTROL POZITIV: 200 cu JSON valid, nume+versiune+remotes corecte', async () => {
  const res = mcpServerCardResponse({}, '0.1.0')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.name, 'io.github.estartoken/tatuat-mcp')
  assert.equal(body.version, '0.1.0')
  assert.equal(body.websiteUrl, 'https://tatuat.ro')
  assert.deepEqual(body.remotes, [{ type: 'streamable-http', url: 'https://api.tatuat.ro/mcp' }])
})

test('lista de tool-uri e EXACT cea reală — 6 tool-uri, fără drift tăcut', () => {
  assert.deepEqual(CARD_TOOLS, [
    'search_products',
    'get_product',
    'get_stock',
    'browse_category',
    'calculate_shipping',
    'create_checkout',
  ])
})

test('Content-Type e application/json, nu text/plain sau HTML', () => {
  const res = mcpServerCardResponse({}, '0.1.0')
  const type = res.headers.get('content-type') ?? ''
  assert.ok(type.startsWith('application/json'), `content-type neașteptat: ${type}`)
})

test('CORS deschis — registrele/crawlerele ARD citesc cross-origin', () => {
  const res = mcpServerCardResponse({}, '0.1.0')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

test('cache-control e prezent și PERMITE cache (document static, nu un token rotativ)', () => {
  const res = mcpServerCardResponse({}, '0.1.0')
  const cc = res.headers.get('cache-control') ?? ''
  assert.ok(cc.includes('max-age'), `cache-control lipsă/nesetat: ${cc}`)
  assert.equal(cc.includes('no-store'), false, 'nu trebuie tratat ca secret rotativ')
})

test('MCP_ALLOWED_HOSTS custom → remotes.url reflectă hostname-ul configurat, nu hardcodat', () => {
  const res = mcpServerCardResponse({ MCP_ALLOWED_HOSTS: 'staging.tatuat.ro,api.tatuat.ro' }, '0.1.0')
  return res.json().then((body) => {
    assert.equal(body.remotes[0].url, 'https://staging.tatuat.ro/mcp')
  })
})

test('fără MCP_ALLOWED_HOSTS → cade pe originea implicită api.tatuat.ro', async () => {
  const res = mcpServerCardResponse({}, '0.1.0')
  const body = await res.json()
  assert.equal(body.remotes[0].url, 'https://api.tatuat.ro/mcp')
})
