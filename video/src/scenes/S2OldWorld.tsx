import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, Center, prog, Eyebrow} from '../theme';

const items = ['Daily.', 'Planning.', 'Story points.', 'Repasse de PO para PM para dev.'];

export const S2OldWorld: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const end = prog(frame, 196, 232);
  return (
    <Scene dur={dur}>
      <Center>
        <div style={{display: 'flex', flexDirection: 'column', gap: 34, alignItems: 'flex-start'}}>
          <div style={{opacity: prog(frame, 0, 20)}}><Eyebrow color={C.muted}>O mundo de ontem</Eyebrow></div>
          {items.map((t, i) => {
            const inP = prog(frame, 14 + i * 22, 14 + i * 22 + 22);
            const strike = prog(frame, 100 + i * 20, 100 + i * 20 + 16);
            const dim = prog(frame, 100 + i * 20 + 10, 100 + i * 20 + 34);
            const o = inP * (1 - 0.62 * dim) * (1 - end);
            return (
              <div key={i} style={{position: 'relative', fontFamily: F.display, fontSize: 104, color: C.text, opacity: o, transform: `translateX(${(1 - inP) * 50}px) translateY(${dim * 6}px)`, lineHeight: 1.05}}>
                {t}
                <div style={{position: 'absolute', left: -8, top: '56%', height: 7, width: `calc(${strike * 100}% + 16px)`, background: C.accent, borderRadius: 4}} />
              </div>
            );
          })}
        </div>
      </Center>
    </Scene>
  );
};
