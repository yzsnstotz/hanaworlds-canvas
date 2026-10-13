import { createHash } from 'node:crypto';
import { canonicalJSON } from '../../src/protocol/local/index.mjs';
import { failSupply } from './snapshot.mjs';

export const sha = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
export function pointer(value,path) {
  let row=value;
  for(const part of path.split('/').slice(1)) {
    if(row===null || row===undefined || !Object.hasOwn(Object(row),part)) return undefined;
    row=row[part];
  }
  return row;
}
export function applyBinding(value,spec,actual) {
  const path=spec.path.split('/').slice(1); let row=value;
  for(const key of path.slice(0,-1)) { if(!row || !Object.hasOwn(row,key)) return false; row=row[key]; }
  const key=path.at(-1);
  if(spec.kind==='RefKey') {
    const old=key.slice(5); if(!row || !Object.hasOwn(row,old)) return false;
    const child=row[old]; delete row[old]; row[actual]=child; return true;
  }
  if(!row || !Object.hasOwn(row,key) || canonicalJSON(row[key])!==canonicalJSON(spec.example)) return false;
  row[key]=actual; return true;
}
export function binding(spec,value,before,evidence) {
  if(!['Ref','RefKey','Revision','Digest','ObservationTime','NativeCode'].includes(spec.kind))
    failSupply('INVALID_DOCUMENT_BINDING','setup',{path:spec.path,kind:spec.kind});
  // The approved rule is narrower than the legacy data labels: a material is immutable.
  if(/\/materialRef(?:\/|$)/.test(spec.path))
    failSupply('IMMUTABLE_MATERIAL_BINDING','setup',{path:spec.path});
  if(typeof value!=='string' && !(spec.kind==='NativeCode' && value===null))
    failSupply('CURRENT_BINDING_VALUE_UNAVAILABLE','setup',{path:spec.path,kind:spec.kind});
  if(spec.kind==='Digest' && !/^[a-f0-9]{64}$/.test(value))
    failSupply('CURRENT_DIGEST_UNAVAILABLE','setup',{path:spec.path});
  return {...spec,value,...(before?{observedBeforeCall:true}:{observationPhase:'AFTER_CALL_READBACK',evidence})};
}
export function fixedShape(value,permitted,prefix='/request') {
  const copy=structuredClone(value);
  for(const spec of permitted.filter(x=>x.path.startsWith(prefix+'/'))) {
    if(/\/materialRef(?:\/|$)/.test(spec.path)) continue;
    const local={...spec,path:spec.path.slice(prefix.length)};
    if(local.kind==='RefKey') continue;
    const current=pointer(copy,local.path);
    if(current!==undefined) applyBinding(copy,{...local,example:current},`<${spec.kind}>`);
  }
  return copy;
}
export function matchFixedShape(a,b,permitted,prefix='/request') {
  return canonicalJSON(fixedShape(a,permitted,prefix))===canonicalJSON(fixedShape(b,permitted,prefix));
}
