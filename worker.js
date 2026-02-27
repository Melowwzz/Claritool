/**
 * Claritool — Cloudflare Worker (Groq API)
 * Proxy seguro: a API key fica só aqui, nunca exposta no HTML
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'

// Modelos gratuitos do Groq com fallback automático
const FALLBACK_MODELS = [
  'llama-3.3-70b-versatile',     // Llama 70B — melhor qualidade
  'llama-3.1-70b-versatile',     // Llama 70B v1
  'gemma2-9b-it',                // Gemma 2 9B — rápido
  'llama-3.1-8b-instant',        // Llama 8B — muito rápido
  'mixtral-8x7b-32768',          // Mixtral — bom para textos longos
]

// Mapa de nomes amigáveis (retornado ao cliente)
const MODEL_NAMES = {
  'llama-3.3-70b-versatile': 'Llama 3.3 70B',
  'llama-3.1-70b-versatile': 'Llama 3.1 70B',
  'gemma2-9b-it': 'Gemma 2 9B',
  'llama-3.1-8b-instant': 'Llama 8B',
  'mixtral-8x7b-32768': 'Mixtral 8x7B',
}

async function tryGroq(apiKey, model, messages) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      temperature: 0.7,
    }),
  })
  return res
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const { model, messages } = body
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const apiKey = env.GROQ_API_KEY
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    // Monta lista de modelos para tentar (modelo escolhido pelo usuário primeiro)
    const modelsToTry = model
      ? [model, ...FALLBACK_MODELS.filter(m => m !== model)]
      : FALLBACK_MODELS

    let lastError = null

    for (const tryModel of modelsToTry) {
      let res
      try {
        res = await tryGroq(apiKey, tryModel, messages)
      } catch (err) {
        lastError = `Erro de rede: ${err.message}`
        continue
      }

      if (res.status === 429) {
        lastError = `Modelo ${tryModel} sobrecarregado`
        continue // tenta próximo modelo
      }

      if (!res.ok) {
        let errBody
        try { errBody = await res.json() } catch { errBody = {} }
        lastError = errBody?.error?.message || `Erro ${res.status} no modelo ${tryModel}`
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

      return new Response(JSON.stringify({
        result,
        usedModel: tryModel,
        usedModelName: MODEL_NAMES[tryModel] || tryModel,
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    // Todos os modelos falharam
    return new Response(JSON.stringify({
      error: lastError || 'Todos os modelos estão ocupados. Tente em alguns minutos.',
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  },
}
