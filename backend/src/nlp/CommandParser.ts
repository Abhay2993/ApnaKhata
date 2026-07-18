/**
 * ApnaKhata — NLP command parser
 * ------------------------------
 * Turns a transcribed utterance (Hinglish / English) into a structured ledger
 * command or an order. Speech-to-text (on-device or Bhashini/Google STT) is a
 * transport concern that hands us the transcript; this is the intent engine.
 *
 *   "Ramesh ko paanch sau udhaar"   → RECORD_CREDIT  Ramesh 500
 *   "Suresh se do hazaar mile"      → RECORD_PAYMENT Suresh 2000
 *   "10 salt aur 5 oil bhejo"       → order: salt×10, oil×5
 *
 * Number words support romanised Hindi (paanch sau, do hazaar, dhai sau, sava
 * lakh) plus digits and the "2k" shorthand. Devanagari transcripts can be
 * transliterated upstream; the maps here are easily extended.
 */

export type LedgerIntent = 'RECORD_CREDIT' | 'RECORD_PAYMENT' | 'UNKNOWN';

export interface LedgerCommand {
  intent: LedgerIntent;
  party: string | null;
  amount: number | null;
  confidence: 'high' | 'medium' | 'low';
  transcript: string;
}

export interface OrderCommand {
  items: { query: string; quantity: number }[];
  transcript: string;
}

const UNITS: Record<string, number> = {
  zero: 0, ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4,
  paanch: 5, panch: 5, five: 5, che: 6, chah: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8,
  nau: 9, nine: 9, das: 10, ten: 10, gyaarah: 11, eleven: 11, baarah: 12, twelve: 12,
  bees: 20, twenty: 20, tees: 30, thirty: 30, chalis: 40, forty: 40, pachas: 50, pachaas: 50, fifty: 50,
  saath: 60, sixty: 60, sattar: 70, seventy: 70, assi: 80, eighty: 80, nabbe: 90, ninety: 90,
};

const SCALES: Record<string, number> = {
  sau: 100, hundred: 100, hazaar: 1000, hajaar: 1000, thousand: 1000, lakh: 100000, lac: 100000,
};

// Fractional prefixes that multiply the following scale (dhai sau = 250).
const FRACTIONS: Record<string, number> = { dhai: 2.5, adhai: 2.5, derh: 1.5, dedh: 1.5, sava: 1.25, paune: 0.75 };

const PAYMENT_WORDS = ['jama', 'jamaa', 'chukaya', 'chukaye', 'chukaayi', 'mile', 'mila', 'milgaye', 'aaye', 'aaya', 'vapas', 'wapas', 'lauta', 'paid', 'payment', 'received', 'receive', 'deposit', 'settle', 'settled'];
const CREDIT_WORDS = ['udhaar', 'udhar', 'credit', 'likho', 'likha', 'likh', 'baaki', 'baki', 'khaata', 'khata', 'took', 'owe', 'owes', 'due', 'lagao', 'chadha', 'chadhao'];
const PREP = new Set(['ko', 'se', 'ne', 'ka', 'ki', 'ke', 'to', 'from']);
const STOP = new Set([...PREP, 'rs', 'rupaye', 'rupees', 'rupee', 'rupya', 'ka', 'the', 'a', 'and', 'aur', 'please', 'kar', 'karo', 'do', 'de', 'diya', 'diye', 'dena']);

const tokenize = (text: string): string[] =>
  text.toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** Parse a run of tokens into a number, or null if none is present. */
export function parseAmount(text: string): number | null {
  const tokens = tokenize(text);
  let total = 0;
  let current = 0;
  let pendingFrac: number | null = null;
  let matched = false;

  for (const raw of tokens) {
    const kSuffix = raw.match(/^(\d+(?:\.\d+)?)k$/); // 2k → 2000
    if (kSuffix) { total += Number(kSuffix[1]) * 1000; matched = true; continue; }
    if (/^\d+(?:\.\d+)?$/.test(raw)) { current += Number(raw); matched = true; continue; }
    if (FRACTIONS[raw] !== undefined) { pendingFrac = FRACTIONS[raw]; matched = true; continue; }
    if (UNITS[raw] !== undefined) { current += UNITS[raw]; matched = true; continue; }
    if (SCALES[raw] !== undefined) {
      const scale = SCALES[raw];
      const base = pendingFrac ?? (current || 1);
      if (scale >= 1000) { total += base * scale; current = 0; } else { current = base * scale; }
      pendingFrac = null;
      matched = true;
      continue;
    }
  }
  if (pendingFrac !== null) current = current || pendingFrac * 100; // "dhai" alone ~ vague; ignore edge
  const value = total + current;
  return matched && value > 0 ? Math.round(value * 100) / 100 : null;
}

/** Parse a ledger utterance into { intent, party, amount, confidence }. */
export function parseLedgerCommand(transcript: string): LedgerCommand {
  const tokens = tokenize(transcript);
  const amount = parseAmount(transcript);

  let creditScore = 0;
  let paymentScore = 0;
  for (const t of tokens) {
    if (CREDIT_WORDS.includes(t)) creditScore += 2;
    if (PAYMENT_WORDS.includes(t)) paymentScore += 2;
  }
  // Prepositions disambiguate the ambiguous "diya/diye": "se/ne" → payment, "ko" → credit.
  if (tokens.includes('se') || tokens.includes('ne') || tokens.includes('from')) paymentScore += 1;
  if (tokens.includes('ko') || tokens.includes('to')) creditScore += 1;

  let intent: LedgerIntent;
  let confidence: LedgerCommand['confidence'];
  if (creditScore === 0 && paymentScore === 0) {
    intent = amount ? 'RECORD_CREDIT' : 'UNKNOWN'; // udhaar is the default kirana entry
    confidence = 'low';
  } else if (creditScore >= paymentScore) {
    intent = 'RECORD_CREDIT';
    confidence = creditScore >= 3 ? 'high' : Math.abs(creditScore - paymentScore) >= 2 ? 'high' : 'medium';
  } else {
    intent = 'RECORD_PAYMENT';
    confidence = paymentScore >= 3 ? 'high' : Math.abs(paymentScore - creditScore) >= 2 ? 'high' : 'medium';
  }

  return { intent, party: extractParty(tokens), amount, confidence, transcript: transcript.trim() };
}

/** Parse an order utterance into { query, quantity } line items. */
export function parseOrder(transcript: string): OrderCommand {
  const segments = transcript
    .toLowerCase()
    .replace(/\band\b|\baur\b|\+/g, ',')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const items: { query: string; quantity: number }[] = [];
  for (const seg of segments) {
    const qty = parseAmount(seg);
    if (qty === null) continue;
    // The product query is the segment minus number-ish and command words.
    const words = tokenize(seg).filter(
      (w) =>
        !/^\d/.test(w) &&
        UNITS[w] === undefined &&
        SCALES[w] === undefined &&
        FRACTIONS[w] === undefined &&
        !STOP.has(w) &&
        !['bhejo', 'bhej', 'order', 'chahiye', 'chaahiye', 'send', 'want', 'packet', 'packets', 'piece', 'pieces', 'pcs', 'box', 'boxes'].includes(w),
    );
    if (words.length) items.push({ query: words.join(' '), quantity: qty });
  }
  return { items, transcript: transcript.trim() };
}

const isNameToken = (t: string): boolean =>
  !!t &&
  UNITS[t] === undefined &&
  SCALES[t] === undefined &&
  FRACTIONS[t] === undefined &&
  !/^\d/.test(t) &&
  !STOP.has(t) &&
  !CREDIT_WORDS.includes(t) &&
  !PAYMENT_WORDS.includes(t);

function extractParty(tokens: string[]): string | null {
  const nameOf = (run: string[]): string => run.map(capitalize).join(' ');

  // Prefer the contiguous name run immediately before a preposition
  // ("Naya Grahak *ko*", "Ramesh *ko*", "Suresh *se*").
  const prepIdx = tokens.findIndex((t) => PREP.has(t));
  if (prepIdx > 0) {
    const run: string[] = [];
    for (let j = prepIdx - 1; j >= 0 && isNameToken(tokens[j]); j--) run.unshift(tokens[j]);
    if (run.length) return nameOf(run);
  }

  // Fallback: the leading run of name-like tokens ("Ramesh 500 udhaar").
  const lead: string[] = [];
  for (const t of tokens) {
    if (isNameToken(t)) lead.push(t);
    else break;
  }
  if (lead.length) return nameOf(lead);

  // Last resort: any single name-like token anywhere.
  for (const t of tokens) if (isNameToken(t)) return capitalize(t);
  return null;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
