import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'

export const name = 'openai-codex-oauth'
export const inject = ['commands', 'credentials', 'userQuestions']

const PROVIDER = 'openai-codex'
const DEFAULT_OAUTH_CREDENTIAL_REF = 'OPENAI_CODEX_OAUTH_CREDENTIAL'
const DEFAULT_ACCESS_TOKEN_REF = 'OPENAI_CODEX_ACCESS_TOKEN'
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000
const WAIT_FOR_CALLBACK_LABEL = '等待浏览器自动返回'

export interface Config {
  /** Harness credential reference containing the complete pi-ai OAuth credential as JSON. */
  oauthCredentialRef?: string
  /** Refresh an expiring credential this many milliseconds before its expiry time. */
  refreshBeforeMs?: number
}

export const Config: z<Config> = z.object({
  oauthCredentialRef: z.string().role('credential-ref').default(DEFAULT_OAUTH_CREDENTIAL_REF),
  refreshBeforeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REFRESH_BEFORE_MS),
})

interface ResolvedConfig {
  oauthCredentialRef: CredentialRef
  accessTokenRef: CredentialRef
  refreshBeforeMs: number
}

interface DeviceNotice {
  controller: AbortController
  settled: Promise<void>
}

function oauthAuth(): OAuthAuth {
  const oauth = openaiCodexProvider().auth.oauth
  if (oauth === undefined) {
    throw new Error('openai-codex provider does not expose OAuth in the installed pi-ai release')
  }
  return oauth
}

function parseOAuthCredential(raw: string): OAuthCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('stored OpenAI OAuth credential is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('stored OpenAI OAuth credential has an invalid value')
  }
  const candidate = value as Partial<OAuthCredential>
  if (candidate.type !== 'oauth'
    || typeof candidate.access !== 'string' || candidate.access.length === 0
    || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
    || typeof candidate.expires !== 'number' || !Number.isFinite(candidate.expires)) {
    throw new Error('stored OpenAI OAuth credential is missing required fields')
  }
  return value as OAuthCredential
}

function answerValue(answer: Awaited<ReturnType<Context['userQuestions']['ask']>>, id: string): string {
  const item = answer.answers.find(entry => entry.id === id)
  const custom = item?.custom?.trim()
  if (custom !== undefined && custom.length > 0) return custom
  const selected = item?.selected[0]
  if (selected !== undefined && selected.length > 0) return selected
  throw new Error('OAuth login needs an answer to continue')
}

function combinedSignal(first: AbortSignal, second: AbortSignal | undefined): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second])
}

function promptDetail(prompt: AuthPrompt, authorizationUrl: string | undefined): string | undefined {
  const parts: string[] = []
  if (authorizationUrl !== undefined) {
    parts.push(`[打开 OpenAI 登录页](${authorizationUrl})`)
    parts.push('完成登录后，此窗口会自动关闭。浏览器没有自动返回时，可将地址栏中的完整回调地址粘贴到下方输入框。')
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function localizedSelectOption(option: { id: string; label: string; description?: string }): {
  label: string
  description?: string
} {
  if (option.id === 'browser') {
    return { label: '浏览器登录', description: '在本机浏览器中完成 OpenAI 授权。' }
  }
  if (option.id === 'device_code') {
    return { label: '设备码登录', description: '适用于远程主机和无图形界面的环境。' }
  }
  return {
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }
}

function promptQuestion(prompt: AuthPrompt): string {
  if (prompt.type === 'select') return '选择 OpenAI 登录方式'
  if (prompt.type === 'manual_code') return '在浏览器中完成 OpenAI 登录'
  return prompt.message
}

function waitForCallback(signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('browser callback completed'))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('browser callback completed')) }, { once: true })
  })
}

async function answerAuthPrompt(
  ctx: Context,
  invocation: CommandInvocation,
  prompt: AuthPrompt,
  forcedMethod: string | undefined,
  authorizationUrl: string | undefined,
): Promise<string> {
  if (prompt.type === 'select' && forcedMethod !== undefined) return forcedMethod

  const id = `codex-oauth-${prompt.type}`
  const options = prompt.type === 'select'
    ? prompt.options.map(localizedSelectOption)
    : prompt.type === 'manual_code'
      ? [{
          label: WAIT_FOR_CALLBACK_LABEL,
          description: '页面会在 OAuth 回调成功后自动关闭。',
        }]
      : undefined
  const detail = promptDetail(prompt, authorizationUrl)
  const signal = combinedSignal(invocation.signal, prompt.signal)
  const answer = await ctx.userQuestions.ask({
    agent: invocation.agent,
    signal,
    questions: [{
      id,
      header: 'OpenAI 登录',
      question: promptQuestion(prompt),
      ...detail === undefined ? {} : { detail },
      ...options === undefined ? {} : { options },
    }],
  })
  const value = answerValue(answer, id)
  if (prompt.type === 'manual_code' && value === WAIT_FOR_CALLBACK_LABEL) {
    return waitForCallback(signal)
  }
  if (prompt.type !== 'select') return value
  const selected = prompt.options.find(option => localizedSelectOption(option).label === value)
  if (selected !== undefined) return selected.id
  const custom = prompt.options.find(option => option.id === value)
  if (custom !== undefined) return custom.id
  throw new Error('OAuth login method is not recognized')
}

function beginDeviceNotice(ctx: Context, invocation: CommandInvocation, event: Extract<AuthEvent, { type: 'device_code' }>): DeviceNotice {
  const controller = new AbortController()
  const signal = AbortSignal.any([invocation.signal, controller.signal])
  const expiry = event.expiresInSeconds === undefined
    ? ''
    : `\n\n授权码有效期：${event.expiresInSeconds} 秒。`
  const settled = ctx.userQuestions.ask({
    agent: invocation.agent,
    signal,
    questions: [{
      id: 'codex-device-code',
      header: 'OpenAI 设备码',
      question: '在 OpenAI 页面输入设备码，然后等待登录完成。',
      detail: `[打开 OpenAI 设备登录页](${event.verificationUri})\n\n设备码：\`${event.userCode}\`${expiry}`,
      options: [{ label: '已提交设备码', description: 'Harness 会继续轮询登录结果。' }],
    }],
  }).then(() => undefined, (error: unknown) => {
    if (!signal.aborted) {
      ctx.logger.warn(`openai-codex-oauth: device-code notice failed: ${safeInteractionError(error)}`)
    }
  })
  return { controller, settled }
}

function safeInteractionError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown interaction error'
  if (/cancel|abort/iu.test(error.message)) return 'login cancelled'
  if (/no user-questions provider/iu.test(error.message)) return 'the current Harness surface cannot show login questions'
  return 'the login interaction failed'
}

function safeLoginError(error: unknown): string {
  if (!(error instanceof Error)) return 'OpenAI OAuth 登录失败。'
  const message = error.message
  if (/cancel|abort/iu.test(message)) return 'OpenAI OAuth 登录已取消。'
  if (/device code login is not enabled/iu.test(message)) return 'OpenAI 服务器未启用设备码登录，请使用浏览器登录。'
  const status = /status\s+(\d{3})/iu.exec(message)?.[1]
  if (status !== undefined) return `OpenAI OAuth 请求失败，HTTP 状态码为 ${status}。`
  if (/state mismatch/iu.test(message)) return 'OpenAI OAuth 回调的 state 参数不匹配，请重新登录。'
  if (/Missing authorization code/iu.test(message)) return 'OpenAI OAuth 回调缺少授权码，请重新登录。'
  if (/credential/iu.test(message)) return 'Harness 凭据存储操作失败，请检查对应凭据来源是否可写。'
  return 'OpenAI OAuth 登录失败，请重新运行 /codex-login。'
}

function requestedMethod(rawInput: string): string | undefined {
  const value = rawInput.trim().toLowerCase()
  if (value.length === 0) return undefined
  if (value === 'browser') return 'browser'
  if (value === 'device' || value === 'device-code' || value === 'device_code') return 'device_code'
  throw new Error('用法：/codex-login [browser|device]')
}

function expiryDescription(credential: OAuthCredential): string {
  const remainingMinutes = Math.max(0, Math.ceil((credential.expires - Date.now()) / 60_000))
  return `${new Date(credential.expires).toISOString()}（约 ${remainingMinutes} 分钟后）`
}

async function assertWritable(ctx: Context, ref: CredentialRef): Promise<void> {
  const info = await ctx.credentials.describe(ref)
  if (!info.writable) {
    throw new Error(`credential reference ${ref} is supplied by read-only source ${info.source ?? 'unknown'}`)
  }
}

function createExclusiveRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    oauthCredentialRef: credentialRef(config.oauthCredentialRef ?? DEFAULT_OAUTH_CREDENTIAL_REF),
    accessTokenRef: credentialRef(DEFAULT_ACCESS_TOKEN_REF),
    refreshBeforeMs: config.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS,
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const oauth = oauthAuth()
  const exclusive = createExclusiveRunner()
  let loginInProgress = false

  const persist = async (credential: OAuthCredential): Promise<void> => {
    await ctx.credentials.set(resolved.oauthCredentialRef, JSON.stringify(credential))
    await ctx.credentials.set(resolved.accessTokenRef, credential.access)
  }

  const ensureAccessToken = (signal: AbortSignal): Promise<void> => exclusive(async () => {
    if (signal.aborted) {
      throw new LlmError('OpenAI Codex request was aborted before authentication completed.', 'ABORTED')
    }
    const access = await ctx.credentials.resolve(resolved.accessTokenRef)
    if (access !== undefined && access.value.length > 0 && access.source !== 'file') return

    const stored = await ctx.credentials.resolve(resolved.oauthCredentialRef)
    if (stored === undefined) {
      if (access !== undefined && access.value.length > 0) return
      throw new LlmError(
        'OpenAI Codex OAuth is not configured. Run /codex-login, then retry the request.',
        'AUTH',
      )
    }

    let credential: OAuthCredential
    try {
      credential = parseOAuthCredential(stored.value)
    } catch (error: unknown) {
      throw new LlmError(
        'The stored OpenAI Codex OAuth credential is invalid. Run /codex-login again.',
        'AUTH',
        { cause: error },
      )
    }

    if (credential.expires > Date.now() + resolved.refreshBeforeMs) {
      if (access === undefined || access.value !== credential.access) {
        await ctx.credentials.set(resolved.accessTokenRef, credential.access)
      }
      return
    }

    let refreshed: OAuthCredential
    try {
      refreshed = await oauth.refresh(credential, signal)
    } catch {
      throw new LlmError(
        'OpenAI Codex OAuth refresh failed. Run /codex-login again.',
        'AUTH',
      )
    }
    await persist(refreshed)
  })

  const login = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (loginInProgress) return { kind: 'error', text: '另一个 OpenAI OAuth 登录正在进行。' }
    loginInProgress = true
    const notices: DeviceNotice[] = []
    let authorizationUrl: string | undefined
    try {
      const method = requestedMethod(invocation.rawInput)
      await assertWritable(ctx, resolved.oauthCredentialRef)
      await assertWritable(ctx, resolved.accessTokenRef)
      const interaction: AuthInteraction = {
        signal: invocation.signal,
        prompt: prompt => answerAuthPrompt(ctx, invocation, prompt, method, authorizationUrl),
        notify: event => {
          if (event.type === 'auth_url') authorizationUrl = event.url
          if (event.type === 'device_code') notices.push(beginDeviceNotice(ctx, invocation, event))
          if (event.type === 'info' || event.type === 'progress') {
            ctx.logger.info(`openai-codex-oauth: ${event.message}`)
          }
        },
      }
      const credential = await oauth.login(interaction)
      await exclusive(() => persist(credential))
      return {
        kind: 'success',
        text: `OpenAI Codex OAuth 登录成功。访问令牌到期时间：${expiryDescription(credential)}。`,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: safeLoginError(error) }
    } finally {
      loginInProgress = false
      for (const notice of notices) notice.controller.abort('OAuth login settled')
      await Promise.allSettled(notices.map(notice => notice.settled))
    }
  }

  const logout = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: '用法：/codex-logout' }
    try {
      await exclusive(async () => {
        await ctx.credentials.unset(resolved.oauthCredentialRef)
        await ctx.credentials.unset(resolved.accessTokenRef)
      })
      return { kind: 'success', text: 'OpenAI Codex OAuth 凭据已清除。' }
    } catch (error: unknown) {
      return { kind: 'error', text: safeLoginError(error) }
    }
  }

  const status = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: '用法：/codex-status' }
    const stored = await ctx.credentials.resolve(resolved.oauthCredentialRef)
    if (stored !== undefined) {
      try {
        const credential = parseOAuthCredential(stored.value)
        return {
          kind: 'success',
          text: `OpenAI Codex OAuth：已登录。访问令牌到期时间：${expiryDescription(credential)}。凭据来源：${stored.source}。`,
        }
      } catch {
        return { kind: 'error', text: 'OpenAI Codex OAuth 凭据格式错误，请重新运行 /codex-login。' }
      }
    }
    const access = await ctx.credentials.resolve(resolved.accessTokenRef)
    if (access !== undefined && access.value.length > 0) {
      return { kind: 'success', text: `OpenAI Codex：访问令牌已配置。凭据来源：${access.source}。` }
    }
    return { kind: 'success', text: 'OpenAI Codex 登录状态：未配置。运行 /codex-login 开始登录。' }
  }

  ctx.commands.register({
    name: 'codex-login',
    description: '使用 ChatGPT Plus/Pro 登录 OpenAI Codex',
    input: { hint: '[browser|device]' },
    handler: login,
  })
  ctx.commands.register({
    name: 'codex-logout',
    description: '清除 OpenAI Codex OAuth 凭据',
    handler: logout,
  })
  ctx.commands.register({
    name: 'codex-status',
    description: '查看 OpenAI Codex OAuth 状态',
    handler: status,
  })

  ctx.on('agent/request', async ({ signal }, next) => {
    const request = await next()
    if (request.provider === PROVIDER) await ensureAccessToken(signal)
    if (signal.aborted) {
      throw new LlmError('OpenAI Codex request was aborted before authentication completed.', 'ABORTED')
    }
    return request
  })
}
