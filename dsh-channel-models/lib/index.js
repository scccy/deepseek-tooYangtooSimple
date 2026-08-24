import { Buffer } from 'node:buffer'

export const name = 'dsh-channel-models'
export const inject = ['llm', 'settings', 'credentials', 'webServer']

const NS = 'llm-pi-ai'
const DISCOVER_ROUTE = '/api/dsh-channel-models/discover'
const CREATE_ROUTE = '/api/dsh-channel-models/create'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** Wire protocols the create/discover flow may write into a profile. */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

function text(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  const result = value.trim()
  if (result.length === 0 || result.length > max) throw new Error(`${name} 格式无效`)
  return result
}

function routeId(value) {
  const result = text(value, 'Provider ID', 80)
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) {
    throw new Error('Provider ID 需以小写字母开头，只能包含小写字母、数字和短横线')
  }
  return result
}

function normalizedBaseURL(value) {
  return text(value, 'API 地址', 500).replace(/\/+$/, '')
}

function endpointCandidates(value) {
  const base = normalizedBaseURL(value)
  const found = [base]
  if (/\/v1$/i.test(base)) found.push(base.slice(0, -3).replace(/\/+$/, ''))
  else found.push(`${base}/v1`)
  return [...new Set(found.filter(Boolean))]
}

function apiOf(value) {
  return PROTOCOLS.includes(value) ? value : 'openai-completions'
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function credentialRefOf(provider) {
  return `DSH_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const source = Buffer.concat(chunks).toString('utf8')
  if (source.length === 0) return {}
  const value = JSON.parse(source)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return value
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function inferReasoning(llm, modelId) {
  const found = new Set()
  for (const provider of llm.listProviders()) {
    try {
      const info = await llm.resolveModelInfo(provider.id, modelId)
      if (info.reasoning === undefined) continue
      for (const effort of info.reasoning.efforts) {
        if (LEVELS.includes(effort.id)) found.add(effort.id)
      }
    } catch {
      // A provider may not know this model ID; continue through the directory.
    }
  }
  return LEVELS.filter(level => found.has(level))
}

/**
 * Infer whether one model ID accepts image input from the current model
 * directory. The first registered provider that resolves the exact model ID
 * and declares the `image` modality wins; inference is only a hint, since the
 * same ID on a custom channel may be a different variant than on the
 * directory provider.
 * @param llm - the harness llm service.
 * @param modelId - the model ID found on the channel.
 * @returns true when some provider declares image input for this model ID.
 */
async function inferImageModality(llm, modelId) {
  for (const provider of llm.listProviders()) {
    try {
      const info = await llm.resolveModelInfo(provider.id, modelId)
      if (info.inputModalities?.includes('image')) return true
    } catch {
      // A provider may not know this model ID; continue through the directory.
    }
  }
  return false
}

function modelProfile(input, seen) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('模型配置无效')
  }
  const id = text(input.id, '模型 ID', 300)
  if (seen.has(id)) throw new Error(`模型 ID 重复: ${id}`)
  seen.add(id)

  const model = { id }
  if (typeof input.name === 'string' && input.name.trim().length > 0) model.name = input.name.trim()
  if (Number.isSafeInteger(input.contextWindow) && input.contextWindow > 0) model.contextWindow = input.contextWindow
  if (Number.isSafeInteger(input.maxTokens) && input.maxTokens > 0) model.maxTokens = input.maxTokens

  const levels = Array.isArray(input.reasoningLevels)
    ? [...new Set(input.reasoningLevels.filter(level => LEVELS.includes(level)))]
    : []
  if (levels.length > 0) {
    if (!levels.some(level => level !== 'off')) {
      throw new Error(`模型 ${id} 的推理等级不能只有 off`)
    }
    model.reasoningEfforts = Object.fromEntries(
      levels.map(level => [level, level === 'off' ? null : level]),
    )
  }
  if (input.vision === true) model.input = ['text', 'image']
  return model
}

async function describeModels(llm, provider, models) {
  const result = []
  for (const model of models) {
    try {
      const info = await llm.resolveModelInfo(provider, model.id)
      result.push({
        id: info.id,
        name: info.name,
        reasoningLevels: info.reasoning?.efforts.map(effort => effort.id) ?? [],
        vision: info.inputModalities?.includes('image') ?? false,
      })
    } catch (error) {
      result.push({ id: model.id, reasoningLevels: [], vision: false, error: safeError(error) })
    }
  }
  return result
}

export function apply(ctx) {
  const { llm, settings, credentials, webServer } = ctx

  const discover = async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const provider = routeId(body.provider)
      const api = apiOf(body.api)
      if (api === 'anthropic-messages') {
        writeJson(res, 400, { ok: false, message: 'Anthropic Messages 协议没有模型列表接口,无法自动发现;请用“手动添加模型”逐个填写' })
        return
      }
      const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim().length > 0
        ? body.apiKey.trim()
        : undefined
      const failures = []

      for (const baseURL of endpointCandidates(body.baseURL)) {
        try {
          const models = await llm.discoverModels(NS, { provider, baseURL, api, apiKey })
          const result = []
          for (const model of models) {
            result.push({
              id: model.id,
              name: model.name ?? null,
              contextWindow: model.contextWindow ?? null,
              maxTokens: model.maxTokens ?? null,
              reasoningLevels: await inferReasoning(llm, model.id),
              vision: await inferImageModality(llm, model.id),
            })
          }
          writeJson(res, 200, { ok: true, baseURL, models: result })
          return
        } catch (error) {
          failures.push({ baseURL, message: safeError(error) })
        }
      }
      writeJson(res, 400, { ok: false, failures })
    } catch (error) {
      writeJson(res, 400, { ok: false, message: safeError(error) })
    }
  }

  const create = async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const provider = routeId(body.provider)
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
      const baseURL = normalizedBaseURL(body.baseURL)
      const api = apiOf(body.api)
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const inputs = Array.isArray(body.models) ? body.models : []
      if (inputs.length === 0) throw new Error('至少选择一个模型')

      const seen = new Set()
      const models = inputs.map(input => modelProfile(input, seen))
      const credentialRef = credentialRefOf(provider)
      const current = settings.get(NS)
      const storedRef = current?.providers?.[provider]?.apiKeyEnv
      const apiKeyEnv = apiKey.length > 0
        ? credentialRef
        : typeof storedRef === 'string' && storedRef.length > 0
          ? storedRef
          : undefined

      const profile = {
        ...(displayName.length > 0 ? { displayName } : {}),
        ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
        api,
        baseURL,
        models,
      }
      if (api === 'openai-completions' && models.some(model => model.reasoningEfforts !== undefined)) {
        profile.compat = { thinkingFormat: 'openai', supportsReasoningEffort: true }
      } else if (current?.providers?.[provider]?.compat !== undefined) {
        // Settings updates merge nested objects; null removes stale completions-only compat.
        profile.compat = null
      }

      await settings.update(NS, { providers: { [provider]: profile } })
      if (apiKey.length > 0) await credentials.set(credentialRef, apiKey)

      writeJson(res, 200, {
        ok: true,
        provider,
        credentialRef: apiKeyEnv ?? null,
        models: await describeModels(llm, provider, models),
      })
    } catch (error) {
      writeJson(res, 400, { ok: false, message: safeError(error) })
    }
  }

  ctx.effect(() => {
    const disposeDiscover = webServer.register({ kind: 'exact', path: DISCOVER_ROUTE, handler: discover })
    const disposeCreate = webServer.register({ kind: 'exact', path: CREATE_ROUTE, handler: create })
    return () => {
      disposeDiscover()
      disposeCreate()
    }
  }, 'dsh-channel-models: routes')
}
