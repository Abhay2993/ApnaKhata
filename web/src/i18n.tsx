/**
 * ApnaKhata web — vernacular UI (i18n)
 * ------------------------------------
 * A dependency-free translation layer. English holds every key; the seven
 * Indian languages carry the high-visibility chrome (tab bar, Khata screen) and
 * fall back to English for anything not yet localised — so the UI is always
 * complete, never blank. The selected language also drives the Web Speech
 * recognition locale on the Khata screen.
 */

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type Lang = 'en' | 'hi' | 'mr' | 'gu' | 'bn' | 'ta' | 'te' | 'kn';

export const LANGS: { code: Lang; label: string; speechLocale: string }[] = [
  { code: 'en', label: 'English', speechLocale: 'en-IN' },
  { code: 'hi', label: 'हिन्दी', speechLocale: 'hi-IN' },
  { code: 'mr', label: 'मराठी', speechLocale: 'mr-IN' },
  { code: 'gu', label: 'ગુજરાતી', speechLocale: 'gu-IN' },
  { code: 'bn', label: 'বাংলা', speechLocale: 'bn-IN' },
  { code: 'ta', label: 'தமிழ்', speechLocale: 'ta-IN' },
  { code: 'te', label: 'తెలుగు', speechLocale: 'te-IN' },
  { code: 'kn', label: 'ಕನ್ನಡ', speechLocale: 'kn-IN' },
];

// English is the source of truth — every key lives here.
const EN = {
  'app.preview': 'Mobile App Preview',
  'lang.label': 'Language',
  'tab.home': 'Home',
  'tab.credit': 'Credit',
  'tab.market': 'Market',
  'tab.gst': 'GST',
  'tab.more': 'More',
  'tab.khata': 'Khata',
  'khata.title': 'Customer Khata',
  'khata.subtitle': 'Speak or type to record udhaar & payments',
  'khata.speak': 'Speak',
  'khata.listening': 'Listening…',
  'khata.textPlaceholder': 'e.g. "Ramesh ko paanch sau udhaar"',
  'khata.record': 'Record',
  'khata.customers': 'Customers',
  'khata.owes': 'Owes',
  'khata.advance': 'Advance',
  'khata.settled': 'Settled',
  'khata.heard': 'Heard',
  'khata.posted': 'Recorded',
  'khata.notPosted': 'Not recorded',
  'khata.credit': 'Udhaar',
  'khata.payment': 'Payment',
  'khata.noCustomers': 'No customers yet — record your first entry.',
  'khata.voiceUnsupported': 'Voice input is not supported in this browser — type instead.',
  'khata.hint': 'Say a name, amount and udhaar/jama — in Hinglish. Numbers like "paanch sau", "do hazaar", "dhai sau" all work.',
  'khata.newBalance': 'New balance',
  'khata.offlineSaved': 'Saved offline — will sync when back online',
  'khata.pendingSync': 'pending sync',
  'khata.synced': 'Offline entries synced',
};

type Keys = keyof typeof EN;

// Localised overlays. Missing keys fall back to English.
const OVERLAY: Partial<Record<Lang, Partial<Record<Keys, string>>>> = {
  hi: {
    'app.preview': 'मोबाइल ऐप प्रीव्यू',
    'lang.label': 'भाषा',
    'tab.home': 'होम', 'tab.credit': 'क्रेडिट', 'tab.market': 'बाज़ार', 'tab.more': 'और', 'tab.khata': 'खाता',
    'khata.title': 'ग्राहक खाता',
    'khata.subtitle': 'उधार और भुगतान दर्ज करने के लिए बोलें या लिखें',
    'khata.speak': 'बोलें', 'khata.listening': 'सुन रहे हैं…',
    'khata.textPlaceholder': 'जैसे "Ramesh ko paanch sau udhaar"',
    'khata.record': 'दर्ज करें', 'khata.customers': 'ग्राहक',
    'khata.owes': 'बकाया', 'khata.advance': 'अग्रिम', 'khata.settled': 'चुकता',
    'khata.heard': 'सुना', 'khata.posted': 'दर्ज हो गया', 'khata.notPosted': 'दर्ज नहीं हुआ',
    'khata.credit': 'उधार', 'khata.payment': 'जमा',
    'khata.noCustomers': 'अभी कोई ग्राहक नहीं — अपनी पहली एंट्री दर्ज करें।',
    'khata.voiceUnsupported': 'इस ब्राउज़र में वॉइस समर्थित नहीं — कृपया टाइप करें।',
    'khata.hint': 'नाम, रकम और उधार/जमा बोलें — हिंग्लिश में। "paanch sau", "do hazaar", "dhai sau" जैसे नंबर भी चलते हैं।',
    'khata.newBalance': 'नया बकाया',
    'khata.offlineSaved': 'ऑफ़लाइन सहेजा गया — नेटवर्क आते ही सिंक होगा',
    'khata.pendingSync': 'सिंक बाकी',
    'khata.synced': 'ऑफ़लाइन एंट्रियाँ सिंक हो गईं',
  },
  mr: {
    'lang.label': 'भाषा',
    'tab.home': 'होम', 'tab.credit': 'क्रेडिट', 'tab.market': 'बाजार', 'tab.more': 'अधिक', 'tab.khata': 'खाते',
    'khata.title': 'ग्राहक खाते',
    'khata.subtitle': 'उधार व पेमेंट नोंदवण्यासाठी बोला किंवा टाइप करा',
    'khata.speak': 'बोला', 'khata.listening': 'ऐकत आहे…',
    'khata.record': 'नोंदवा', 'khata.customers': 'ग्राहक',
    'khata.owes': 'येणे', 'khata.advance': 'आगाऊ', 'khata.settled': 'चुकते',
    'khata.heard': 'ऐकले', 'khata.posted': 'नोंद झाली', 'khata.credit': 'उधार', 'khata.payment': 'जमा',
    'khata.newBalance': 'नवीन शिल्लक',
  },
  gu: {
    'lang.label': 'ભાષા',
    'tab.home': 'હોમ', 'tab.credit': 'ક્રેડિટ', 'tab.market': 'બજાર', 'tab.more': 'વધુ', 'tab.khata': 'ખાતું',
    'khata.title': 'ગ્રાહક ખાતું',
    'khata.subtitle': 'ઉધાર અને ચુકવણી નોંધવા બોલો અથવા ટાઈપ કરો',
    'khata.speak': 'બોલો', 'khata.listening': 'સાંભળી રહ્યું છે…',
    'khata.record': 'નોંધો', 'khata.customers': 'ગ્રાહકો',
    'khata.owes': 'બાકી', 'khata.advance': 'એડવાન્સ', 'khata.settled': 'ચૂકતે',
    'khata.heard': 'સાંભળ્યું', 'khata.posted': 'નોંધાયું', 'khata.credit': 'ઉધાર', 'khata.payment': 'જમા',
    'khata.newBalance': 'નવી બાકી',
  },
  bn: {
    'lang.label': 'ভাষা',
    'tab.home': 'হোম', 'tab.credit': 'ক্রেডিট', 'tab.market': 'বাজার', 'tab.more': 'আরও', 'tab.khata': 'খাতা',
    'khata.title': 'গ্রাহক খাতা',
    'khata.subtitle': 'বাকি ও পেমেন্ট রেকর্ড করতে বলুন বা টাইপ করুন',
    'khata.speak': 'বলুন', 'khata.listening': 'শুনছে…',
    'khata.record': 'রেকর্ড', 'khata.customers': 'গ্রাহক',
    'khata.owes': 'পাবেন', 'khata.advance': 'অগ্রিম', 'khata.settled': 'পরিশোধিত',
    'khata.heard': 'শুনেছি', 'khata.posted': 'রেকর্ড হয়েছে', 'khata.credit': 'ধার', 'khata.payment': 'জমা',
    'khata.newBalance': 'নতুন ব্যালেন্স',
  },
  ta: {
    'lang.label': 'மொழி',
    'tab.home': 'முகப்பு', 'tab.credit': 'கடன்', 'tab.market': 'சந்தை', 'tab.more': 'மேலும்', 'tab.khata': 'கணக்கு',
    'khata.title': 'வாடிக்கையாளர் கணக்கு',
    'khata.subtitle': 'கடன் & பணம் பதிவு செய்ய பேசவும் அல்லது தட்டச்சு செய்யவும்',
    'khata.speak': 'பேசு', 'khata.listening': 'கேட்கிறது…',
    'khata.record': 'பதிவு', 'khata.customers': 'வாடிக்கையாளர்கள்',
    'khata.owes': 'தர வேண்டும்', 'khata.advance': 'முன்பணம்', 'khata.settled': 'தீர்த்தது',
    'khata.heard': 'கேட்டது', 'khata.posted': 'பதிவானது', 'khata.credit': 'கடன்', 'khata.payment': 'செலுத்தியது',
    'khata.newBalance': 'புதிய இருப்பு',
  },
  te: {
    'lang.label': 'భాష',
    'tab.home': 'హోమ్', 'tab.credit': 'క్రెడిట్', 'tab.market': 'మార్కెట్', 'tab.more': 'మరిన్ని', 'tab.khata': 'ఖాతా',
    'khata.title': 'కస్టమర్ ఖాతా',
    'khata.subtitle': 'అప్పు & చెల్లింపులు నమోదు చేయడానికి మాట్లాడండి లేదా టైప్ చేయండి',
    'khata.speak': 'మాట్లాడు', 'khata.listening': 'వింటోంది…',
    'khata.record': 'నమోదు', 'khata.customers': 'కస్టమర్లు',
    'khata.owes': 'ఇవ్వాలి', 'khata.advance': 'అడ్వాన్స్', 'khata.settled': 'తీర్చారు',
    'khata.heard': 'విన్నది', 'khata.posted': 'నమోదైంది', 'khata.credit': 'అప్పు', 'khata.payment': 'జమ',
    'khata.newBalance': 'కొత్త బ్యాలెన్స్',
  },
  kn: {
    'lang.label': 'ಭಾಷೆ',
    'tab.home': 'ಮುಖಪುಟ', 'tab.credit': 'ಕ್ರೆಡಿಟ್', 'tab.market': 'ಮಾರುಕಟ್ಟೆ', 'tab.more': 'ಇನ್ನಷ್ಟು', 'tab.khata': 'ಖಾತೆ',
    'khata.title': 'ಗ್ರಾಹಕ ಖಾತೆ',
    'khata.subtitle': 'ಸಾಲ & ಪಾವತಿ ದಾಖಲಿಸಲು ಮಾತನಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ',
    'khata.speak': 'ಮಾತನಾಡಿ', 'khata.listening': 'ಆಲಿಸುತ್ತಿದೆ…',
    'khata.record': 'ದಾಖಲಿಸಿ', 'khata.customers': 'ಗ್ರಾಹಕರು',
    'khata.owes': 'ಬಾಕಿ', 'khata.advance': 'ಮುಂಗಡ', 'khata.settled': 'ಚುಕ್ತಾ',
    'khata.heard': 'ಕೇಳಿದೆ', 'khata.posted': 'ದಾಖಲಾಗಿದೆ', 'khata.credit': 'ಸಾಲ', 'khata.payment': 'ಜಮಾ',
    'khata.newBalance': 'ಹೊಸ ಬಾಕಿ',
  },
};

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Keys) => string;
  speechLocale: string;
}

const Ctx = createContext<I18nCtx | null>(null);
const STORAGE_KEY = 'apnakhata.lang';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = typeof localStorage !== 'undefined' ? (localStorage.getItem(STORAGE_KEY) as Lang | null) : null;
    return saved && LANGS.some((l) => l.code === saved) ? saved : 'en';
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  }, [lang]);

  const value = useMemo<I18nCtx>(() => {
    const overlay = OVERLAY[lang] ?? {};
    return {
      lang,
      setLang: setLangState,
      t: (key: Keys) => overlay[key] ?? EN[key] ?? key,
      speechLocale: LANGS.find((l) => l.code === lang)?.speechLocale ?? 'en-IN',
    };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
