import type { Context } from '@deepseek-ai/cordis'

export const name: 'dsh-speckit-workflow'
export const TOOL_NAME: 'speckit_sdd'
export const RPC_CHANNEL: '/api/dsh-speckit-workflow'
export const PLUGIN_VERSION: '0.8.0'
export const inject: string[]

export declare function apply(ctx: Context): void | (() => void) | (() => Promise<void>)

export declare class Ledger {
  constructor(options?: { path?: string; forceSqlite?: boolean; forceJson?: boolean })
  readonly backend: 'sqlite' | 'json'
  readonly path: string
  transaction<T>(fn: (tx: unknown) => T): T
}

export declare class Orchestrator {
  constructor(deps: { ledger: Ledger })
  createInstance(input: { workspacePath: string; feature: string; config?: Record<string, unknown> }): { instanceId: string; stageRowId: number; stageId: string }
}

export declare class StageThreads {
  constructor(deps: { ctx: Context; ledger: Ledger; orchestrator: Orchestrator; config?: { provider?: string } })
  readonly provider: string
}
