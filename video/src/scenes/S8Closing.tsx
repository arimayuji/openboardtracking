import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, Word, Logo, prog} from '../theme';

export const S8Closing: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const lines = [
    {t: 'Você descreve.', d: 6},
    {t: 'Agentes constroem.', d: 40},
    {t: 'Você decide o que importa.', d: 74, accent: true},
  ];
  const brand = prog(frame, 130, 165);
  const small = prog(frame, 165, 195);
  const lift = prog(frame, 120, 160);
  return (
    <Scene dur={dur} fadeOut={0}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 230 - lift * 70, textAlign: 'center', fontFamily: F.display, fontSize: 108, color: C.text, lineHeight: 1.12}}>
        {lines.map((l) => (
          <div key={l.t}><Word delay={l.d} style={l.accent ? {fontFamily: F.italic, color: C.accent} : {}}>{l.t}</Word></div>
        ))}
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 690, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: brand, transform: `translateY(${(1 - brand) * 24}px)`}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 28}}>
          <Logo size={90} />
          <div style={{fontFamily: F.ui, fontWeight: 800, fontSize: 68, color: C.text, letterSpacing: -2}}>Open<span style={{fontWeight: 400}}>Board</span><span style={{color: C.accent}}>Tracking</span></div>
        </div>
        <div style={{fontFamily: F.ui, fontWeight: 500, fontSize: 26, letterSpacing: 3, color: C.muted, marginTop: 34, opacity: small}}>Open source · funciona com o seu Claude</div>
      </div>
    </Scene>
  );
};
