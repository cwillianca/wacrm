import { supabaseAdmin } from './admin-client'
import {
  HANDOFF_NOTIFY_TEMPLATE_LANGUAGE,
  HANDOFF_NOTIFY_TEMPLATE_NAME,
} from './defaults'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'

/**
 * Send the handoff-summary WhatsApp template to `handoffNotifyPhone`.
 *
 * The notified number has, by construction, never messaged the
 * business number itself — there is never an open 24h session window
 * to reach it with free-form text, so this always goes out as a
 * pre-approved template (see `HANDOFF_NOTIFY_TEMPLATE_NAME`, created
 * once via Settings → Templates).
 *
 * Never throws — called fire-and-forget from the auto-reply dispatch,
 * which must not fail (or delay its 200 to the webhook) because a
 * notification send hiccuped. Errors are logged only.
 */
export async function notifyHandoff(args: {
  accountId: string
  phone: string
  summary: string
}): Promise<void> {
  const { accountId, phone, summary } = args
  try {
    const db = supabaseAdmin()
    const { data: waConfig, error } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !waConfig) {
      console.error(
        `[ai handoff notify] no whatsapp_config for account ${accountId} — cannot send notification`,
      )
      return
    }

    const accessToken = decrypt(waConfig.access_token)
    await sendTemplateMessage({
      phoneNumberId: waConfig.phone_number_id,
      accessToken,
      to: phone,
      templateName: HANDOFF_NOTIFY_TEMPLATE_NAME,
      language: HANDOFF_NOTIFY_TEMPLATE_LANGUAGE,
      params: [summary],
    })
  } catch (err) {
    console.error('[ai handoff notify] unexpected error:', err)
  }
}
