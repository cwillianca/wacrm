import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  decrypt: vi.fn(),
  sendTemplateMessage: vi.fn(),
  state: {
    waConfig: null as Record<string, unknown> | null,
  },
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: h.state.waConfig, error: null }),
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: h.decrypt }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: h.sendTemplateMessage,
}))

import { notifyHandoff } from './notify-handoff'
import {
  HANDOFF_NOTIFY_TEMPLATE_LANGUAGE,
  HANDOFF_NOTIFY_TEMPLATE_NAME,
} from './defaults'

beforeEach(() => {
  h.decrypt.mockReset()
  h.sendTemplateMessage.mockReset()
  h.state.waConfig = {
    phone_number_id: 'pnid-1',
    access_token: 'enc-token',
  }
  h.decrypt.mockReturnValue('plain-token')
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' })
})

describe('notifyHandoff', () => {
  it('sends the pre-approved template to the configured phone', async () => {
    await notifyHandoff({
      accountId: 'acct-1',
      phone: '5511999999999',
      summary: 'Cliente quer marcar consulta.',
    })
    expect(h.sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pnid-1',
      accessToken: 'plain-token',
      to: '5511999999999',
      templateName: HANDOFF_NOTIFY_TEMPLATE_NAME,
      language: HANDOFF_NOTIFY_TEMPLATE_LANGUAGE,
      params: ['Cliente quer marcar consulta.'],
    })
  })

  it('never throws when there is no whatsapp_config for the account', async () => {
    h.state.waConfig = null
    await expect(
      notifyHandoff({ accountId: 'acct-1', phone: '551199', summary: 'x' }),
    ).resolves.toBeUndefined()
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('never throws when the stored access token cannot be decrypted', async () => {
    h.decrypt.mockImplementation(() => {
      throw new Error('bad key')
    })
    await expect(
      notifyHandoff({ accountId: 'acct-1', phone: '551199', summary: 'x' }),
    ).resolves.toBeUndefined()
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('never throws when the Meta send fails', async () => {
    h.sendTemplateMessage.mockRejectedValue(new Error('Meta API error'))
    await expect(
      notifyHandoff({ accountId: 'acct-1', phone: '551199', summary: 'x' }),
    ).resolves.toBeUndefined()
  })
})
