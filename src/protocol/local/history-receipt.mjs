import {contractMetadata} from './generated/contracts.mjs';
import {ContractError} from '../errors.mjs';
import {validateType,validateRequest,validateBoundResponse,validateDigestBinding,digestValue,deepFreeze} from './runtime.mjs';

export const historicalReceipt=contractMetadata.historicalReceipt;
const {wire,operation}=historicalReceipt;
/** Provider side: answers QueryTransaction with a durable receipt exactly as written. The
 * envelope names the request's current context; the receipt and its stored digest are never
 * re-bound. A stored digest that does not match the receipt, or a receipt of another world or
 * transaction, refuses rather than being repaired. */
export function historicalReceiptResponse(requestInput,storedReceipt,storedReceiptDigest) {
 const request=validateRequest(wire,operation,requestInput);
 const receipt=validateType('ReceiptProjection',storedReceipt);
 return validateBoundResponse(wire,operation,request,{contractVersion:request.contractVersion,requestId:request.requestId,result:receipt,error:null,currentLocalContext:request.localContext,receiptDigest:storedReceiptDigest});
}
/** Consumer side: validates the exchange, then reads the written and current contexts side by
 * side. A response without the pair has written === current by the unchanged full-equality rule. */
export function readHistoricalReceipt(requestInput,responseInput) {
 const response=validateBoundResponse(wire,operation,requestInput,responseInput);
 if(response.result===null)throw new TypeError('QueryTransaction response carries no receipt');
 const receipt=response.result,written=receipt.localContext,historical=Object.hasOwn(response,'currentLocalContext');
 const current=historical?response.currentLocalContext:written;
 return deepFreeze({receipt,receiptDigest:historical?response.receiptDigest:digestValue('receipt',receipt).sha256,historical,writtenContext:written,currentContext:current,
  sameConnection:written.connectionRef===current.connectionRef,
  sameIncarnation:written.connectionIncarnationRef===current.connectionIncarnationRef,
  sameSelectionRevision:written.selectionRevision===current.selectionRevision});
}
/** Stateless published-fixture provider over fixture.durable [{receipt,receiptDigest}]. Every
 * stored digest is checked at construction. A receipt of another world is refused with
 * CURRENT_WORLD_MISMATCH naming the requested world; no filesystem/process/world work. */
export function createHistoricalReceiptMock(fixture) {
 const durable=structuredClone(fixture.durable);
 for(const row of durable)validateDigestBinding('receipt',validateType('ReceiptProjection',row.receipt),row.receiptDigest);
 return (w,op,input)=>{
  const request=validateRequest(w,op,input);
  if(w!==wire||op!==operation)throw new TypeError('The historical receipt mock answers only world-adapter/v8 QueryTransaction');
  const row=durable.find(r=>r.receipt.transactionId===request.transactionId&&r.receipt.transactionPayloadDigest===request.transactionPayloadDigest);
  if(!row)throw new TypeError('No supplied durable receipt for this transaction');
  if(row.receipt.localContext.worldRef!==request.worldRef){
   const error=new ContractError('CURRENT_WORLD_MISMATCH','validate','REVISION_CHANGED',{transactionRef:request.transactionId,worldRef:request.worldRef}).publicError;
   return deepFreeze(validateBoundResponse(wire,operation,request,{contractVersion:request.contractVersion,requestId:request.requestId,result:null,error}));
  }
  return deepFreeze(historicalReceiptResponse(request,row.receipt,row.receiptDigest));
 };
}
