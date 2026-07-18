/**
 * ApnaKhata web — client-side command parser (demo mode)
 * ------------------------------------------------------
 * A trimmed port of backend/src/nlp/CommandParser so the standalone Vercel
 * preview can interpret voice/typed entries with no backend. When VITE_API_URL
 * is set the real server parser is authoritative; this only powers demo mode.
 */

export type LedgerIntent = 'RECORD_CREDIT' | 'RECORD_PAYMENT' | 'UNKNOWN';

export interface LedgerCommand {
  intent: LedgerIntent;
  party: string | null;
  amount: number | null;
  confidence: 'high' | 'medium' | 'low';
  transcript: string;
}

const UNITS: Record<string, number> = {
  zero: 0, ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4,
  paanch: 5, panch: 5, five: 5, che: 6, chah: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8,
  nau: 9, nine: 9, das: 10, ten: 10, gyaarah: 11, baarah: 12,
  bees: 20, twenty: 20, tees: 30, thirty: 30, chalis: 40, forty: 40, pachas: 50, pachaas: 50, fifty: 50,
  saath: 60, sixty: 60, sattar: 70, seventy: 70, assi: 80, eighty: 80, nabbe: 90, ninety: 90,
};
const SCALES: Record<string, number> = { sau: 100, hundred: 100, hazaar: 1000, hajaar: 1000, thousand: 1000, lakh: 100000, lac: 100000 };
const FRACTIONS: Record<string, number> = { dhai: 2.5, adhai: 2.5, derh: 1.5, dedh: 1.5, sava: 1.25, paune: 0.75 };

const PAYMENT_WORDS = ['jama', 'jamaa', 'chukaya', 'chukaye', 'mile', 'mila', 'aaye', 'aaya', 'vapas', 'wapas', 'lauta', 'paid', 'payment', 'received', 'receive', 'deposit', 'settle', 'settled'];
const CREDIT_WORDS = ['udhaar', 'udhar', 'credit', 'likho', 'likha', 'likh', 'baaki', 'baki', 'khaata', 'khata', 'owe', 'due', 'lagao', 'chadha', 'chadhao'];
const PREP = new Set(['ko', 'se', 'ne', 'ka', 'ki', 'ke', 'to', 'from']);
const STOP = new Set([...PREP, 'rs', 'rupaye', 'rupees', 'rupee', 'the', 'a', 'and', 'aur', 'please', 'kar', 'karo', 'do', 'de', 'diya', 'diye', 'dena']);

const tokenize = (text: string): string[] =>
  text.toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

export function parseAmount(text: string): number | null {
  const tokens = tokenize(text);
  let total = 0, current = 0;
  let pendingFrac: number | null = null;
  let matched = false;
  for (const raw of tokens) {
    const k = raw.match(/^(\d+(?:\.\d+)?)k$/);
    if (k) { total += Number(k[1]) * 1000; matched = true; continue; }
    if (/^\d+(?:\.\d+)?$/.test(raw)) { current += Number(raw); matched = true; continue; }
    if (FRACTIONS[raw] !== undefined) { pendingFrac = FRACTIONS[raw]; matched = true; continue; }
    if (UNITS[raw] !== undefined) { current += UNITS[raw]; matched = true; continue; }
    if (SCALES[raw] !== undefined) {
      const scale = SCALES[raw];
      const base = pendingFrac ?? (current || 1);
      if (scale >= 1000) { total += base * scale; current = 0; } else { current = base * scale; }
      pendingFrac = null; matched = true; continue;
    }
  }
  const value = total + current;
  return matched && value > 0 ? Math.round(value * 100) / 100 : null;
}

const isNameToken = (t: string): boolean =>
  !!t && UNITS[t] === undefined && SCALES[t] === undefined && FRACTIONS[t] === undefined &&
  !/^\d/.test(t) && !STOP.has(t) && !CREDIT_WORDS.includes(t) && !PAYMENT_WORDS.includes(t);

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function extractParty(tokens: string[]): string | null {
  const nameOf = (run: string[]) => run.map(capitalize).join(' ');
  const prepIdx = tokens.findIndex((t) => PREP.has(t));
  if (prepIdx > 0) {
    const run: string[] = [];
    for (let j = prepIdx - 1; j >= 0 && isNameToken(tokens[j]); j--) run.unshift(tokens[j]);
    if (run.length) return nameOf(run);
  }
  const lead: string[] = [];
  for (const t of tokens) { if (isNameToken(t)) lead.push(t); else break; }
  if (lead.length) return nameOf(lead);
  for (const t of tokens) if (isNameToken(t)) return capitalize(t);
  return null;
}

export function parseLedgerCommand(transcript: string): LedgerCommand {
  const tokens = tokenize(transcript);
  const amount = parseAmount(transcript);
  let creditScore = 0, paymentScore = 0;
  for (const t of tokens) {
    if (CREDIT_WORDS.includes(t)) creditScore += 2;
    if (PAYMENT_WORDS.includes(t)) paymentScore += 2;
  }
  if (tokens.includes('se') || tokens.includes('ne') || tokens.includes('from')) paymentScore += 1;
  if (tokens.includes('ko') || tokens.includes('to')) creditScore += 1;

  let intent: LedgerIntent;
  let confidence: LedgerCommand['confidence'];
  if (creditScore === 0 && paymentScore === 0) {
    intent = amount ? 'RECORD_CREDIT' : 'UNKNOWN';
    confidence = 'low';
  } else if (creditScore >= paymentScore) {
    intent = 'RECORD_CREDIT';
    confidence = creditScore >= 3 || Math.abs(creditScore - paymentScore) >= 2 ? 'high' : 'medium';
  } else {
    intent = 'RECORD_PAYMENT';
    confidence = paymentScore >= 3 || Math.abs(paymentScore - creditScore) >= 2 ? 'high' : 'medium';
  }
  return { intent, party: extractParty(tokens), amount, confidence, transcript: transcript.trim() };
}
