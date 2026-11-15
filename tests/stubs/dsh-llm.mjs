/**
 * Test double for `@deepseek-ai/dsh-llm` 0.2.2-rc.3, limited to the
 * `BlockAssembler` behavior used by `readDecision()`.
 *
 * This is a trimmed copy of the upstream assembly algorithm at tag
 * `dsh-v0.2.2-rc.3` (packages/llm/llm/src/assembler.ts): closed blocks win,
 * deltas before `block-end` accumulate, a re-close is ignored, and open
 * text/reasoning blocks assemble from their deltas. Only the vocabulary the
 * reviewer stream may emit is modeled; unknown chunk types fall through.
 */
export class BlockAssembler {
  #partials = new Map()
  #order = []

  push(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.#partials.has(chunk.index)) {
          this.#order.push(chunk.index)
          this.#partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallArguments: '' })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.#ensure(chunk.index, 'tool-call')
        if (partial.block) return
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, chunk.block.type)
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage':
      case 'finish':
      default:
        return
    }
  }

  #ensure(index, blockType) {
    let partial = this.#partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.#partials.set(index, partial)
      this.#order.push(index)
    }
    return partial
  }

  #assemble(partial, index) {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? `call-${String(index)}`,
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  blocks() {
    return this.#order.map(index => this.#assemble(this.#partials.get(index), index))
  }
}
