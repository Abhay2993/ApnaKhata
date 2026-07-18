/**
 * ApnaKhata — WhatsApp-first two-way bot
 * --------------------------------------
 * A single inbound handler drives every conversational flow, routed by who owns
 * the receiving WhatsApp Business number (`toPhone`):
 *
 *   • Recipient is a DISTRIBUTOR → a retailer is placing an order. The message
 *     ("10 salt aur 5 parle bhejo") is parsed, each item matched against the
 *     distributor's catalog, and a purchase order is raised automatically.
 *
 *   • Recipient is a SHOPKEEPER and the sender IS the shop owner → a khata
 *     command ("Ramesh ko paanch sau udhaar") is posted to the customer ledger.
 *
 *   • Recipient is a SHOPKEEPER and the sender is a customer → a balance / bill
 *     enquiry; the bot replies with the customer's outstanding udhaar.
 *
 * Outbound replies go through the injected WhatsAppSender. Requires an approved
 * WABA + templates in production; the sandbox sender records messages instead.
 */

import { Pool } from 'pg';

import { CustomerLedgerService } from './CustomerLedgerService';
import { PurchaseOrderService } from './PurchaseOrderService';
import { parseLedgerCommand, parseOrder } from '../nlp/CommandParser';
import { WhatsAppSender } from '../whatsapp/WhatsAppSender';

export interface InboundMessage {
  toPhone: string; // the ApnaKhata business's WhatsApp number
  fromPhone: string; // the sender
  text: string;
}

export type BotAction =
  | 'ORDER_PLACED'
  | 'ORDER_UNMATCHED'
  | 'LEDGER_POSTED'
  | 'BALANCE'
  | 'UNKNOWN_BUSINESS'
  | 'UNKNOWN_SENDER'
  | 'HELP';

export interface BotReply {
  action: BotAction;
  reply: string;
  data?: Record<string, unknown>;
}

interface BusinessUser {
  id: string;
  role: 'DISTRIBUTOR' | 'SHOPKEEPER';
  businessName: string;
  phone10: string;
}

const inr = (n: number): string => `₹${Number(n).toLocaleString('en-IN')}`;
const digits10 = (raw: string): string => raw.replace(/\D/g, '').slice(-10);

export class WhatsAppBotService {
  private readonly customers: CustomerLedgerService;

  constructor(
    private readonly db: Pool,
    private readonly sender: WhatsAppSender,
    private readonly purchaseOrders: PurchaseOrderService,
    customers?: CustomerLedgerService,
  ) {
    this.customers = customers ?? new CustomerLedgerService(db);
  }

  /** Route an inbound message, dispatch the reply, and return what happened. */
  async handleInbound(msg: InboundMessage): Promise<BotReply> {
    const business = await this.resolveUser(msg.toPhone);
    if (!business) {
      return this.reply(msg.fromPhone, {
        action: 'UNKNOWN_BUSINESS',
        reply: 'This number is not linked to an ApnaKhata business yet.',
      });
    }

    const reply =
      business.role === 'DISTRIBUTOR'
        ? await this.handleOrder(business, msg)
        : await this.handleShopMessage(business, msg);

    return this.reply(msg.fromPhone, reply);
  }

  // --- Distributor inbox: retailer order → PO --------------------------------
  private async handleOrder(distributor: BusinessUser, msg: InboundMessage): Promise<BotReply> {
    const order = parseOrder(msg.text);
    if (order.items.length === 0) {
      return {
        action: 'HELP',
        reply: `Namaste! To order from ${distributor.businessName}, send items like "10 salt, 5 oil".`,
      };
    }

    const sender = await this.resolveUser(msg.fromPhone);
    if (!sender) {
      return {
        action: 'UNKNOWN_SENDER',
        reply: 'We could not find your shop account. Please register on ApnaKhata to order.',
      };
    }

    const lines: { sku: string; quantity: number }[] = [];
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const item of order.items) {
      const product = await this.matchProduct(distributor.id, item.query);
      if (!product) {
        unmatched.push(item.query);
        continue;
      }
      // Honour the distributor's minimum order quantity.
      const quantity = Math.max(item.quantity, product.moq);
      lines.push({ sku: product.sku, quantity });
      matched.push(`${quantity} ${product.unit} ${product.productName}`);
    }

    if (lines.length === 0) {
      return {
        action: 'ORDER_UNMATCHED',
        reply: `Sorry, we couldn't match ${unmatched.join(', ')} to ${distributor.businessName}'s catalog. Try the exact product name.`,
        data: { unmatched },
      };
    }

    const po = await this.purchaseOrders.createFromCatalog(sender.id, distributor.id, lines);
    const tail = unmatched.length ? `\nNot found: ${unmatched.join(', ')}.` : '';
    return {
      action: 'ORDER_PLACED',
      reply:
        `✅ Order placed with ${distributor.businessName}\n` +
        `PO ${po.poNumber}\n${matched.map((m) => `• ${m}`).join('\n')}\n` +
        `Total ${inr(po.totalAmount)}${tail}`,
      data: { purchaseOrderId: po.id, poNumber: po.poNumber, unmatched },
    };
  }

  // --- Shopkeeper inbox: owner khata command, or customer balance ------------
  private async handleShopMessage(shop: BusinessUser, msg: InboundMessage): Promise<BotReply> {
    const senderIsOwner = digits10(msg.fromPhone) === shop.phone10;

    if (senderIsOwner) {
      const command = parseLedgerCommand(msg.text);
      const posted = await this.customers.postCommand(shop.id, command, 'WHATSAPP');
      if (!posted.posted || !posted.result) {
        return {
          action: 'HELP',
          reply: `${posted.reason ?? 'Sorry, I did not understand.'}\nTry: "Ramesh ko 500 udhaar" or "Suresh se 200 jama".`,
        };
      }
      const { customer, entry } = posted.result;
      const verb = entry.entryType === 'CREDIT' ? 'Udhaar' : 'Payment';
      return {
        action: 'LEDGER_POSTED',
        reply: `📒 ${verb} noted: ${customer.name} ${inr(entry.amount)}.\n${customer.name}'s balance is now ${inr(customer.balance)}.`,
        data: { customerId: customer.id, entryId: entry.id, balance: customer.balance },
      };
    }

    // Otherwise the sender is a customer checking their own balance.
    const balance = await this.customers.getBalanceByPhone(shop.id, digits10(msg.fromPhone));
    if (!balance) {
      return {
        action: 'UNKNOWN_SENDER',
        reply: `Namaste! This number isn't in ${shop.businessName}'s khata yet. Please ask the shop to add you.`,
      };
    }
    const owes = balance.balance;
    const line =
      owes > 0
        ? `Your outstanding balance is ${inr(owes)}.`
        : owes < 0
          ? `You have an advance of ${inr(-owes)} with the shop.`
          : `Your account is fully settled. Dhanyavaad!`;
    return {
      action: 'BALANCE',
      reply: `Namaste ${balance.name} 🙏\n${shop.businessName}\n${line}\nReply PAY to receive a UPI payment link.`,
      data: { customerId: balance.id, balance: owes },
    };
  }

  /** Best-effort catalog match: whole query first, then the most specific word. */
  private async matchProduct(
    dealerId: string,
    query: string,
  ): Promise<{ sku: string; productName: string; unit: string; moq: number } | null> {
    const words = query.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
    for (const term of [query, ...words]) {
      const { rows } = await this.db.query<{ sku: string; product_name: string; unit: string; moq: number }>(
        `
        SELECT sku, product_name, unit, moq
        FROM dealer_products
        WHERE dealer_id = $1 AND is_active AND available AND product_name ILIKE '%' || $2 || '%'
        ORDER BY length(product_name)
        LIMIT 1
        `,
        [dealerId, term],
      );
      if (rows.length) {
        return { sku: rows[0].sku, productName: rows[0].product_name, unit: rows[0].unit, moq: rows[0].moq };
      }
    }
    return null;
  }

  private async resolveUser(phone: string): Promise<BusinessUser | null> {
    const { rows } = await this.db.query<{ id: string; role: BusinessUser['role']; business_name: string; phone: string }>(
      `
      SELECT id, role, business_name, phone
      FROM users
      WHERE is_active AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
      LIMIT 1
      `,
      [digits10(phone)],
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      role: rows[0].role,
      businessName: rows[0].business_name,
      phone10: digits10(rows[0].phone),
    };
  }

  private async reply(toPhone: string, r: BotReply): Promise<BotReply> {
    await this.sender.send({ toPhone, body: r.reply });
    return r;
  }
}
