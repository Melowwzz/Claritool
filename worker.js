/**
 * Claritool — Cloudflare Worker (Groq API)
 * Enhanced: system role, vision model routing, web search (DDG + Wikipedia)
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

// ── Text models with fallback ──
const TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'gemma2-9b-it',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
]

// ── Vision models ──
const VISION_MODELS = [
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
]

const MODEL_NAMES = {
  'llama-3.3-70b-versatile':      'Llama 3.3 70B',
  'llama-3.1-70b-versatile':      'Llama 3.1 70B',
  'gemma2-9b-it':                 'Gemma 2 9B',
  'llama-3.1-8b-instant':         'Llama 8B',
  'mixtral-8x7b-32768':           'Mixtral 8x7B',
  'llama-3.2-90b-vision-preview': 'Llama 3.2 90B Vision',
  'llama-3.2-11b-vision-preview': 'Llama 3.2 11B Vision',
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

// Detect if messages contain image content → route to vision model
function hasImages(messages) {
  return messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === 'image_url')
  )
}

async function callGroq(apiKey, model, messages, system) {
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages

  return fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: msgs,
      max_tokens: 4096,
      temperature: 0.7,
    }),
  })
}

// ── Web Search: DuckDuckGo Instant Answer + Wikipedia ──
async function webSearch(query) {
  const out = { instant: null, wiki: null, related: [] }

  // DuckDuckGo Instant Answer API (free, no key)
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

  // Wikipedia PT
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

  // Fallback: Wikipedia EN
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

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS })
    }

    const url = new URL(request.url)

    // ── Search endpoint ──
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
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

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

    // Auto-detect vision requests and route to vision models
    const isVision = hasImages(messages)
    const pool = isVision ? VISION_MODELS : TEXT_MODELS
    const modelsToTry = model
      ? [model, ...pool.filter(m => m !== model)]
      : pool

    let lastError = null

    for (const m of modelsToTry) {
      let res
      try {
        res = await callGroq(apiKey, m, messages, system || null)
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
        lastError = 'Resposta inválida da API'
        continue
      }

      const result = data?.choices?.[0]?.message?.content
      if (!result) {
        lastError = 'Resposta vazia do modelo'
        continue
      }

      return json({
        result,
        usedModel: m,
        usedModelName: MODEL_NAMES[m] || m,
      })
    }

    return json({
      error: lastError || 'Todos os modelos estão ocupados. Tente em alguns minutos.',
    }, 429)
  },
}
