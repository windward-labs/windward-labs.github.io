import { readFileSync } from 'node:fs';
export const localEnvPath = new URL('./.dev.vars',import.meta.url);
export function readLocalEnv(path = localEnvPath) {
  return Object.fromEntries(readFileSync(path,'utf8').split('\n')
    .filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{
      const index=line.indexOf('=');
      return [line.slice(0,index),line.slice(index+1).trim().replace(/^(["'])(.*)\1$/,'$2')];
    }));
}
