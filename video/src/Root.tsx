import React from 'react';
import {Composition, Sequence, useCurrentFrame, interpolate} from 'remotion';
import {Background, clamp} from './theme';
import {S1Hook} from './scenes/S1Hook';
import {S2OldWorld} from './scenes/S2OldWorld';
import {S3Brand} from './scenes/S3Brand';
import {S4Negotiation} from './scenes/S4Negotiation';
import {S5Forecast} from './scenes/S5Forecast';
import {S6Integrations} from './scenes/S6Integrations';
import {S7Portal} from './scenes/S7Portal';
import {S8Closing} from './scenes/S8Closing';

const FPS = 30;
const sec = (s: number) => Math.round(s * FPS);
// [start, end] in seconds
export const TIMELINE = [
  [0, 6], [6, 14], [14, 20], [20, 32], [32, 44], [44, 54], [54, 64], [64, 72],
] as const;
export const TOTAL = sec(72);

const Launch: React.FC = () => {
  const frame = useCurrentFrame();
  const end = interpolate(frame, [TOTAL - 20, TOTAL], [0, 1], clamp);
  const scenes = [S1Hook, S2OldWorld, S3Brand, S4Negotiation, S5Forecast, S6Integrations, S7Portal, S8Closing];
  return (
    <div style={{position: 'absolute', inset: 0, background: '#0B0D12'}}>
      <Background />
      {scenes.map((Sc, i) => {
        const [a, b] = TIMELINE[i];
        const dur = sec(b) - sec(a);
        return (
          <Sequence key={i} from={sec(a)} durationInFrames={dur}>
            <Sc dur={dur} />
          </Sequence>
        );
      })}
      <div style={{position: 'absolute', inset: 0, background: '#0B0D12', opacity: end}} />
    </div>
  );
};

export const Root: React.FC = () => (
  <Composition id="Launch" component={Launch} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
);
