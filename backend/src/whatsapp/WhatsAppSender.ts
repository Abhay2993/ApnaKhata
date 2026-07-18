/**
 * ApnaKhata — WhatsApp transport abstraction
 * ------------------------------------------
 * Outbound WhatsApp is injected behind this interface so the bot logic stays
 * provider-agnostic and unit-testable. A production adapter wraps the WhatsApp
 * Business Cloud API (Meta) or a BSP like Gupshup / Wati; the sandbox stub just
 * records what would have been sent.
 *
 * Real WhatsApp messaging requires an approved WhatsApp Business Account (WABA)
 * and pre-approved message templates for business-initiated conversations.
 */

export interface WhatsAppMessage {
  toPhone: string; // E.164, e.g. +919800000002
  body: string;
}

export interface WhatsAppSender {
  send(message: WhatsAppMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Development / test transport: records outbound messages in memory (and logs
 * them) instead of dispatching. Swap for a WABA adapter in production wiring.
 */
export class ConsoleWhatsAppSender implements WhatsAppSender {
  readonly outbox: WhatsAppMessage[] = [];

  async send(message: WhatsAppMessage): Promise<{ providerMessageId: string }> {
    this.outbox.push(message);
    // eslint-disable-next-line no-console
    console.log(`[WhatsApp] → ${message.toPhone}: ${message.body}`);
    return { providerMessageId: `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}
