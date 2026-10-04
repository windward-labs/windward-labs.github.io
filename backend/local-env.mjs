import { readFileSync } from 'node:fs';
export const localEnvPath = new URL('./.dev.vars',import.meta.url);
export function readLocalEnv(path = localEnvPath) {
  return Object.fromEntries(readFileSync(path,'utf8').split('\n')
    .map(line=>line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map(match=>[match[1],match[2].replace(/^(["'])(.*)\1$/,'$2').trim()]));
}
