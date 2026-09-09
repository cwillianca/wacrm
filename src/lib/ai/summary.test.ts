import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({ generateReply: vi.fn() }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))

import { generateHandoffSummary } from './summary'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: 'sk-ant-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    handoffNotifyPhone: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.generateReply.mockReset()
})

describe('generateHandoffSummary', () => {
  it('returns the generated text with no tags when tagOptions is empty', async () => {
    h.generateReply.mockResolvedValue({ text: 'João quer marcar consulta.', handoff: false })
    const result = await generateHandoffSummary(config(), [
      { role: 'user', content: 'Meu nome é João, preciso de ajuda.' },
    ])
    expect(result).toEqual({ summary: 'João quer marcar consulta.', tagNames: [] })
  })

  it('parses the trailing TAG line and strips it from the summary', async () => {
    h.generateReply.mockResolvedValue({
      text: 'João quer marcar consulta sobre pensão.\nTAG: Família',
      handoff: false,
    })
    const result = await generateHandoffSummary(
      config(),
      [{ role: 'user', content: 'Preciso de ajuda com pensão alimentícia' }],
      ['Família', 'Cível'],
    )
    expect(result).toEqual({
      summary: 'João quer marcar consulta sobre pensão.',
      tagNames: ['Família'],
    })
  })

  it('parses multiple comma-separated tags (e.g. specialty + urgency)', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Cliente foi intimado e precisa de retorno urgente.\nTAG: Cível, URGENTE',
      handoff: false,
    })
    const result = await generateHandoffSummary(
      config(),
      [{ role: 'user', content: 'Fui intimado, preciso de ajuda urgente' }],
      ['Cível', 'Família', 'URGENTE'],
    )
    expect(result.tagNames).toEqual(['Cível', 'URGENTE'])
  })

  it('deduplicates repeated tag names', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Resumo.\nTAG: Cível, Cível',
      handoff: false,
    })
    const result = await generateHandoffSummary(
      config(),
      [{ role: 'user', content: 'x' }],
      ['Cível'],
    )
    expect(result.tagNames).toEqual(['Cível'])
  })

  it('treats "TAG: none" as no classification', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Cliente só pediu o endereço do escritório.\nTAG: none',
      handoff: false,
    })
    const result = await generateHandoffSummary(
      config(),
      [{ role: 'user', content: 'Qual o endereço?' }],
      ['Família', 'Cível'],
    )
    expect(result.tagNames).toEqual([])
    expect(result.summary).toBe('Cliente só pediu o endereço do escritório.')
  })

  it('returns empty results without calling the provider when there are no messages', async () => {
    const result = await generateHandoffSummary(config(), [])
    expect(result).toEqual({ summary: null, tagNames: [] })
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('returns empty results (never throws) when the provider call fails', async () => {
    h.generateReply.mockRejectedValue(new Error('provider down'))
    const result = await generateHandoffSummary(config(), [
      { role: 'user', content: 'hi' },
    ])
    expect(result).toEqual({ summary: null, tagNames: [] })
  })

  it('returns empty results when the provider returns empty text', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: false })
    const result = await generateHandoffSummary(config(), [
      { role: 'user', content: 'hi' },
    ])
    expect(result).toEqual({ summary: null, tagNames: [] })
  })

  it('sends the transcript as a single synthetic user turn, not a multi-turn replay', async () => {
    // Regression guard: replaying the conversation as real multi-turn
    // `messages` (the shape used for an actual customer-facing reply)
    // measurably makes the model continue the support chat instead of
    // analyzing it — see the comment on formatTranscript(). The fix is
    // to always collapse the transcript into one data blob.
    h.generateReply.mockResolvedValue({ text: 'Resumo.', handoff: false })
    await generateHandoffSummary(config(), [
      { role: 'user', content: 'Primeira mensagem' },
      { role: 'assistant', content: 'Primeira resposta' },
      { role: 'user', content: 'Segunda mensagem' },
    ])
    const call = h.generateReply.mock.calls[0][0]
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].role).toBe('user')
    expect(call.messages[0].content).toBe(
      'Conversation transcript:\n\n' +
        'Customer: Primeira mensagem\n' +
        'Business: Primeira resposta\n' +
        'Customer: Segunda mensagem',
    )
  })
})
