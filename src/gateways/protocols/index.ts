/**
 * Wire protocols spoken on the WebSocket gateway.
 *
 * Conventions:
 *   - Outer envelope: every JSON message is `{ topic: string, payload: unknown }`.
 *   - "Global" topics (`subscribe`, `unsubscribe`) have no scope prefix and are
 *     handled directly by the router's subscription registry.
 *   - "Scoped" topics use the wire format `<scope>::<action>`. The router strips
 *     the scope and dispatches the unscoped event to the matching service.
 *   - Each scope module declares its topics, payload schemas, and inferred types
 *     in a self-contained way (no knowledge of its own scope name).
 */

export enum Scope {
  Download = 'download',
  Settings = 'settings',
  Upload = 'upload',
}

export * from './envelope';
export * from './global';
