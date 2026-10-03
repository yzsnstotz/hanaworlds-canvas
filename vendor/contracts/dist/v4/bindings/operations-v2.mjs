import { validateType, admitType, digestValue } from '../runtime.mjs';
export const contractVersion = 'operations/v2';
export const validate = value => validateType('OperationsProjection', value);
export const admit = bytes => admitType('OperationsProjection', bytes);
export const digest = value => digestValue('operations', value);
export const validateCompiledSet = value => validateType('CompiledOperationSet', value);
