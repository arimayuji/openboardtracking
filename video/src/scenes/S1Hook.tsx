import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, F, Scene, Word, Center, prog} from '../theme';

export const S1Hook: React.FC<{dur: number}> = ({dur}) => {
  const frame = useCurrentFrame();
  const words = ['O', 'código', 'deixou', 'de', 'ser', 'o'];
  const line = prog(frame, 100, 140);
  return (
    <Scene dur={dur} fadeIn={1}>
      <Center>
        <div style={{fontFamily: F.display, fontSize: 124, color: C.text, display: 'flex', gap: 30, letterSpacing: -2}}>
          {words.map((w, i) => (<Word key={i} delay={14 + i * 12}>{w}</Word>))}
          <Word delay={14 + words.length * 12 + 6} style={{fontFamily: F.italic, color: C.accent}}>gargalo.</Word>
        </div>
        <div style={{marginTop: 56, height: 2, width: 420 * line, background: C.line}} />
      </Center>
    </Scene>
  );
};
