/**
 * Khata — customer udhaar ledger with voice + vernacular entry.
 * Speak or type "Ramesh ko paanch sau udhaar" and the entry is parsed and
 * posted. Runs live against the API (GET /v1/customers, POST /v1/voice/ledger)
 * when configured; otherwise an in-browser parser drives a demo ledger so the
 * standalone Vercel preview is fully interactive.
 */

import { useEffect, useRef, useState } from 'react';

import {
  CustomerBalance,
  isLiveConfigured,
  listCustomers,
  recordVoiceLedger,
  VoiceResult,
} from '../api';
import { Header, inr } from '../components';
import { useI18n } from '../i18n';
import { parseLedgerCommand } from '../voiceParser';

const DEMO_CUSTOMERS: CustomerBalance[] = [
  { id: 'd1', name: 'Ramesh Kumar', phone: '+919812345678', balance: 450, lastActivity: new Date().toISOString() },
  { id: 'd3', name: 'Anita Sharma', phone: null, balance: 780, lastActivity: new Date(Date.now() - 86400000).toISOString() },
  { id: 'd2', name: 'Suresh Yadav', phone: '+919812345679', balance: 0, lastActivity: new Date(Date.now() - 172800000).toISOString() },
];

interface Feedback {
  ok: boolean;
  text: string;
}

// Minimal Web Speech typings (webkit-prefixed in most mobile browsers).
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onerror: () => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
};

function getRecognition(locale: string): SpeechRec | null {
  const Ctor =
    (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = locale;
  rec.continuous = false;
  rec.interimResults = false;
  return rec;
}

/** Fuzzy first-name match so "Ramesh" hits "Ramesh Kumar" in demo mode. */
function findDemo(list: CustomerBalance[], name: string): CustomerBalance | undefined {
  const n = name.toLowerCase();
  return (
    list.find((c) => c.name.toLowerCase() === n) ??
    list.find((c) => c.name.toLowerCase().startsWith(n + ' ') || c.name.toLowerCase().split(' ')[0] === n)
  );
}

export default function Khata() {
  const { t, speechLocale } = useI18n();
  const [mode, setMode] = useState<'demo' | 'live'>(isLiveConfigured() ? 'live' : 'demo');
  const [customers, setCustomers] = useState<CustomerBalance[]>(DEMO_CUSTOMERS);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const recRef = useRef<SpeechRec | null>(null);

  const voiceSupported = typeof window !== 'undefined' && getRecognition('en-IN') !== null;

  const refresh = () => {
    if (!isLiveConfigured()) return;
    listCustomers().then((c) => {
      if (c) {
        setCustomers(c);
        setMode('live');
      }
    });
  };
  useEffect(refresh, []);

  const applyDemo = (transcript: string) => {
    const cmd = parseLedgerCommand(transcript);
    if (cmd.intent === 'UNKNOWN' || !cmd.party || !cmd.amount) {
      setFeedback({ ok: false, text: `${t('khata.notPosted')} · “${transcript}”` });
      return;
    }
    const delta = cmd.intent === 'RECORD_PAYMENT' ? -cmd.amount : cmd.amount;
    setCustomers((prev) => {
      const existing = findDemo(prev, cmd.party as string);
      let next: CustomerBalance[];
      let newBal: number;
      if (existing) {
        newBal = existing.balance + delta;
        next = prev.map((c) => (c.id === existing.id ? { ...c, balance: newBal, lastActivity: new Date().toISOString() } : c));
      } else {
        newBal = delta;
        next = [{ id: `d${Date.now()}`, name: cmd.party as string, phone: null, balance: newBal, lastActivity: new Date().toISOString() }, ...prev];
      }
      const label = cmd.intent === 'RECORD_PAYMENT' ? t('khata.payment') : t('khata.credit');
      const who = existing ? existing.name : (cmd.party as string);
      setFeedback({ ok: true, text: `${t('khata.posted')} ✓ ${who} · ${label} ${inr(cmd.amount as number)} · ${t('khata.newBalance')} ${inr(newBal)}` });
      return next.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    });
  };

  const record = async (transcript: string) => {
    const clean = transcript.trim();
    if (!clean) return;
    setText('');
    if (mode === 'live') {
      const res: VoiceResult | null = await recordVoiceLedger(clean);
      if (!res) {
        setFeedback({ ok: false, text: 'Could not reach the server — try again.' });
        return;
      }
      if (res.posted && res.result) {
        const label = res.result.entry.entryType === 'PAYMENT' ? t('khata.payment') : t('khata.credit');
        setFeedback({
          ok: true,
          text: `${t('khata.posted')} ✓ ${res.result.customer.name} · ${label} ${inr(res.result.entry.amount)} · ${t('khata.newBalance')} ${inr(res.result.customer.balance)}`,
        });
        refresh();
      } else {
        setFeedback({ ok: false, text: `${t('khata.notPosted')} · ${res.reason ?? ''}` });
      }
    } else {
      applyDemo(clean);
    }
  };

  const toggleListen = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = getRecognition(speechLocale);
    if (!rec) {
      setFeedback({ ok: false, text: t('khata.voiceUnsupported') });
      return;
    }
    recRef.current = rec;
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setText(transcript);
      record(transcript);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setFeedback(null);
    setListening(true);
    rec.start();
  };

  const balanceLabel = (b: number): { text: string; cls: string } =>
    b > 0
      ? { text: `${t('khata.owes')} ${inr(b)}`, cls: 'gold' }
      : b < 0
        ? { text: `${t('khata.advance')} ${inr(-b)}`, cls: '' }
        : { text: t('khata.settled'), cls: 'muted' };

  const totalOutstanding = customers.reduce((s, c) => s + Math.max(c.balance, 0), 0);

  return (
    <>
      <Header title={t('khata.title')} badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      <section className="card voice-card">
        <span className="card-label">{t('khata.title')}</span>
        <p className="voice-subtitle">{t('khata.subtitle')}</p>

        <button type="button" className={`voice-btn ${listening ? 'listening' : ''}`} onClick={toggleListen}>
          <span className="voice-mic">{listening ? '●' : '🎤'}</span>
          {listening ? t('khata.listening') : t('khata.speak')}
        </button>

        <div className="voice-text-row">
          <input
            className="voice-input"
            value={text}
            placeholder={t('khata.textPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') record(text); }}
          />
          <button type="button" className="voice-record" onClick={() => record(text)}>{t('khata.record')}</button>
        </div>

        {feedback && <div className={`voice-feedback ${feedback.ok ? 'ok' : 'err'}`}>{feedback.text}</div>}
        <p className="voice-hint">{t('khata.hint')}</p>
      </section>

      <div className="section-head">
        <span className="card-label">{t('khata.customers')}</span>
        <span className="section-note">{t('khata.owes')} · {inr(totalOutstanding)}</span>
      </div>

      {customers.length === 0 && <div className="cart-empty">{t('khata.noCustomers')}</div>}

      {customers.map((c) => {
        const bl = balanceLabel(c.balance);
        return (
          <article key={c.id} className="alert-card khata-row">
            <div style={{ minWidth: 0 }}>
              <div className="alert-name">{c.name}</div>
              <div className="alert-meta">{c.phone ?? '—'}</div>
            </div>
            <div className={`khata-balance ${bl.cls}`}>{bl.text}</div>
          </article>
        );
      })}
    </>
  );
}
