// File persistence for the Node server (local use).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function fileStore(path) {
  return {
    state: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
    persist: (state) => writeFileSync(path, JSON.stringify(state, null, 2)),
  };
}
