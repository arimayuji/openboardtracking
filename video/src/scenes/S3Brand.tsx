import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, Center, Logo, prog, useSpring} from '../theme';

export const S3Brand: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const t = prog(frame, 6, 50);
  const pop = useSpring(10, 16, 90);
  const name = prog(frame, 40, 70);
  const tag = prog(frame, 76, 110);
  const glow = prog(frame, 20, 70);
  return (
    <Scene dur={dur}>
      <Center>
        <div style={{position: 'absolute', width: 700, height: 700, borderRadius: 700, background: `radial-gradient(circle, rgba(255,107,87,${0.16 * glow}), rgba(111,216,198,${0.08 * glow}) 45%, transparent 70%)`}} />
        <div style={{transform: `scale(${0.7 + 0.3 * pop})`, marginBottom: 36}}><Logo size={190} t={t} /></div>
        <div style={{fontFamily: F.ui, fontWeight: 800, fontSize: 108, color: C.text, letterSpacing: -3, opacity: name, transform: `translateY(${(1 - name) * 24}px)`, filter: `blur(${(1 - name) * 8}px)`}}>
          Open<span style={{fontWeight: 400}}>Board</span><span style={{color: C.accent}}>Tracking</span>
        </div>
        <div style={{fontFamily: F.display, fontSize: 52, color: C.muted, marginTop: 24, opacity: tag, transform: `translateY(${(1 - tag) * 16}px)`}}>
          Gestão de software para a era dos agentes.
        </div>
      </Center>
    </Scene>
  );
};
