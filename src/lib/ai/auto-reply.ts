import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { generateHandoffSummary } from './summary'
import { notifyHandoff } from './notify-handoff'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import type { AiConfig, ChatMessage } from './types'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * Common end-of-automation step: disable further auto-replies on this
 * thread, route it to a human, leave an internal note, and — when the
 * account configured a `handoffNotifyPhone` and/or has any contact tags
 * defined — ask the model for a written summary and/or a best-fit tag
 * classification (one call covers both, so having both features on
 * doesn't double the token spend). Shared by the two ways a
 * conversation ends up here: the model explicitly asking to hand off,
 * and the reply cap being reached on what was otherwise a normal send.
 */
async function finalizeHandoff(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  config: AiConfig
  messages: ChatMessage[]
  replyCount: number
  assignedAgentId: string | null
}): Promise<void> {
  const { db, accountId, conversationId, contactId, config, messages, replyCount, assignedAgentId } =
    args

  const note = buildHandoffSummary({ messages, replyCount })
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: note,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment.
  if (config.handoffAgentId && !assignedAgentId) {
    update.assigned_agent_id = config.handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', conversationId)

  // Classifying into an account tag only makes sense if the account
  // has defined any — an AI-invented tag name would have nothing to
  // attach to. Skip the whole analysis call when neither feature is
  // in play so a plain handoff (no notify phone, no tags) costs
  // nothing extra on the account's key.
  const { data: accountTags } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
  const tagOptions = (accountTags ?? []).map((t) => t.name as string)

  if (!config.handoffNotifyPhone && tagOptions.length === 0) return

  const { summary, tagNames } = await generateHandoffSummary(config, messages, tagOptions)

  if (config.handoffNotifyPhone && summary) {
    await notifyHandoff({ accountId, phone: config.handoffNotifyPhone, summary })
  }

  for (const tagName of tagNames) {
    const matched = (accountTags ?? []).find(
      (t) => (t.name as string).toLowerCase() === tagName.toLowerCase(),
    )
    if (matched) {
      await addContactTagAndDispatch({
        db,
        accountId,
        contactId,
        tagId: matched.id as string,
      })
    }
  }
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human (sticky until re-enabled).
      // Assigning fires the `on_conversation_assigned` trigger, which
      // notifies the agent.
      await finalizeHandoff({
        db,
        accountId,
        conversationId,
        contactId,
        config,
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        assignedAgentId: conv.assigned_agent_id,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // `claimed === true` means this send consumed the slot at
    // `conv.ai_reply_count + 1` (the claim's own UPDATE incremented
    // exactly once — no extra read needed). When that's the last
    // allowed slot, this was the bot's final word on the thread even
    // though it never emitted the handoff sentinel — finalize the same
    // way so it isn't left silently un-handed-off (see the module doc).
    const newReplyCount = (conv.ai_reply_count ?? 0) + 1
    if (newReplyCount >= config.autoReplyMaxPerConversation) {
      await finalizeHandoff({
        db,
        accountId,
        conversationId,
        contactId,
        config,
        messages,
        replyCount: newReplyCount,
        assignedAgentId: conv.assigned_agent_id,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
