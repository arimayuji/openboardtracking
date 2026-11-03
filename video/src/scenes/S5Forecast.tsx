import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {C, F, Scene, prog, Eyebrow, clamp, ease} from '../theme';

const fmt = (n: number, d = 0) => n.toFixed(d).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const Counter: React.FC<{label: string; to: number; dec?: number; suffix?: string; prefix?: string; range: string; delay: number}> = ({label, to, dec = 0, suffix = '', prefix = '', range, delay}) => {
  const frame = useCurrentFrame();
  const p = prog(frame, delay, delay + 70);
  const o = prog(frame, delay - 10, delay + 10);
  return (
    <div style={{width: 470, padding: '30px 36px', borderRadius: 26, background: C.panel2, border: `1.5px solid ${C.line}`, opacity: o, transform: `translateY(${(1 - o) * 24}px)`}}>
      <div style={{fontFamily: F.ui, fontWeight: 600, fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: C.muted}}>{label}</div>
      <div style={{fontFamily: F.display, fontSize: 92, color: C.text, marginTop: 8, fontVariantNumeric: 'tabular-nums'}}>{prefix}{fmt(to * p, dec)}{suffix}</div>
      <div style={{fontFamily: F.ui, fontSize: 24, color: C.soft}}>{range}</div>
    </div>
  );
};

export const S5Forecast: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const head = prog(frame, 0, 24);
  const bar = prog(frame, 30, 90);
  const trackL = 160, trackW = 1600;
  const markers = [{k: 'P50', v: 0.32, c: C.soft}, {k: 'P85', v: 0.62, c: C.accent}, {k: 'P95', v: 0.82, c: C.gold}];
  const imp = prog(frame, 8, 120);
  const items = Math.round(1248 * imp);
  return (
    <Scene dur={dur}>
      <div style={{position: 'absolute', top: 96, left: trackL, opacity: head, transform: `translateY(${(1 - head) * 16}px)`}}>
        <Eyebrow>Estimativas em faixa, não no chute</Eyebrow>
        <div style={{fontFamily: F.display, fontSize: 112, color: C.text, marginTop: 14, lineHeight: 1.05}}>
          <span style={{color: C.accent, fontFamily: F.italic}}>85%</span> de chance até quinta
        </div>
      </div>
      {/* range bar */}
      <div style={{position: 'absolute', left: trackL, top: 470, width: trackW, height: 28, borderRadius: 14, background: 'rgba(242,237,228,0.07)'}}>
        <div style={{position: 'absolute', left: trackW * 0.10, width: trackW * (0.82 - 0.10) * bar, height: '100%', borderRadius: 14, background: `linear-gradient(90deg, ${C.soft}, ${C.accent} 70%, ${C.gold})`, opacity: 0.9}} />
        {markers.map((m, i) => {
          const mp = prog(frame, 70 + i * 16, 90 + i * 16);
          return (
            <div key={m.k} style={{position: 'absolute', left: trackW * m.v - 2, top: -34, opacity: mp, transform: `translateY(${(1 - mp) * -14}px)`}}>
              <div style={{width: 4, height: 96, background: m.c, borderRadius: 2, marginLeft: 0}} />
              <div style={{position: 'absolute', top: 100, left: -30, width: 64, textAlign: 'center', fontFamily: F.ui, fontWeight: 800, fontSize: 28, color: m.c}}>{m.k}</div>
              <div style={{position: 'absolute', top: 138, left: -60, width: 124, textAlign: 'center', fontFamily: F.ui, fontSize: 20, color: C.muted}}>{['terça', 'quinta', 'sexta'][i]}</div>
            </div>
          );
        })}
      </div>
      {/* history import */}
      <div style={{position: 'absolute', left: trackL, top: 700, display: 'flex', flexDirection: 'column', gap: 26}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 20, fontFamily: F.ui, fontSize: 26, color: C.muted, opacity: prog(frame, 100, 120)}}>
          <div style={{width: 360, height: 8, borderRadius: 4, background: 'rgba(242,237,228,0.08)'}}>
            <div style={{width: `${imp * 100}%`, height: '100%', borderRadius: 4, background: C.soft}} />
          </div>
          <span>Calibrando com {fmt(items)} itens do histórico</span>
        </div>
        <div style={{display: 'flex', gap: 34}}>
          <Counter label="Horas" to={24} suffix=" h" range="faixa P50–P95: 15–31 h" delay={110} />
          <Counter label="Tokens" to={4.2} dec={1} suffix=" M" range="faixa P50–P95: 2,8–6,1 M" delay={126} />
          <Counter label="Custo" to={312} prefix="R$ " range="faixa P50–P95: R$ 190–460" delay={142} />
        </div>
      </div>
    </Scene>
  );
};
