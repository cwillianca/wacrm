import { buildHandoffNotificationPrompt } from './defaults'
import { generateReply } from './generate'
import type { AiConfig, ChatMessage } from './types'

const TAG_LINE = /\n?TAG:\s*(.+)\s*$/i

/**
 * Flatten the transcript into a single block of text instead of
 * replaying it as multi-turn `messages`. Replaying it turn-by-turn — the
 * shape `generateReply` uses for an actual customer-facing reply —
 * strongly primes the model to *continue* the support chat (answer the
 * customer's last message) rather than switch tasks to analyzing it:
 * observed in testing, a real multi-turn replay of a conversation about
 * a sensitive topic made the model just draft another customer reply
 * and skip the notification/tag entirely, even with explicit
 * instructions not to. Wrapping the whole thing as inline data inside
 * one synthetic user turn removes that pull.
 */
function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Business'}: ${m.content}`)
    .join('\n')
}

export interface HandoffAnalysis {
  /** Prose summary for the `handoffNotifyPhone` WhatsApp template, with
   *  the trailing `TAG:` line (if any) stripped out. Null on failure. */
  summary: string | null
  /** Tag name(s) the model picked from `tagOptions`, verbatim and
   *  deduplicated — empty when it said "none", omitted the line, or
   *  generation failed. Callers still need to match each entry
   *  case-insensitively against real tag rows; the model's exact
   *  casing isn't guaranteed. Usually one entry, but a conversation can
   *  independently be e.g. both a specialty and "urgent". */
  tagNames: string[]
}

/**
 * Generate the handoff-time analysis: the internal-notification summary
 * sent to `handoffNotifyPhone`, and (when `tagOptions` is non-empty) a
 * best-fit classification into the account's existing contact tags. One
 * call does both so a configured notify phone and tagging don't each
 * cost a separate round-trip on the account's BYO key.
 *
 * Never throws: a failed analysis must not block the handoff itself
 * (the deterministic internal note still gets set either way).
 */
export async function generateHandoffSummary(
  config: AiConfig,
  messages: ChatMessage[],
  tagOptions: string[] = [],
): Promise<HandoffAnalysis> {
  if (messages.length === 0) return { summary: null, tagNames: [] }
  try {
    const { text } = await generateReply({
      config,
      systemPrompt: buildHandoffNotificationPrompt(config.systemPrompt, tagOptions),
      messages: [
        {
          role: 'user',
          content: `Conversation transcript:\n\n${formatTranscript(messages)}`,
        },
      ],
    })
    if (!text) return { summary: null, tagNames: [] }

    const match = text.match(TAG_LINE)
    if (!match) return { summary: text, tagNames: [] }

    const summary = text.slice(0, match.index).trim()
    const tagNames = [...new Set(
      match[1]
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && t.toLowerCase() !== 'none'),
    )]
    return { summary: summary || null, tagNames }
  } catch (err) {
    console.error('[ai handoff notify] summary generation failed:', err)
    return { summary: null, tagNames: [] }
  }
}
