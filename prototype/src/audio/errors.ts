/**
 * Turns browser errors from getUserMedia / AudioContext into friendly,
 * plain-English messages for the owner. Pure (no DOM access) so it is unit tested.
 */

export type MicErrorKind =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-microphone'
  | 'mic-busy'
  | 'worklet-failed'
  | 'unknown';

export interface MicError {
  kind: MicErrorKind;
  title: string;
  help: string;
  /** Raw browser error, shown small for debugging. */
  detail: string;
}

const MESSAGES: Record<MicErrorKind, { title: string; help: string }> = {
  'insecure-context': {
    title: 'This page is not secure',
    help: 'The microphone only works on secure pages. Open the https:// link you were sent (not http://).',
  },
  unsupported: {
    title: 'This browser cannot use the microphone here',
    help: 'Please open the link in Google Chrome on your Android phone (not inside another app\'s built-in browser).',
  },
  'permission-denied': {
    title: 'Microphone permission was blocked',
    help: 'Tap the lock or settings icon next to the web address, set Microphone to "Allow", then reload the page and tap Start again. If no prompt appears, check Android Settings > Apps > Chrome > Permissions > Microphone.',
  },
  'no-microphone': {
    title: 'No microphone found',
    help: 'The phone did not report a microphone. Unplug any headset or adapter and try again.',
  },
  'mic-busy': {
    title: 'The microphone is busy',
    help: 'Another app (a call, voice recorder, or tuner app) may be using the microphone. Close it, then tap Start again.',
  },
  'worklet-failed': {
    title: 'Audio engine failed to load',
    help: 'Reload the page and try again. If it keeps happening, tell the developer and include the device info below.',
  },
  unknown: {
    title: 'Something went wrong starting the microphone',
    help: 'Reload the page and try again. If it keeps happening, tell the developer and include the message below.',
  },
};

export function makeMicError(kind: MicErrorKind, detail = ''): MicError {
  return { kind, ...MESSAGES[kind], detail };
}

/** Error names come from DOMException.name, which browsers set consistently. */
export function classifyMicError(err: unknown): MicError {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const message = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  const detail = name ? `${name}: ${message}` : message;

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError': // old Chrome name
    case 'SecurityError':
      return makeMicError('permission-denied', detail);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return makeMicError('no-microphone', detail);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return makeMicError('mic-busy', detail);
    default:
      return makeMicError('unknown', detail);
  }
}

/** Checks the environment before asking for the mic. Returns null if OK. */
export function checkEnvironment(env: { isSecureContext: boolean; hasGetUserMedia: boolean; hasAudioWorklet: boolean }): MicError | null {
  if (!env.isSecureContext) return makeMicError('insecure-context');
  if (!env.hasGetUserMedia || !env.hasAudioWorklet) return makeMicError('unsupported');
  return null;
}
