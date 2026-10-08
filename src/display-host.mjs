import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { displayHostContribution } from './display-remote.mjs';

export class CanvasDisplayService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'hanaworldsCanvasDisplay');
    // Apply the public standard decorator in native JS, using its initializer API.
    Remote(this.read, { kind: 'method', name: 'read', private: false, static: false,
      addInitializer: initializer => initializer.call(this) });
  }
  async read(sessionRef) {
    const canvas = this.ctx.get('hanaworldsCanvasV5');
    if (typeof canvas?.readObjectsHistory !== 'function')
      throw new RemoteError('canvas/display-unavailable', 'Canvas display service requires hanaworlds-canvas 0.6.0.');
    return canvas.readObjectsHistory(sessionRef);
  }
}
export const name = 'hanaworlds-canvas-display';
export const inject = ['typert', 'hanaworldsCanvasV5'];
export function apply(ctx) {
  ctx.typert.register(displayHostContribution);
  return new CanvasDisplayService(ctx);
}
export default { name, inject, apply };
