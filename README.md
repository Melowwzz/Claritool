# Claritool

Plataforma educacional serverless com IA para estudantes brasileiros. Combina simplificação de textos, geração de roteiros de estudo, tutoria interativa e chat livre — tudo alimentado por LLMs open-source via Groq API, com backend em Cloudflare Workers e frontend estático sem frameworks.

**Stack**: Cloudflare Workers · Groq API · DuckDuckGo API · Wikipedia REST API · Vanilla JS

---

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│                     FRONTEND (GitHub Pages)                  │
│                                                              │
│  index.html ─── Simplificar · Roteiro · Tutor IA            │
│  chat.html ──── Chat livre com Think Mode                    │
│                                                              │
│  Vanilla JS (ES6+) · CSS3 Custom Properties · Zero deps     │
└─────────────────────────┬────────────────────────────────────┘
                          │ HTTPS (CORS: *)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│               BACKEND (Cloudflare Workers)                   │
│                                                              │
│  worker.js ─── API proxy + orquestração de modelos           │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  Groq API   │  │ DuckDuckGo   │  │ Wikipedia REST API  │ │
│  │  (LLM/VLM)  │  │ (search)     │  │ (pt-BR + en)        │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

| Rota | Método | Descrição | Payload |
|------|--------|-----------|---------|
| `POST /api/chat` | POST | Chat principal com seleção de modelo, refinamento e visão | `{ messages, system?, mode?, searchContext? }` |
| `POST /api/search` | POST | Busca web (DuckDuckGo + Wikipedia) | `{ query }` |
| `POST /search` | POST | Endpoint legado de busca | `{ query }` |
| `GET /chat` | GET | Redirect → `chat.html` | — |
| `POST /` | POST | Endpoint legado (compatibilidade `index.html`) | `{ model?, messages, system? }` |

### Response Schema (`/api/chat`)

```json
{
  "result": "string",
  "usedModel": "llama-3.3-70b-versatile",
  "usedModelName": "Llama 3.3 70B",
  "mode": "quick | think"
}
```

---

## Modelos

### Text Models (fallback sequencial)

| Modelo | Params | Uso |
|--------|--------|-----|
| `llama-3.3-70b-versatile` | 70B | Primário |
| `llama-3.1-70b-versatile` | 70B | Fallback #1 |
| `gemma2-9b-it` | 9B | Fallback #2 |
| `llama-3.1-8b-instant` | 8B | Fallback #3 (rápido) |
| `mixtral-8x7b-32768` | 8x7B | Fallback #4 (contexto 32k) |

### Vision Models (fallback sequencial)

| Modelo | Params | Uso |
|--------|--------|-----|
| `llama-3.2-90b-vision-preview` | 90B | Primário |
| `llama-3.2-11b-vision-preview` | 11B | Fallback |

O roteamento é automático: se `messages[]` contém `content[].type === "image_url"`, o worker usa o pool de visão. Caso contrário, usa o pool de texto.

---

## Mecanismos Técnicos

### Model Fallback (`tryModels`)

```
Request → Modelo[0] → 429? → Modelo[1] → 429? → ... → Modelo[N] → throw
```

Tenta cada modelo do pool sequencialmente. Em caso de HTTP 429 (rate limit), erro de rede ou resposta vazia, avança para o próximo. Se todos falharem, retorna o último erro.

### Think Mode (Refinamento em Loop)

```
User prompt → Modelo → Resposta R₀
R₀ + REFINE_INSTRUCTION → Modelo → Resposta R₁  (temp: 0.5)
R₁ + REFINE_INSTRUCTION → Modelo → Resposta R₂  (temp: 0.5)
R₂ + REFINE_INSTRUCTION → Modelo → Resposta R₃  (temp: 0.5)
                                    └── cleanRefinedOutput(R₃) → Final
```

3 passagens de refinamento onde a resposta anterior é submetida como contexto + instrução de melhoria. `cleanRefinedOutput()` remove artefatos de meta-texto via regex (ex: "aqui está a versão melhorada...").

### Busca Web Dual

1. **DuckDuckGo Instant Answer API** → instant answers + related topics (até 5)
2. **Wikipedia REST API** (`pt.wikipedia.org`) → resumo da página
3. **Fallback**: `en.wikipedia.org` se PT não retornar resultado
4. Contexto formatado e injetado no system prompt como `## CONTEXTO DE PESQUISA WEB`

### Vision Routing

Detecção automática de imagens no array `messages.content[]`. Se qualquer mensagem contém `{ type: "image_url" }`, o request é roteado para `VISION_MODELS` ao invés de `TEXT_MODELS`.

### Client-Side Throttling

- Intervalo mínimo de 1000ms entre chamadas à API
- Auto-retry com backoff exponencial (até 5 tentativas)
- Fallback de modelo no client se o server retornar 429

---

## Funcionalidades

### 1. Simplificar Texto

Reescrita de textos complexos em linguagem acessível.

- Input: texto livre (max 15.000 chars)
- Prompt: especialista em comunicação clara
- Output: versão simplificada + resumo breve
- Botão de copiar resultado

### 2. Roteiro de Estudos

Geração de planos de estudo personalizados.

- Inputs: objetivo de aprendizado + tempo disponível + contexto opcional
- Prompt: pedagogo especialista em aprendizagem acelerada
- Output: roteiro estruturado em fases com recursos gratuitos (YouTube, Khan Academy, Brasil Escola)

### 3. Tutor IA

Sistema interativo de ensino com 3 modos pedagógicos.

**Setup:**
- Matéria (livre) + Nível (Iniciante/Intermediário/Avançado)
- Modo: `aprendizado` | `explicacao_pratica` | `prova`
- Tipo de questão: `mista` (objetiva + dissertativa) | `objetiva`

**Modos:**

| Modo | Método | Comportamento |
|------|--------|---------------|
| Aprendizado | Socrático | Conversa livre, perguntas guiadas, analogias do cotidiano |
| Explicação + Prática | Expositivo + Exercícios | Explica conceito → aplica questões → feedback → próximo tópico |
| Prova | Avaliativo | Questões contínuas com feedback imediato |

**Parsing de questões** — formato custom:

```
[Q_OBJ]                    [Q_DIS]
Texto da pergunta          Texto da pergunta dissertativa
A) opção                   [/Q_DIS]
B) opção
C) opção
D) opção
[GAB:C]
[/Q_OBJ]
```

**Pontuação:** +10 (objetiva correta) · +5 (dissertativa submetida)

**Features adicionais:**
- Upload de imagens (fotos de caderno, diagramas, screenshots de código)
- Busca web contextual via toggle
- Quick actions: "Explica melhor", "Exemplo prático", "Resumo", "Próximo tópico"
- Base de recursos embutida (~50 links) mapeada por keyword (fotossíntese, Python, física, etc.)

### 4. Chat Livre (`chat.html`)

Chat conversacional sem estrutura de aula.

**Modos:**

| Modo | Passes | Temperatura | Latência |
|------|--------|-------------|----------|
| Quick | 1 | 0.7 | ~2-4s |
| Think | 1 + 3 refinamentos | 0.5 | ~12-18s |

**Features:**
- Suporte a imagens (upload + paste de clipboard)
- Resize automático: max 1024px, JPEG quality 0.85, limit 20MB
- Imagens removidas do histórico após 4 turnos (economia de tokens)
- Busca web integrada (DuckDuckGo + Wikipedia)
- Markdown rendering custom (code blocks, headers, listas, bold/italic, blockquotes, links)
- Auto-grow textarea
- Indicador de progresso do refinamento ("Refinando 1/3... 2/3... 3/3...")

---

## Stack Técnico

### Frontend

| Tecnologia | Uso |
|-----------|-----|
| HTML5 + CSS3 + Vanilla JS (ES6+) | Sem frameworks, sem build step |
| CSS Custom Properties | Sistema de temas (dark/mid/light) |
| Google Fonts | Figtree, Instrument Serif, Inter, JetBrains Mono |
| Canvas API | Resize de imagens antes do upload |
| LocalStorage | Persistência de tema |

### Backend

| Serviço | Função |
|---------|--------|
| Cloudflare Workers | Runtime serverless (V8 isolate) |
| Groq API | Inferência LLM/VLM (OpenAI-compatible) |
| DuckDuckGo Instant Answer API | Busca web sem API key |
| Wikipedia REST API | Conteúdo factual (pt-BR + en fallback) |

### Deploy

| Ferramenta | Função |
|-----------|--------|
| Wrangler CLI | Deploy do Worker + gestão de secrets |
| GitHub Pages | Hosting do frontend estático |

---

## Setup

```bash
# 1. Clone
git clone https://github.com/Melowwzz/Claritool.git
cd Claritool

# 2. Instale o Wrangler
npm install -g wrangler

# 3. Configure a API key do Groq como secret
wrangler secret put GROQ_API_KEY

# 4. Deploy do Worker
wrangler deploy

# 5. Frontend: sirva index.html e chat.html via GitHub Pages ou qualquer hosting estático
```

### Variáveis de ambiente

| Variável | Tipo | Obrigatório | Descrição |
|----------|------|-------------|-----------|
| `GROQ_API_KEY` | Secret | Sim | Chave da API Groq (obtida em console.groq.com) |

---

## Estrutura do Projeto

```
Claritool/
├── worker.js          # Cloudflare Worker — API proxy, model fallback, search, refinement
├── wrangler.toml      # Configuração do Wrangler (entry point, compatibility date)
├── index.html         # App principal — Simplificar, Roteiro, Tutor IA
├── chat.html          # Chat livre — Quick/Think mode, search, vision
└── .gitignore         # Exclui .wrangler/
```

---

## Segurança

- **API key** armazenada como Cloudflare Secret (nunca exposta no frontend)
- **CORS** aberto (`*`) — adequado para ferramenta educacional pública
- **Validação de input**: limite de caracteres (15k), tamanho de imagem (20MB), pool fixo de modelos
- **Sem dados persistentes**: histórico vive apenas na sessão do browser (in-memory)

--
