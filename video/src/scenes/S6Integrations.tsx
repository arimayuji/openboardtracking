import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, prog, useSpring, Eyebrow} from '../theme';

const items = [
  {n: 'GitHub', c: 'CI verifica a entrega', col: C.text},
  {n: 'Slack', c: 'Decisões em um clique', col: C.soft},
  {n: 'Sentry', c: 'Bugs viram trabalho', col: C.accent},
  {n: 'Datadog', c: 'Alertas viram tarefas', col: C.gold},
  {n: 'Jira', c: 'Histórico importado', col: C.soft},
  {n: 'Linear', c: 'Previsão já calibrada', col: C.accent},
];

const Pill: React.FC<{n: string; c: string; col: string; i: number}> = ({n, c, col, i}) => {
  const frame = useCurrentFrame();
  const p = useSpring(24 + i * 14, 18, 90);
  const float = Math.sin((frame + i * 20) / 22) * 5;
  return (
    <div style={{width: 500, opacity: Math.min(1, p * 1.4), transform: `translateX(${(1 - p) * (i % 2 ? 160 : -160)}px) translateY(${float}px)`, textAlign: 'center'}}>
      <div style={{display: 'inline-flex', alignItems: 'center', gap: 16, padding: '22px 46px', borderRadius: 99, border: `2px solid ${col}`, background: C.panel2, fontFamily: F.ui, fontWeight: 800, fontSize: 48, color: C.text, boxShadow: `0 0 50px ${col}22`}}>
        <span style={{width: 14, height: 14, borderRadius: 14, background: col}} />{n}
      </div>
      <div style={{fontFamily: F.ui, fontSize: 28, color: C.muted, marginTop: 20}}>{c}</div>
    </div>
  );
};

export const S6Integrations: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const head = prog(frame, 0, 24);
  return (
    <Scene dur={dur}>
      <div style={{position: 'absolute', top: 120, left: 0, right: 0, textAlign: 'center', opacity: head, transform: `translateY(${(1 - head) * 16}px)`}}>
        <Eyebrow>Integrações</Eyebrow>
        <div style={{fontFamily: F.display, fontSize: 88, color: C.text, marginTop: 18}}>Conecta com o que você <span style={{fontFamily: F.italic, color: C.accent}}>já usa.</span></div>
      </div>
      <div style={{position: 'absolute', top: 440, left: 160, right: 160, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', rowGap: 90, justifyItems: 'center'}}>
        {items.map((it, i) => (<Pill key={it.n} {...it} i={i} />))}
      </div>
    </Scene>
  );
};
