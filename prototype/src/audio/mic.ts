/**
 * Browser-only microphone glue: getUserMedia with voice processing OFF,
 * AudioContext lifecycle, capture worklet, wake lock, and a settings report.
 */
import captureWorkletUrl from './capture.worklet.ts?worker&url';
import { CAPTURE_PROCESSOR_NAME, type CaptureOptions, type ControlMessage, type WorkletMessage } from './messages';
import { checkEnvironment, classifyMicError, makeMicError, type MicError } from './errors';

/** Exactly what we ask the browser for. Processing must be OFF for guitar. */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};

export interface MicCallbacks {
  onMessage(msg: WorkletMessage): void;
  /** Something about the session changed (context state, track state, wake lock). */
  onChange(): void;
}

export interface MicInfo {
  contextState: string;
  sampleRate: number;
  baseLatencySec: number | undefined;
  outputLatencySec: number | undefined;
  trackLabel: string;
  trackReadyState: string;
  trackMuted: boolean;
  trackEnabled: boolean;
  settings: MediaTrackSettings;
  supportedConstraints: MediaTrackSupportedConstraints;
  wakeLock: 'active' | 'released' | 'unsupported' | 'failed';
}

export class MicSession {
  private stream: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockStatus: MicInfo['wakeLock'] = 'released';
  private stopped = false;

  private constructor(
    readonly ctx: AudioContext,
    stream: MediaStream,
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
    private readonly cb: MicCallbacks,
  ) {
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(node);
    this.watchTrack();
    ctx.addEventListener('statechange', this.onAnyChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    node.port.onmessage = (e: MessageEvent<WorkletMessage>) => cb.onMessage(e.data);
  }

  /**
   * Must be called directly from a user gesture (the Start button click).
   * Throws a MicError with a friendly message on failure.
   */
  static async start(options: CaptureOptions, cb: MicCallbacks): Promise<MicSession> {
    const envError = checkEnvironment({
      isSecureContext: window.isSecureContext,
      hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
      hasAudioWorklet: typeof AudioWorkletNode !== 'undefined',
    });
    if (envError) throw envError;

    // Create and resume the context synchronously inside the gesture, before any await.
    // Do NOT force a sample rate: use whatever the hardware runs at.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const resumed = ctx.resume().catch(() => undefined);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      void ctx.close();
      throw classifyMicError(err);
    }

    try {
      await ctx.audioWorklet.addModule(captureWorkletUrl);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw makeMicError('worklet-failed', String(err));
    }
    await resumed;

    const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: options,
    });
    // Route through a silent gain to the destination so the browser keeps pulling
    // the graph (some browsers skip nodes not connected to the output). Nothing is audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    const session = new MicSession(ctx, stream, node, sink, cb);
    await session.requestWakeLock();
    return session;
  }

  /** Sends a control message to the capture worklet (settings, noise floor, record on/off). */
  post(msg: ControlMessage): void {
    this.node.port.postMessage(msg);
  }

  get track(): MediaStreamTrack {
    return this.stream.getAudioTracks()[0];
  }

  /** True when audio is not flowing and the user must tap "resume". */
  needsResume(): boolean {
    if (this.stopped) return false;
    return this.ctx.state !== 'running' || this.track.readyState === 'ended';
  }

  /** Call from a user gesture (the "Tap to resume" button). */
  async resume(): Promise<void> {
    if (this.track.readyState === 'ended') {
      await this.replaceStream();
    }
    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
    await this.requestWakeLock();
    this.cb.onChange();
  }

  info(): MicInfo {
    const ctx = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    const track = this.track;
    return {
      contextState: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatencySec: typeof ctx.baseLatency === 'number' ? ctx.baseLatency : undefined,
      outputLatencySec: typeof ctx.outputLatency === 'number' ? ctx.outputLatency : undefined,
      trackLabel: track.label,
      trackReadyState: track.readyState,
      trackMuted: track.muted,
      trackEnabled: track.enabled,
      settings: track.getSettings(),
      supportedConstraints: navigator.mediaDevices.getSupportedConstraints(),
      wakeLock: this.wakeLockStatus,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stream.getTracks().forEach((t) => t.stop());
    this.source.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
    await this.wakeLock?.release().catch(() => undefined);
    await this.ctx.close();
  }

  private async replaceStream(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      throw classifyMicError(err);
    }
    this.source.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.node);
    this.watchTrack();
  }

  private watchTrack(): void {
    const t = this.track;
    t.addEventListener('ended', this.onAnyChange);
    t.addEventListener('mute', this.onAnyChange);
    t.addEventListener('unmute', this.onAnyChange);
  }

  private async requestWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) {
      this.wakeLockStatus = 'unsupported';
      return;
    }
    if (this.wakeLock && !this.wakeLock.released) return;
    if (document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLockStatus = 'active';
      this.wakeLock.addEventListener('release', () => {
        this.wakeLockStatus = 'released';
        this.cb.onChange();
      });
    } catch {
      this.wakeLockStatus = 'failed';
    }
  }

  private readonly onAnyChange = (): void => {
    this.cb.onChange();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible' && !this.stopped) {
      // The wake lock is dropped when the page is hidden; take it again.
      void this.requestWakeLock().then(() => this.cb.onChange());
      // Try a silent resume; if the browser refuses (no gesture), the UI shows the resume button.
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    }
    this.cb.onChange();
  };
}

export type { MicError };
