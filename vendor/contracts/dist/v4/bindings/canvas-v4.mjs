import { operationContracts, validateRequest, admitRequest, validateResponse, validateCanvasEvent } from '../runtime.mjs';
export const contractVersion = "canvas/v4";
export const operations = operationContracts[contractVersion];
export const validate = (operation, value) => validateRequest(contractVersion, operation, value);
export const admit = (operation, bytes) => admitRequest(contractVersion, operation, bytes);
export const response = (operation, value) => validateResponse(contractVersion, operation, value);
export const event = validateCanvasEvent;
