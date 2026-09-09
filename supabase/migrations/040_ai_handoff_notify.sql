-- ============================================================
-- 040_ai_handoff_notify.sql — notify a third WhatsApp number on handoff
--
-- Lets an account configure a phone number that gets an AI-written
-- summary via WhatsApp whenever the auto-reply bot hands a conversation
-- off to a human (explicit handoff sentinel, or the per-conversation
-- reply cap being reached). Sent as an approved template — the number
-- being notified has (by definition) never messaged the business
-- number itself, so there is never an open 24h session window to send
-- free-form text through.
--
-- Nullable and independent of `auto_reply_enabled`: leaving it unset
-- keeps today's behaviour (internal note only, no outbound WhatsApp
-- notification).
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_notify_phone text;

COMMENT ON COLUMN ai_configs.handoff_notify_phone IS
  'E.164-ish phone number (digits, optional leading +) to notify via WhatsApp template when the auto-reply bot hands a conversation off. Null disables the notification.';
