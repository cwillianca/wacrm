import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  generateHandoffSummary: vi.fn(),
  notifyHandoff: vi.fn(),
  addContactTagAndDispatch: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    tags: [] as { id: string; name: string }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./summary', () => ({ generateHandoffSummary: h.generateHandoffSummary }))
vi.mock('./notify-handoff', () => ({ notifyHandoff: h.notifyHandoff }))
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: h.addContactTagAndDispatch,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'tags') {
        // .select().eq() → the account's tag rows
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: h.state.tags, error: null }),
          }),
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
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
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.tags = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.generateHandoffSummary.mockResolvedValue({ summary: 'Customer summary.', tagNames: [] })
  h.notifyHandoff.mockResolvedValue(undefined)
  h.addContactTagAndDispatch.mockResolvedValue({ added: true, dispatched: true })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('does not notify anyone when handoffNotifyPhone is not set', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateHandoffSummary).not.toHaveBeenCalled()
    expect(h.notifyHandoff).not.toHaveBeenCalled()
  })

  it('notifies handoffNotifyPhone with an AI summary on explicit handoff', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffNotifyPhone: '5511999999999' }),
    )
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateHandoffSummary).toHaveBeenCalled()
    expect(h.notifyHandoff).toHaveBeenCalledWith({
      accountId: 'acct-1',
      phone: '5511999999999',
      summary: 'Customer summary.',
    })
  })

  it('skips the notification when summary generation fails', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffNotifyPhone: '5511999999999' }),
    )
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.generateHandoffSummary.mockResolvedValue({ summary: null, tagNames: [] })
    await dispatchInboundToAiReply(ARGS)
    expect(h.notifyHandoff).not.toHaveBeenCalled()
  })

  it('tags the contact when the model picks one of the account tags', async () => {
    h.state.tags = [
      { id: 'tag-familia', name: 'Família' },
      { id: 'tag-civel', name: 'Cível' },
    ]
    h.generateHandoffSummary.mockResolvedValue({
      summary: 'Cliente quer marcar consulta.',
      tagNames: ['família'], // different casing than the stored tag
    })
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateHandoffSummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ['Família', 'Cível'],
    )
    expect(h.addContactTagAndDispatch).toHaveBeenCalledWith({
      db: expect.anything(),
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-familia',
    })
  })

  it('does not tag when the model picks a name that matches no account tag', async () => {
    h.state.tags = [{ id: 'tag-familia', name: 'Família' }]
    h.generateHandoffSummary.mockResolvedValue({
      summary: 'Cliente quer marcar consulta.',
      tagNames: ['Tributário'],
    })
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.addContactTagAndDispatch).not.toHaveBeenCalled()
  })

  it('runs the analysis for tagging alone, even without a notify phone', async () => {
    h.state.tags = [{ id: 'tag-familia', name: 'Família' }]
    h.generateHandoffSummary.mockResolvedValue({
      summary: 'Cliente quer marcar consulta.',
      tagNames: ['Família'],
    })
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateHandoffSummary).toHaveBeenCalled()
    expect(h.notifyHandoff).not.toHaveBeenCalled() // still no phone configured
    expect(h.addContactTagAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ tagId: 'tag-familia' }),
    )
  })

  it('applies every matched tag when the model returns more than one', async () => {
    h.state.tags = [
      { id: 'tag-civel', name: 'Cível' },
      { id: 'tag-urgente', name: 'URGENTE' },
      { id: 'tag-familia', name: 'Família' },
    ]
    h.generateHandoffSummary.mockResolvedValue({
      summary: 'Cliente foi intimado, caso urgente.',
      tagNames: ['Cível', 'URGENTE'],
    })
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.addContactTagAndDispatch).toHaveBeenCalledTimes(2)
    expect(h.addContactTagAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ tagId: 'tag-civel' }),
    )
    expect(h.addContactTagAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ tagId: 'tag-urgente' }),
    )
  })
})

describe('dispatchInboundToAiReply — reply cap reached', () => {
  it('finalizes the handoff on the reply that reaches the cap, even without the sentinel', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 2, // one below the default cap of 3
    }
    h.generateReply.mockResolvedValue({ text: 'Last one!', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled() // the final reply still sends
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('does not finalize on a reply that leaves slots remaining', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.generateReply.mockResolvedValue({ text: 'First reply', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('notifies handoffNotifyPhone when the capped reply ends the conversation', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffNotifyPhone: '5511999999999' }),
    )
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 2,
    }
    h.generateReply.mockResolvedValue({ text: 'Last one!', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.notifyHandoff).toHaveBeenCalledWith({
      accountId: 'acct-1',
      phone: '5511999999999',
      summary: 'Customer summary.',
    })
  })
})
