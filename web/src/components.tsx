/**
 * ApnaKhata web — shared UI primitives used across feature screens.
 */

import { ReactNode, useMemo } from 'react';

export const inr = (n: number, max = 0): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: max }).format(n);

export function Header({ title, badge }: { title: string; badge?: 'LIVE' | 'DEMO' | null }) {
  return (
    <header className="header">
      <span className="wordmark">ApnaKhata</span>
      <span className="header-context">
        {title}
        {badge && <span className={`mode-badge ${badge.toLowerCase()}`}>{badge}</span>}
      </span>
    </header>
  );
}

export function SectionHead({ label, note }: { label: string; note?: string }) {
  return (
    <div className="section-head">
      <span className="card-label">{label}</span>
      {note && <span className="section-note">{note}</span>}
    </div>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section className="card">
      {label && <span className="card-label">{label}</span>}
      {children}
    </section>
  );
}

export function StatRow({ items }: { items: { label: string; value: string; gold?: boolean }[] }) {
  return (
    <div className="cash-grid">
      {items.map((it) => (
        <div key={it.label}>
          <span className="stat-label">{it.label}</span>
          <div className={`stat-value ${it.gold ? 'gold' : ''}`}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Tag({ children, tone = 'gold' }: { children: ReactNode; tone?: 'gold' | 'green' | 'red' | 'slate' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** 240° gold score gauge (300–900). */
export function ScoreArc({ score, size = 150 }: { score: number; size?: number }) {
  const strokeWidth = 7;
  const radius = (size - strokeWidth) / 2;
  const c = size / 2;
  const start = 150;
  const sweep = 240;
  const progress = Math.min(Math.max((score - 300) / 600, 0), 1);
  const polar = (deg: number) => ({ x: c + radius * Math.cos((Math.PI / 180) * deg), y: c + radius * Math.sin((Math.PI / 180) * deg) });
  const arc = (from: number, to: number) => {
    const a = polar(from), b = polar(to);
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
  };
  const dot = polar(start + sweep * progress);
  return (
    <svg width={size} height={size}>
      <path d={arc(start, start + sweep)} stroke="#2a3542" strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <path d={arc(start, start + Math.max(sweep * progress, 1))} stroke="var(--gold)" strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <circle cx={dot.x} cy={dot.y} r={strokeWidth} fill="var(--gold-bright)" />
    </svg>
  );
}

export function Sparkline({ data, width = 96, height = 30, color = 'var(--gold)' }: { data: number[]; width?: number; height?: number; color?: string }) {
  const points = useMemo(() => {
    if (data.length === 0) return '';
    const max = Math.max(...data), min = Math.min(...data);
    const span = max - min || 1;
    const step = width / (data.length - 1 || 1);
    return data.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  }, [data, width, height]);
  return (
    <svg width={width} height={height}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.75} strokeOpacity={0.85} />
    </svg>
  );
}

/** Horizontal proportion bar (0..1). */
export function Meter({ value, tone = 'gold' }: { value: number; tone?: 'gold' | 'green' | 'red' }) {
  const color = tone === 'green' ? '#6fcf97' : tone === 'red' ? 'var(--danger)' : 'var(--gold)';
  return (
    <div className="meter">
      <div className="meter-fill" style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%`, background: color }} />
    </div>
  );
}

export function Row({ left, right, sub }: { left: ReactNode; right: ReactNode; sub?: ReactNode }) {
  return (
    <div className="frow">
      <div style={{ minWidth: 0 }}>
        <div className="frow-left">{left}</div>
        {sub && <div className="frow-sub">{sub}</div>}
      </div>
      <div className="frow-right">{right}</div>
    </div>
  );
}
