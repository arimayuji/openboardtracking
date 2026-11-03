# Vídeo de lançamento do OpenBoardTracking

Vídeo de ~72 s (1920x1080, 30 fps, H.264) feito com [Remotion](https://www.remotion.dev). Todo em vetor/CSS, em português do Brasil, sem imagens externas.

## Pré-visualizar

```bash
cd video
npm install
npx remotion studio
```

## Renderizar

```bash
npx remotion render Launch out/openboardtracking-launch.mp4 --codec=h264
# se já houver um Chromium instalado e você não quiser baixar outro:
npx remotion render Launch out/openboardtracking-launch.mp4 --browser-executable=/caminho/do/chromium
# quadros avulsos
npx remotion still Launch out/frame.png --frame=530
```

## Alterar textos e tempos

- Textos: cada cena fica em `src/scenes/` (`S1Hook.tsx` ... `S8Closing.tsx`).
- Tempos das cenas (em segundos) e duração total: `TIMELINE` em `src/Root.tsx`.
- Cores e fontes: `src/theme.tsx` (tinta #0B0D12, off-white quente, coral como destaque, verde-água suave; Manrope e Instrument Serif via `@remotion/google-fonts`, que precisa de internet na renderização).

## Adicionar música

O vídeo é silencioso. Coloque um arquivo em `public/musica.mp3` e, em `src/Root.tsx`, dentro do componente `Launch`, adicione:

```tsx
import {Audio, staticFile, interpolate} from 'remotion';
<Audio src={staticFile('musica.mp3')} volume={(f) => interpolate(f, [0, 30, TOTAL - 60, TOTAL], [0, 0.6, 0.6, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} />
```

Use apenas música com licença que permita o uso.

## Identidade

O vídeo usa de propósito a identidade própria do OpenBoardTracking (logo de dois agentes entrelaçados, paleta e tipografia próprias). Não usa logotipos, fontes ou cores de terceiros; as integrações aparecem só como texto. A menção a "funciona com o seu Claude" é apenas a declaração factual de compatibilidade, e o projeto não é um produto da Anthropic nem tem endosso dela.
