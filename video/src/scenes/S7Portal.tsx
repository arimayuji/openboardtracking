import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, prog, useSpring, Eyebrow} from '../theme';

const areas = [
  {a: 'RH', t: 'Portal de férias', d: 'Solicitação e saldo para toda a equipe'},
  {a: 'Finanças', t: 'Conciliação mensal', d: 'Extratos cruzados com os lançamentos'},
  {a: 'Saúde', t: 'Agenda de consultas', d: 'Pacientes escolhem horários sozinhos'},
  {a: 'Direito', t: 'Painel de prazos', d: 'Avisos antes de cada vencimento'},
  {a: 'Economia', t: 'Relatório de indicadores', d: 'Números atualizados toda manhã'},
];
const CYC = 50;

export const S7Portal: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const head = prog(frame, 0, 24);
  const card = useSpring(10);
  const idx = Math.min(areas.length - 1, Math.max(0, Math.floor((frame - 40) / CYC)));
  const local = frame - 40 - idx * CYC;
  const swap = prog(local, 0, 14);
  const press = local > 34 && local < 42 ? 0.96 : 1;
  const cur = areas[idx];
  return (
    <Scene dur={dur}>
      <div style={{position: 'absolute', left: 150, top: 330, width: 640, opacity: head, transform: `translateY(${(1 - head) * 16}px)`}}>
        <Eyebrow>Portal do cliente</Eyebrow>
        <div style={{fontFamily: F.display, fontSize: 92, color: C.text, marginTop: 18, lineHeight: 1.08}}>Português claro. <span style={{fontFamily: F.italic, color: C.accent}}>Sem jargão.</span></div>
        <div style={{fontFamily: F.ui, fontSize: 30, color: C.muted, marginTop: 28, lineHeight: 1.45}}>Quem pede acompanha e aprova a entrega, sem precisar falar a língua de tecnologia.</div>
      </div>
      <div style={{position: 'absolute', left: 930, top: 190, width: 840, opacity: card, transform: `translateY(${(1 - card) * 40}px) scale(${0.95 + 0.05 * card})`, background: C.panel, border: `1.5px solid ${C.line}`, borderRadius: 32, boxShadow: '0 40px 100px rgba(0,0,0,0.55)', overflow: 'hidden'}}>
        <div style={{display: 'flex', gap: 10, padding: '20px 28px', borderBottom: `1px solid ${C.line}`, alignItems: 'center'}}>
          {['#FF6B57', '#F3C969', '#6FD8C6'].map((c) => (<div key={c} style={{width: 14, height: 14, borderRadius: 14, background: c, opacity: 0.8}} />))}
        </div>
        <div style={{display: 'flex', gap: 12, padding: '26px 36px 0', flexWrap: 'wrap'}}>
          {areas.map((x, i) => (
            <div key={x.a} style={{fontFamily: F.ui, fontWeight: 600, fontSize: 22, padding: '8px 20px', borderRadius: 99, color: i === idx ? C.ink : C.muted, background: i === idx ? C.text : 'rgba(242,237,228,0.07)'}}>{x.a}</div>
          ))}
        </div>
        <div style={{padding: '34px 36px 40px', opacity: swap, transform: `translateY(${(1 - swap) * 16}px)`}}>
          <div style={{fontFamily: F.ui, fontWeight: 800, fontSize: 44, color: C.text}}>{cur.t}</div>
          <div style={{fontFamily: F.ui, fontSize: 26, color: C.muted, marginTop: 8}}>{cur.d}</div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 18, marginTop: 34}}>
            {[{l: 'Pedido entendido', s: 'ok'}, {l: 'Em produção', s: 'ok'}, {l: 'Aguardando sua aprovação', s: 'now'}].map((st) => (
              <div key={st.l} style={{display: 'flex', alignItems: 'center', gap: 18, fontFamily: F.ui, fontSize: 28, color: st.s === 'now' ? C.text : C.muted}}>
                <div style={{width: 30, height: 30, borderRadius: 30, background: st.s === 'ok' ? C.soft : 'transparent', border: `3px solid ${st.s === 'ok' ? C.soft : C.gold}`, boxShadow: st.s === 'now' ? `0 0 ${14 + 8 * Math.sin(frame / 5)}px ${C.gold}` : 'none'}} />
                {st.l}
              </div>
            ))}
          </div>
          <div style={{marginTop: 38, display: 'inline-block', transform: `scale(${press})`, fontFamily: F.ui, fontWeight: 800, fontSize: 28, color: C.ink, background: local > 36 ? C.soft : C.accent, padding: '18px 40px', borderRadius: 18}}>
            {local > 36 ? '✓ Entrega aprovada' : 'Aprovar entrega'}
          </div>
        </div>
      </div>
    </Scene>
  );
};
