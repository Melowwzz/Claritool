/**
 * Claritool — Cloudflare Worker
 * Chat endpoint with think-more refinement, web search
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'gemma2-9b-it',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
]

const MODEL_NAMES = {
  'llama-3.3-70b-versatile':      'Llama 3.3 70B',
  'llama-3.1-70b-versatile':      'Llama 3.1 70B',
  'gemma2-9b-it':                 'Gemma 2 9B',
  'llama-3.1-8b-instant':         'Llama 8B',
  'mixtral-8x7b-32768':           'Mixtral 8x7B',
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const MAX_LOGS = 200

// ── Activity Logger (KV-backed) ──
async function logActivity(kv, entry) {
  if (!kv) return
  try {
    const raw = await kv.get('activity_log')
    const logs = raw ? JSON.parse(raw) : []
    logs.unshift(entry)
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS
    await kv.put('activity_log', JSON.stringify(logs))
  } catch {}
}

async function getStats(kv) {
  if (!kv) return { total: 0, today: 0, logs: [] }
  try {
    const raw = await kv.get('activity_log')
    const logs = raw ? JSON.parse(raw) : []
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const today = logs.filter(l => l.time.startsWith(todayStr)).length
    return { total: logs.length, today, logs }
  } catch {
    return { total: 0, today: 0, logs: [] }
  }
}

const REFINE_INSTRUCTION = `Reescreva completamente sua resposta anterior de forma melhorada:
- Corrija imprecisoes factuais
- Melhore clareza e didatica com analogias melhores
- Adicione exemplos concretos que faltaram
- Mantenha o tom amigavel e educativo
- Mantenha a mesma lingua
- Escreva diretamente a resposta final — SEM mencionar revisao, melhoria ou reescrita`

// Strip any meta-text residue from refinement loops
function cleanRefinedOutput(text) {
  const noise = [
    /^(aqui est[aá]|segue|veja|confira)\s*(a\s*)?(vers[aã]o|resposta)\s*(melhorada|revisada|final|aprimorada|corrigida)[:\.\!\s]*/i,
    /^(reescrevendo|revisando|melhorando|aprimorando)[:\.\!\s]*/i,
    /^(com base na revis[aã]o|ap[oó]s revis[aã]o)[,:\.\!\s]*/i,
    /^(vers[aã]o (final|melhorada|revisada))[:\.\!\s]*/i,
    /^---+\s*/,
  ]
  let cleaned = text.trim()
  for (const rx of noise) {
    cleaned = cleaned.replace(rx, '')
  }
  return cleaned.trim()
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

async function callGroq(apiKey, model, messages, temperature = 0.7, maxTokens = 4096) {
  return fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  })
}

// Try models in order, return { result, usedModel } or throw
async function tryModels(apiKey, pool, messages, temperature, maxTokens) {
  let lastError = null

  for (const m of pool) {
    let res
    try {
      res = await callGroq(apiKey, m, messages, temperature, maxTokens)
    } catch (err) {
      lastError = `Erro de rede: ${err.message}`
      continue
    }

    if (res.status === 429) {
      lastError = `Modelo ${m} sobrecarregado`
      continue
    }

    if (!res.ok) {
      let errBody
      try { errBody = await res.json() } catch { errBody = {} }
      lastError = errBody?.error?.message || `Erro ${res.status} no modelo ${m}`
      continue
    }

    let data
    try { data = await res.json() } catch {
      lastError = 'Resposta invalida da API'
      continue
    }

    const result = data?.choices?.[0]?.message?.content
    if (!result) {
      lastError = 'Resposta vazia do modelo'
      continue
    }

    return { result, usedModel: m, usedModelName: MODEL_NAMES[m] || m }
  }

  throw new Error(lastError || 'Todos os modelos estao ocupados.')
}

// ── Web Search: DuckDuckGo + Wikipedia ──
async function webSearch(query) {
  const out = { instant: null, wiki: null, related: [] }

  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const r = await fetch(ddgUrl, { headers: { 'User-Agent': 'Claritool/1.0' } })
    const d = await r.json()
    if (d.Abstract) {
      out.instant = {
        title: d.Heading || query,
        text: d.Abstract,
        source: d.AbstractSource,
        url: d.AbstractURL,
      }
    }
    if (d.RelatedTopics) {
      out.related = d.RelatedTopics
        .filter(t => t.Text)
        .slice(0, 5)
        .map(t => ({ text: t.Text, url: t.FirstURL }))
    }
  } catch {}

  try {
    const r = await fetch(
      `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Claritool/1.0' } }
    )
    if (r.ok) {
      const w = await r.json()
      if (w.extract) {
        out.wiki = {
          title: w.title,
          text: w.extract,
          url: w.content_urls?.desktop?.page,
        }
      }
    }
  } catch {}

  if (!out.wiki) {
    try {
      const r = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': 'Claritool/1.0' } }
      )
      if (r.ok) {
        const w = await r.json()
        if (w.extract) {
          out.wiki = {
            title: w.title,
            text: w.extract,
            url: w.content_urls?.desktop?.page,
          }
        }
      }
    } catch {}
  }

  return out
}

// Format search results as context string for AI
function formatSearchContext(data) {
  let ctx = ''
  if (data.wiki) ctx += `Wikipedia (${data.wiki.title}): ${data.wiki.text}\n\n`
  if (data.instant) ctx += `${data.instant.source || 'DuckDuckGo'} (${data.instant.title}): ${data.instant.text}\n\n`
  if (data.related) {
    for (const r of data.related) {
      ctx += `- ${r.text}\n`
    }
  }
  return ctx.trim()
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS })
    }

    const url = new URL(request.url)

    // ── Monitor endpoint (secret) ──
    if (url.pathname === '/api/logs' && request.method === 'GET') {
      const secret = env.MONITOR_SECRET
      const auth = url.searchParams.get('key') || request.headers.get('Authorization')?.replace('Bearer ', '')
      if (!secret || auth !== secret) {
        return json({ error: 'Unauthorized' }, 401)
      }
      const since = url.searchParams.get('since') || null
      const stats = await getStats(env.LOGS)
      if (since) {
        stats.logs = stats.logs.filter(l => l.time > since)
      }
      return json(stats)
    }

    // ── Serve chat.html ──
    if (url.pathname === '/chat' && request.method === 'GET') {
      // Serve from KV or redirect — handled by Pages/static
      // For workers, we return a redirect or serve inline
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/chat.html', ...CORS },
      })
    }

    // ── Search endpoint ──
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const { query } = await request.json()
        if (!query) return json({ error: 'query is required' }, 400)
        const data = await webSearch(query)
        return json({ ...data, context: formatSearchContext(data) })
      } catch {
        return json({ error: 'Invalid request' }, 400)
      }
    }

    // ── Legacy search endpoint ──
    if (url.pathname === '/search' && request.method === 'POST') {
      try {
        const { query } = await request.json()
        if (!query) return json({ error: 'query is required' }, 400)
        return json(await webSearch(query))
      } catch {
        return json({ error: 'Invalid request' }, 400)
      }
    }

    // ── Chat endpoint ──
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ error: 'Invalid JSON' }, 400)
      }

      const { messages, system, mode, searchContext } = body
      if (!messages || !Array.isArray(messages)) {
        return json({ error: 'messages is required' }, 400)
      }

      const apiKey = env.GROQ_API_KEY
      if (!apiKey) {
        return json({ error: 'API key not configured' }, 500)
      }

      // Build system message with optional search context
      let sysContent = system || ''
      if (searchContext) {
        sysContent += `\n\n## CONTEXTO DE PESQUISA WEB (dados reais e atualizados — use para enriquecer sua resposta):\n${searchContext}`
      }

      const sysMsgs = sysContent
        ? [{ role: 'system', content: sysContent }, ...messages]
        : messages

      try {
        // First response
        let { result, usedModel, usedModelName } = await tryModels(apiKey, TEXT_MODELS, sysMsgs, 0.7, 4096)

        // "Think more" refinement loop (3 passes)
        if (mode === 'think') {
          const refinePool = TEXT_MODELS
          for (let i = 0; i < 3; i++) {
            const refineMessages = [
              { role: 'system', content: sysContent || 'Voce e um assistente educacional.' },
              ...messages,
              { role: 'assistant', content: result },
              { role: 'user', content: REFINE_INSTRUCTION },
            ]
            try {
              const refined = await tryModels(apiKey, refinePool, refineMessages, 0.5, 4096)
              result = cleanRefinedOutput(refined.result)
              usedModel = refined.usedModel
              usedModelName = refined.usedModelName
            } catch {
              break
            }
          }
        }

        // Log activity (fire-and-forget)
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
        const preview = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content.slice(0, 300)
          : '???'
        ctx.waitUntil(logActivity(env.LOGS, {
          time: new Date().toISOString(),
          endpoint: '/api/chat',
          mode: mode || 'quick',
          model: usedModelName,
          query: preview,
        }))

        return json({ result, usedModel, usedModelName, mode: mode || 'quick' })
      } catch (e) {
        return json({ error: e.message }, 429)
      }
    }

    // ── Legacy root POST (for index.html compatibility) ──
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ error: 'Invalid JSON' }, 400)
      }

      const { model, messages, system } = body
      if (!messages || !Array.isArray(messages)) {
        return json({ error: 'messages is required' }, 400)
      }

      const apiKey = env.GROQ_API_KEY
      if (!apiKey) {
        return json({ error: 'API key not configured' }, 500)
      }

      const modelsToTry = model
        ? [model, ...TEXT_MODELS.filter(m => m !== model)]
        : TEXT_MODELS

      const sysMsgs = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages

      try {
        const { result, usedModel, usedModelName } = await tryModels(apiKey, modelsToTry, sysMsgs)

        // Log activity (fire-and-forget)
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
        const preview = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content.slice(0, 300)
          : '???'
        ctx.waitUntil(logActivity(env.LOGS, {
          time: new Date().toISOString(),
          endpoint: '/',
          mode: 'legacy',
          model: usedModelName,
          query: preview,
        }))

        return json({ result, usedModel, usedModelName })
      } catch (e) {
        return json({ error: e.message }, 429)
      }
    }

    return json({ error: 'Not found' }, 404)
  },
}
