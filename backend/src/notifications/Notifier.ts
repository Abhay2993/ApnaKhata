/**
 * ApnaKhata — Notification transport abstraction
 * ----------------------------------------------
 * The SMS / WhatsApp provider (MSG91, Gupshup, …) is injected behind this
 * interface so the ledger services stay provider-agnostic and unit-testable.
 */

export type NotificationChannel = 'SMS' | 'WHATSAPP';

export interface NotificationMessage {
  channel: NotificationChannel;
  toPhone: string; // E.164
  templateKey: string;
  body: string;
  variables?: Record<string, string>;
}

export interface NotificationResult {
  providerMessageId: string;
}

export interface Notifier {
  send(message: NotificationMessage): Promise<NotificationResult>;
}

/**
 * Development / test transport: logs instead of dispatching. Swap for a real
 * MSG91 or Gupshup adapter in production wiring.
 */
export class ConsoleNotifier implements Notifier {
  async send(message: NotificationMessage): Promise<NotificationResult> {
    // eslint-disable-next-line no-console
    console.log(`[${message.channel}] → ${message.toPhone}: ${message.body}`);
    return { providerMessageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}
