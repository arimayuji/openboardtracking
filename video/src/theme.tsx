import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {loadFont as loadManrope} from '@remotion/google-fonts/Manrope';
import {loadFont as loadSerif} from '@remotion/google-fonts/InstrumentSerif';

const manrope = loadManrope('normal', {weights: ['400', '500', '600', '800'], subsets: ['latin', 'latin-ext']});
const serif = loadSerif('normal', {weights: ['400'], subsets: ['latin', 'latin-ext']});
const serifItalic = loadSerif('italic', {weights: ['400'], subsets: ['latin', 'latin-ext']});

export const C = {
  ink: '#0B0D12',
  panel: '#12151D',
  panel2: '#181C27',
  line: 'rgba(242,237,228,0.12)',
  text: '#F2EDE4',
  muted: 'rgba(242,237,228,0.58)',
  accent: '#FF6B57', // coral
  soft: '#6FD8C6', // soft teal
  gold: '#F3C969',
};
export const F = {
  ui: manrope.fontFamily,
  display: serif.fontFamily,
  italic: serifItalic.fontFamily,
};
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** Smooth spring 0..1 starting at `delay` frames (local to the enclosing Sequence). */
export const useSpring = (delay = 0, damping = 22, stiffness = 120) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return spring({frame: frame - delay, fps, config: {damping, stiffness, mass: 1}});
};

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const prog = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {...clamp, easing: ease});

/** Scene wrapper: fades in/out at the edges. */
export const Scene: React.FC<{dur: number; children: React.ReactNode; fadeIn?: number; fadeOut?: number}> = ({
  dur, children, fadeIn = 14, fadeOut = 14,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, Math.max(fadeIn, 0.01), dur - Math.max(fadeOut, 0.01), dur], [0, 1, 1, 0], clamp);
  return <div style={{position: 'absolute', inset: 0, opacity: o}}>{children}</div>;
};

/** Word that rises in with blur. */
export const Word: React.FC<{delay: number; children: React.ReactNode; style?: React.CSSProperties}> = ({delay, children, style}) => {
  const frame = useCurrentFrame();
  const p = prog(frame, delay, delay + 22);
  return (
    <span style={{display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 26}px)`, filter: `blur(${(1 - p) * 10}px)`, ...style}}>
      {children}
    </span>
  );
};

export const Logo: React.FC<{size: number; t?: number}> = ({size, t = 1}) => {
  // two interlocking rounded squares (two agents); t = draw/merge progress
  const s = size;
  const off = (1 - t) * s * 0.35;
  const dash = 4 * s * 0.62;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" style={{overflow: 'visible'}}>
      <defs>
        <clipPath id="clipA"><rect x="0" y="0" width="100" height="100" /></clipPath>
      </defs>
      <g transform={`translate(${-off / (s / 100)},0)`}>
        <rect x="8" y="22" width="52" height="52" rx="16" fill="none" stroke={C.accent} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={208} strokeDashoffset={208 * (1 - t)} />
      </g>
      <g transform={`translate(${off / (s / 100)},0)`}>
        <rect x="40" y="26" width="52" height="52" rx="16" fill="none" stroke={C.soft} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={208} strokeDashoffset={208 * (1 - t)} />
      </g>
      {/* weave: re-draw a slice of the coral shape over the teal one */}
      <g opacity={t > 0.9 ? 1 : 0}>
        <path d="M 26 74 H 44" fill="none" stroke={C.accent} strokeWidth="9" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const Grain: React.FC = () => (
  <svg style={{position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.07, mixBlendMode: 'overlay', pointerEvents: 'none'}}>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="3" /><feColorMatrix type="saturate" values="0" /></filter>
    <rect width="100%" height="100%" filter="url(#grain)" />
  </svg>
);

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const a = frame / 2160;
  const x1 = 25 + Math.sin(a * Math.PI * 2) * 12;
  const y1 = 20 + Math.cos(a * Math.PI * 2) * 8;
  const x2 = 78 + Math.cos(a * Math.PI * 2) * 10;
  const y2 = 85 + Math.sin(a * Math.PI * 2) * 8;
  return (
    <div style={{position: 'absolute', inset: 0, background: C.ink}}>
      <div style={{position: 'absolute', inset: 0, background: `radial-gradient(900px 700px at ${x1}% ${y1}%, rgba(255,107,87,0.10), transparent 70%), radial-gradient(1000px 800px at ${x2}% ${y2}%, rgba(111,216,198,0.09), transparent 70%)`}} />
      <Grain />
      <div style={{position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)'}} />
    </div>
  );
};

export const Center: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => (
  <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', ...style}}>{children}</div>
);

export const Eyebrow: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = C.soft}) => (
  <div style={{fontFamily: F.ui, fontWeight: 600, fontSize: 24, letterSpacing: 6, textTransform: 'uppercase', color}}>{children}</div>
);
