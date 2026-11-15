/**
 * Trimmed ambient declarations for the DSH 0.2.2-rc.3 packages consumed by
 * `src/index.ts`.
 *
 * This standalone fork cannot reproduce the upstream pnpm workspace type graph
 * offline (installation is out of scope), so this file models only the public
 * surface the production source actually touches. Every member name and shape
 * below is taken from upstream tag `dsh-v0.2.2-rc.3`
 * (commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced), see UPSTREAM.md.
 * Members the patched file does not use are intentionally omitted rather than
 * invented; a real monorepo `pnpm typecheck` remains the definitive check.
 */

type TrimmedContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }

interface TrimmedMessageSource {
  readonly kind: string
  readonly rpcId?: unknown
  readonly senderSessionId?: unknown
}

interface TrimmedRequestMessage {
  readonly role: string
  readonly content: readonly TrimmedContentBlock[]
}

interface TrimmedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

type TrimmedFinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | {
    readonly kind: 'error' | 'aborted'
    readonly failure: { readonly code: string; readonly message: string }
  }

type TrimmedStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: string
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: TrimmedContentBlock }
  | { readonly type: 'usage'; readonly usage: unknown }
  | { readonly type: 'finish'; readonly reason: TrimmedFinishReason }

interface TrimmedSessionEvent {
  // `any` keeps `Extract<SessionEvent, { type: 'tool/call' }>` usable without
  // rebuilding the full upstream event union in this trimmed harness.
  readonly type: any
  readonly seq: number
  // Reviewer code only branches on `type` and reads event-specific fields; the
  // real per-event payload union is intentionally not rebuilt here.
  readonly data: any
}

interface TrimmedSessionHeader {
  readonly origin?: string
  readonly parentSession?: string
}

interface TrimmedSessionSurface {
  readonly nodes: readonly number[]
}

interface TrimmedRequestHeader {
  readonly config: { readonly provider: string; readonly model: string }
  readonly tools?: readonly TrimmedToolSchema[]
}

interface TrimmedSession {
  readonly id: string
  readonly header: TrimmedSessionHeader
  readonly surface: TrimmedSessionSurface
  snapshotEvents(): readonly TrimmedSessionEvent[]
  requestHeader(): TrimmedRequestHeader | undefined
  isOwnSeq(seq: number): boolean
}

interface TrimmedAgent {
  readonly session: TrimmedSession
}

interface TrimmedGenerateOptions {
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly TrimmedRequestMessage[]
  readonly temperature?: number
  readonly sessionId?: string
  readonly purpose?: string
  readonly signal?: AbortSignal
}

interface TrimmedToolExecution {
  readonly name: string
  readonly callId: string
  readonly rootCallId: string
  readonly parent?: unknown
  readonly arguments: unknown
  readonly schema?: TrimmedToolSchema
  readonly agent?: TrimmedAgent
  readonly signal: AbortSignal
}

interface TrimmedToolErrorInfo {
  readonly name: string
  readonly code: string
  readonly reason?: string
}

type TrimmedPreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly info?: TrimmedToolErrorInfo }
  | { readonly kind: 'cancel' }
  | {
    readonly kind: 'ask'
    readonly reason?: string
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  }

declare module '@deepseek-ai/cordis' {
  export const FiberState: { readonly ACTIVE: string }

  export interface Context {
    effect(setup: () => Generator<unknown, void, unknown>, label?: string): unknown
    on(
      event: string,
      listener: (payload: any, next: () => Promise<any>) => any,
      options?: { readonly prepend?: boolean },
    ): () => void
    readonly sessions: { list(): Iterable<TrimmedSession> }
    readonly approval: TrimmedApprovalService
    readonly llm: { stream(options: TrimmedGenerateOptions): AsyncIterable<TrimmedStreamChunk> }
    readonly permissionPresets: TrimmedPermissionPresets
    readonly workingDirectory: { ensure(agent: TrimmedAgent, signal: AbortSignal): Promise<string> }
    readonly root: { readonly fiber: { readonly state: string } }
  }
}

declare module '@deepseek-ai/dsh-agent' {
  export type Agent = TrimmedAgent
}

declare module '@deepseek-ai/dsh-llm' {
  export type ContentBlock = TrimmedContentBlock
  export type GenerateOptions = TrimmedGenerateOptions
  export type MessageSource = TrimmedMessageSource
  export type RequestMessage = TrimmedRequestMessage
  export type StreamChunk = TrimmedStreamChunk
  export type ToolCallId = string
  export type ToolSchema = TrimmedToolSchema

  export class BlockAssembler {
    push(chunk: TrimmedStreamChunk): void
    blocks(): TrimmedContentBlock[]
  }
}

declare module '@deepseek-ai/dsh-llm/types' {
  export interface LlmRequestPurposeMap {}
}

declare module '@deepseek-ai/dsh-session' {
  export type Session = TrimmedSession
  export type SessionEvent = TrimmedSessionEvent
}

declare module '@deepseek-ai/dsh-tools' {
  export const RUN_CODE_NAME: string
  export type PreToolDecision = TrimmedPreToolDecision
  export type ToolExecution = TrimmedToolExecution
}

declare module '@deepseek-ai/dsh-util-values' {
  export function deepFreeze<T>(value: T): T
}

declare module '@deepseek-ai/dsh-permission-presets' {
  export const AUTO_PRESET: string
}

interface TrimmedApprovalRequest {
  readonly agent: TrimmedAgent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

type TrimmedApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface TrimmedApprovalService {
  readonly config: { readonly policy?: 'ask' | 'never' }
  overrideOf(session: TrimmedSession): 'ask' | 'never' | undefined
  request(req: TrimmedApprovalRequest): Promise<TrimmedApprovalOutcome>
}

interface TrimmedPermissionPresets {
  current(session: TrimmedSession): string
  registerAuto(admit: () => void): () => Promise<void>
  set(session: TrimmedSession, name: string): void
}

// Side-effect type imports in the upstream source augment these packages.
declare module '@deepseek-ai/dsh-agent-instructions' {}
declare module '@deepseek-ai/dsh-subagent' {}
declare module '@deepseek-ai/dsh-user-approval' {
  export type ApprovalOutcome = TrimmedApprovalOutcome
  export type ApprovalRequest = TrimmedApprovalRequest
}
declare module '@deepseek-ai/dsh-working-directory' {}
declare module '@deepseek-ai/dsh-tool-executor-ptc/types' {}

/**
 * Trimmed `@deepseek-ai/schemastery` declarations covering only the Loader
 * config schema the fork builds: an object with volatile number fields. The
 * real package supplies the same surface with full validation at runtime.
 */
declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    readonly meta: { readonly volatile?: boolean; readonly default?: T; readonly min?: number; readonly max?: number }
    default(value: T): Schema<T>
    volatile(): Schema<T>
  }
  export interface NumberSchema extends Schema<number> {
    min(value: number): NumberSchema
    max(value: number): NumberSchema
  }
  export interface SchemaFactory {
    number(): NumberSchema
    object(shape: Record<string, Schema<any>>): Schema<unknown>
  }
  const z: SchemaFactory
  export default z
}
