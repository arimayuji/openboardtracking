import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, prog, useSpring, Eyebrow} from '../theme';

const criteria = ['Exporta o relatório em PDF', 'Resposta em menos de 2 s', 'Testes de CI passando', 'Custo máximo de R$ 180'];

const Agent: React.FC<{x: number; label: string; color: string; sub: string; delay: number}> = ({x, label, color, sub, delay}) => {
  const p = useSpring(delay);
  return (
    <div style={{position: 'absolute', left: x - 170, top: 430, width: 340, opacity: p, transform: `translateY(${(1 - p) * 30}px)`, textAlign: 'center'}}>
      <div style={{margin: '0 auto', width: 150, height: 150, borderRadius: 44, border: `4px solid ${color}`, background: C.panel, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 60px ${color}33`}}>
        <svg width="70" height="70" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="7" width="16" height="12" rx="4" /><path d="M12 7V4" /><circle cx="12" cy="3.5" r="1" /><circle cx="9" cy="13" r="1.1" fill={color} /><circle cx="15" cy="13" r="1.1" fill={color} />
        </svg>
      </div>
      <div style={{fontFamily: F.ui, fontWeight: 600, fontSize: 34, color: C.text, marginTop: 24}}>{label}</div>
      <div style={{fontFamily: F.ui, fontSize: 24, color: C.muted, marginTop: 6}}>{sub}</div>
    </div>
  );
};

export const S4Negotiation: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const card = useSpring(30);
  const head = prog(frame, 0, 24);
  const accepted = frame > 238;
  const esc = useSpring(150, 12, 150);
  const escOut = frame > 150;
  const human = useSpring(172);
  const resolved = prog(frame, 220, 236);
  // packets travelling between agents and card
  const packets = [0, 1, 2, 3, 4, 5].map((i) => {
    const start = 56 + i * 24;
    const q = prog(frame, start, start + 26);
    const fromLeft = i % 2 === 0;
    const x = fromLeft ? 370 + q * 400 : 1550 - q * 400;
    const visible = q > 0 && q < 1 && frame < 150;
    return visible ? <div key={i} style={{position: 'absolute', left: x, top: 500, width: 16, height: 16, borderRadius: 16, background: fromLeft ? C.accent : C.soft, boxShadow: `0 0 20px ${fromLeft ? C.accent : C.soft}`, opacity: Math.sin(q * Math.PI)}} /> : null;
  });
  return (
    <Scene dur={dur}>
      <div style={{position: 'absolute', top: 100, left: 0, right: 0, textAlign: 'center', opacity: head, transform: `translateY(${(1 - head) * 16}px)`}}>
        <Eyebrow>Contrato direto</Eyebrow>
        <div style={{fontFamily: F.display, fontSize: 76, color: C.text, marginTop: 18}}>Os agentes negociam. <span style={{fontFamily: F.italic, color: C.accent}}>Você decide as exceções.</span></div>
      </div>
      <div style={{position: 'absolute', left: 370, top: 506, width: 1180, height: 2, background: C.line}} />
      {packets}
      <Agent x={250} label="Agente do cliente" sub="escreve critérios" color={C.accent} delay={8} />
      <Agent x={1670} label="Agente do dev" sub="estima e entrega" color={C.soft} delay={16} />
      {/* contract card */}
      <div style={{position: 'absolute', left: 640, top: 370, width: 640, opacity: card, transform: `scale(${0.92 + 0.08 * card}) translateY(${(1 - card) * 30}px)`, background: C.panel2, border: `1.5px solid ${accepted ? C.soft : C.line}`, borderRadius: 28, padding: '34px 40px', boxShadow: '0 30px 80px rgba(0,0,0,0.5)'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22}}>
          <div style={{fontFamily: F.ui, fontWeight: 800, fontSize: 28, color: C.text}}>Contrato #142</div>
          <div style={{fontFamily: F.ui, fontWeight: 600, fontSize: 20, padding: '6px 16px', borderRadius: 99, color: accepted ? C.ink : C.gold, background: accepted ? C.soft : 'rgba(243,201,105,0.14)'}}>{accepted ? 'Acordado' : 'Negociando…'}</div>
        </div>
        {criteria.map((c, i) => {
          const tick = prog(frame, 80 + i * 26, 80 + i * 26 + 12);
          const rowIn = prog(frame, 40 + i * 6, 58 + i * 6);
          return (
            <div key={i} style={{display: 'flex', alignItems: 'center', gap: 18, padding: '13px 0', borderTop: i ? `1px solid ${C.line}` : 'none', opacity: rowIn}}>
              <div style={{width: 34, height: 34, borderRadius: 10, border: `2px solid ${tick > 0.5 ? C.soft : C.muted}`, background: tick > 0.5 ? C.soft : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 + 0.15 * Math.sin(tick * Math.PI)})`}}>
                <svg width="20" height="20" viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9" fill="none" stroke={C.ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="22" strokeDashoffset={22 * (1 - tick)} /></svg>
              </div>
              <div style={{fontFamily: F.ui, fontSize: 28, color: C.text}}>{c}</div>
            </div>
          );
        })}
      </div>
      {/* escalation + human */}
      {escOut && (
        <div style={{position: 'absolute', left: 0, right: 0, top: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 36}}>
          <div style={{transform: `scale(${esc})`, opacity: Math.min(1, esc), fontFamily: F.ui, fontWeight: 600, fontSize: 28, color: C.gold, background: 'rgba(243,201,105,0.12)', border: `1.5px solid ${C.gold}`, padding: '14px 28px', borderRadius: 99}}>
            ⚠ Escalonamento · orçamento excedido
          </div>
          <div style={{opacity: human, transform: `translateX(${(1 - human) * -20}px)`, display: 'flex', alignItems: 'center', gap: 16}}>
            <div style={{width: 64, height: 64, borderRadius: 64, background: C.text, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={C.ink} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></svg>
            </div>
            <div style={{fontFamily: F.ui, fontSize: 28, color: resolved > 0.5 ? C.soft : C.muted}}>{resolved > 0.5 ? 'Decisão humana: aprovado' : 'Aguardando você'}</div>
          </div>
        </div>
      )}
    </Scene>
  );
};
