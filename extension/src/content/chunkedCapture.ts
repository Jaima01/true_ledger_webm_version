/**
 * chunkedCapture.ts
 *
 * Composite-stream capture pipeline for VERI-Real.
 *
 * ── Why the previous timeslice approach produced the same first 5 seconds ──
 *
 * MediaRecorder(stream, { timeslice: 5000 }) does NOT produce independently
 * decodable files.  Each ondataavailable chunk is a WebM *cluster segment* —
 * a continuation of the stream.  Only the FIRST chunk contains the EBML
 * header + Tracks element that a player needs to understand the codec
 * parameters.  Chunks 2, 3, 4 … are raw cluster data with no header, so:
 *
 *   • VLC / Chrome replay the first chunk's cached header → all files play
 *     back the very first 5 seconds.
 *   • ffprobe shows "invalid data found when processing input".
 *
 * ── The fix: cyclic stop → collect → restart ─────────────────────────────
 *
 * We control chunking ourselves:
 *   1.  Start a fresh MediaRecorder on the same composite stream.
 *   2.  After CHUNK_DURATION_MS, call recorder.stop().
 *       → ondataavailable fires with all data accumulated in this cycle.
 *       → onstop fires.
 *   3.  In onstop: concatenate blobs → one complete, independently
 *       decodable WebM file (its own EBML header + Tracks + cluster data).
 *       Emit the file and immediately start the next cycle.
 *
 * The composite stream (canvas video + video-element audio) stays alive
 * across cycles — only the MediaRecorder is recycled.  The draw loop never
 * pauses, so there are no frozen frames at cycle boundaries.
 *
 * ── Design overview ───────────────────────────────────────────────────────
 *
 *  1. 224×224 offscreen <canvas> ← video frames painted at ~15 fps
 *  2. canvas.captureStream(15)   → live video track (called before drawImage)
 *  3. video.captureStream()      → audio track fork (CORS-independent)
 *  4. Composite MediaStream      = video track + audio track
 *  5. Cyclic MediaRecorder       → complete 5-second WebM per cycle
 *  6. Each chunk:
 *       a. Downloaded locally for quality inspection (DEV_DOWNLOAD_CHUNKS).
 *       b. POSTed via fetch() directly from the content script (not via SW).
 */

import type { VideoMetadataPayload } from '../shared/types';

// ─── Build-time config ────────────────────────────────────────────────────────

const ORCHESTRATOR_BASE: string =
  (import.meta.env.VITE_ORCHESTRATOR_BASE as string | undefined) ??
  'http://localhost:8000';

/**
 * Flip to false once the /api/analyze-chunk endpoint is production-ready.
 * When true every chunk is downloaded to the filesystem for local inspection.
 */
const DEV_DOWNLOAD_CHUNKS = true;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Side length of the offscreen capture canvas in pixels. */
const CANVAS_SIZE = 224;

/** Target frame rate for the canvas draw loop. */
const CAPTURE_FPS = 15;

/** setInterval cadence that drives the draw loop (≈ 67 ms). */
const DRAW_INTERVAL_MS = Math.round(1000 / CAPTURE_FPS);

/**
 * How long each MediaRecorder cycle runs before it is stopped and a new one
 * is started.  Every cycle produces one independently decodable WebM file.
 */
const CHUNK_DURATION_MS = 5_000;

/** Backend route that receives multipart chunk uploads. */
const CHUNK_ENDPOINT = '/api/analyze-chunk';

/** Preferred MIME types in priority order. */
const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

function selectMimeType(): string {
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChunkCaptureStatus =
  | 'idle'        // constructed, not yet recording
  | 'recording'   // cyclic recording is active
  | 'cors-error'  // canvas tainted — recording not possible
  | 'stopped';    // cleanly terminated

export type ChunkedCaptureSession = {
  readonly sessionKey: string;
  readonly media: HTMLVideoElement;
  readonly metadata: VideoMetadataPayload;

  // DOM resources — nulled on cleanup
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;

  // Stream resources — nulled on cleanup
  canvasStream: MediaStream | null;
  audioStream: MediaStream | null;
  compositeStream: MediaStream | null;

  // Current cycle's recorder (replaced each cycle)
  mediaRecorder: MediaRecorder | null;

  // Timer for the draw loop
  drawIntervalId: ReturnType<typeof window.setInterval> | null;

  // Timer that triggers the end of each recording cycle
  cycleTimerId: ReturnType<typeof window.setTimeout> | null;

  // Blob accumulator for the current cycle — cleared after each flush
  _cycleBlobs: Blob[];

  // Selected MIME type (constant for the whole session)
  _mimeType: string;

  // Counters
  chunkSequence: number;
  uploadErrors: number;

  // Lifecycle
  status: ChunkCaptureStatus;
  stopped: boolean;

  // Stored so removeEventListener can be called precisely
  _onVideoEnded: (() => void) | null;

  /**
   * Pause handler: flushes the current partial chunk and suspends the cycle
   * loop.  Only assigned when recording is active.
   */
  _onPause: (() => void) | null;

  /**
   * Resume handler: restarts the cycle loop when the user un-pauses.
   * Only assigned when recording is active.
   */
  _onResume: (() => void) | null;
};

// ─── Module-level singleton ───────────────────────────────────────────────────

let _activeSession: ChunkedCaptureSession | null = null;

export function getActiveChunkedSession(): ChunkedCaptureSession | null {
  return _activeSession;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts a cyclic chunked composite capture session.
 *
 * @param media            Playing <video> element to capture.
 * @param metadata         Extracted YouTube metadata.
 * @param onStatusChange   Optional callback on status transitions.
 */
export function startChunkedCaptureSession(
  media: HTMLVideoElement,
  metadata: VideoMetadataPayload,
  onStatusChange?: (status: ChunkCaptureStatus) => void
): ChunkedCaptureSession | null {

  // ── Guard: deduplicate ────────────────────────────────────────────────────
  const sessionKey = `${metadata.video_id}|${window.location.href}`;

  if (_activeSession?.sessionKey === sessionKey && !_activeSession.stopped) {
    console.log('[VERI-Real] Chunked capture already active for:', metadata.video_id);
    return _activeSession;
  }

  if (_activeSession) {
    stopChunkedCaptureSession('start-new-session');
  }

  // ── Step 1: Offscreen canvas ──────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  const ctx = canvas.getContext('2d', {
    willReadFrequently: false, // GPU-backed; we never read pixels back
    alpha: false,              // opaque → less compositing overhead
  });

  if (!ctx) {
    console.error('[VERI-Real] 2D context unavailable — aborting capture.');
    return null;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // ── Step 2: Canvas video track ────────────────────────────────────────────
  //
  // CRITICAL: call captureStream() NOW, while the canvas origin-clean flag is
  // still true — before the first drawImage() potentially taints it.
  // The returned MediaStreamTrack continues delivering frames from the canvas
  // even after the canvas is tainted, because it captures composited output,
  // not raw pixel reads.
  //
  let canvasStream: MediaStream;
  try {
    canvasStream = canvas.captureStream(CAPTURE_FPS);
  } catch (err) {
    console.info(
      '[VERI-Real] captureStream() failed before first draw — CORS restriction:',
      err instanceof DOMException ? err.name : err
    );
    return null;
  }

  if (canvasStream.getVideoTracks().length === 0) {
    console.warn('[VERI-Real] captureStream() returned no video tracks — aborting.');
    stopAllTracks(canvasStream);
    return null;
  }

  // ── Step 3: Audio fork ────────────────────────────────────────────────────
  //
  // Audio comes from the VIDEO ELEMENT's internal decoded PCM, not from the
  // canvas.  This path is completely independent of canvas CORS restrictions.
  //
  let audioStream: MediaStream | null = null;
  try {
    const veStream = (
      (media as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      }).captureStream?.() ??
      (media as HTMLVideoElement & {
        mozCaptureStream?: () => MediaStream;
      }).mozCaptureStream?.()
    );

    if (veStream) {
      const audioTracks = veStream.getAudioTracks();
      if (audioTracks.length > 0) {
        // Build an audio-only stream so we don't accidentally include a second
        // video track from the element's own stream.
        audioStream = new MediaStream(audioTracks);
        console.log('[VERI-Real] Audio forked:', {
          tracks: audioTracks.length,
          label: audioTracks[0]?.label ?? '(unlabelled)',
        });
      } else {
        console.log('[VERI-Real] Video element has no audio tracks (muted / silent).');
      }
    }
  } catch (err) {
    console.warn('[VERI-Real] Audio fork failed — continuing video-only:', err);
  }

  // ── Step 4: Composite stream ──────────────────────────────────────────────
  const compositeTracks: MediaStreamTrack[] = [
    ...canvasStream.getVideoTracks(),
    ...(audioStream?.getAudioTracks() ?? []),
  ];
  const compositeStream = new MediaStream(compositeTracks);

  // ── Step 5: Session object ────────────────────────────────────────────────
  const mimeType = selectMimeType();

  const session: ChunkedCaptureSession = {
    sessionKey,
    media,
    metadata,
    canvas,
    ctx,
    canvasStream,
    audioStream,
    compositeStream,
    mediaRecorder: null,
    drawIntervalId: null,
    cycleTimerId: null,
    _cycleBlobs: [],
    _mimeType: mimeType,
    chunkSequence: 0,
    uploadErrors: 0,
    status: 'idle',
    stopped: false,
    _onVideoEnded: null,
    _onPause: null,
    _onResume: null,
  };

  _activeSession = session;

  // ── Step 6: Start draw loop ───────────────────────────────────────────────
  //
  // Warm the canvas immediately so the first cycle's initial frames are not
  // blank, then continue at DRAW_INTERVAL_MS cadence.
  //
  _drawFrameToCanvas(session);
  session.drawIntervalId = window.setInterval(() => {
    _drawFrameToCanvas(session);
  }, DRAW_INTERVAL_MS);

  // ── Step 7: Launch first recording cycle ──────────────────────────────────
  //
  // Each call to _startCycle() creates a fresh MediaRecorder, records for
  // CHUNK_DURATION_MS, then its onstop handler emits the chunk and calls
  // _startCycle() again — creating a self-sustaining loop.
  //
  _startCycle(session);

  session.status = 'recording';
  onStatusChange?.('recording');

  // ── Step 8: Lifecycle listeners (ended / pause / play) ──────────────────

  // Video ended → tear the whole session down.
  const onVideoEnded = () => {
    console.log('[VERI-Real] Video ended — finalising capture session.');
    stopChunkedCaptureSession('video-ended');
  };
  session._onVideoEnded = onVideoEnded;
  media.addEventListener('ended', onVideoEnded, { once: true });

  // Video paused → cut the current cycle short, emit whatever was captured,
  // and do NOT start a new cycle.  The play listener below will restart.
  const onPause = () => {
    if (session.stopped) return;

    console.log('[VERI-Real] Video paused — flushing partial chunk and suspending capture.');

    // Cancel the cycle timer so the scheduled stop() doesn't fire a second time.
    if (session.cycleTimerId !== null) {
      window.clearTimeout(session.cycleTimerId);
      session.cycleTimerId = null;
    }

    // Calling stop() fires ondataavailable (with whatever was buffered so far)
    // then onstop.  The onstop handler checks media.paused and will NOT start
    // the next cycle, so recording genuinely suspends here.
    if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
      session.mediaRecorder.stop();
    }
  };
  session._onPause = onPause;
  media.addEventListener('pause', onPause);

  // Video resumed → start a fresh 5-second cycle from this moment.
  const onResume = () => {
    if (session.stopped) return;
    // Guard: don't double-start if the recorder somehow still exists
    if (session.mediaRecorder && session.mediaRecorder.state === 'recording') return;

    console.log('[VERI-Real] Video resumed — starting fresh capture cycle.');
    _startCycle(session);
  };
  session._onResume = onResume;
  media.addEventListener('play', onResume);

  console.log('[VERI-Real] Chunked capture session started:', {
    video_id:     metadata.video_id,
    canvas_size:  `${CANVAS_SIZE}×${CANVAS_SIZE}`,
    fps:          CAPTURE_FPS,
    chunk_dur_ms: CHUNK_DURATION_MS,
    mime:         mimeType || '(browser default)',
    has_audio:    (audioStream?.getAudioTracks().length ?? 0) > 0,
    endpoint:     `${ORCHESTRATOR_BASE}${CHUNK_ENDPOINT}`,
  });

  return session;
}

/**
 * Stops the active session and releases all resources.
 * Idempotent — safe to call multiple times.
 */
export function stopChunkedCaptureSession(reason: string): void {
  const session = _activeSession;
  if (!session || session.stopped) return;

  console.log('[VERI-Real] Stopping chunked capture session:', {
    reason,
    video_id:      session.metadata.video_id,
    chunks_sent:   session.chunkSequence,
    upload_errors: session.uploadErrors,
  });

  session.stopped = true;
  session.status  = 'stopped';
  _activeSession  = null;

  _cleanupSession(session);
}

// ─── Cyclic recording ─────────────────────────────────────────────────────────

/**
 * Starts one recording cycle.
 *
 * Creates a new MediaRecorder on the shared composite stream, lets it record
 * for CHUNK_DURATION_MS, then calls stop().  The onstop handler:
 *   1. Concatenates all blobs accumulated during this cycle into one Blob.
 *   2. Because a freshly started MediaRecorder always writes a complete EBML
 *      header + Tracks element before the first cluster, the resulting Blob
 *      is a valid, independently decodable WebM file.
 *   3. Emits the file (download + upload).
 *   4. Starts the next cycle — unless the session has been stopped.
 *
 * The composite MediaStream itself is never stopped between cycles; only the
 * MediaRecorder is recycled.  The draw loop keeps painting frames throughout,
 * so there are no frozen or missing frames at cycle boundaries.
 */
function _startCycle(session: ChunkedCaptureSession): void {
  if (session.stopped || !session.compositeStream) return;

  // Each cycle gets a clean blob accumulator.
  session._cycleBlobs = [];

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(
      session.compositeStream,
      session._mimeType ? { mimeType: session._mimeType } : undefined
    );
  } catch (err) {
    console.error('[VERI-Real] MediaRecorder creation failed:', err);
    stopChunkedCaptureSession('recorder-create-failed');
    return;
  }

  session.mediaRecorder = recorder;

  // Accumulate blobs produced during this cycle.
  // With no timeslice, ondataavailable typically fires once on stop() with
  // all the data.  We still accumulate in an array in case the browser
  // decides to deliver multiple slices.
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      session._cycleBlobs.push(event.data);
    }
  };

  recorder.onstop = () => {
    // session.stopped may have been set while this recorder was still running.
    // Still emit the chunk — it contains real content and we don't want to
    // lose data — but don't start a new cycle.
    const blobs = session._cycleBlobs;
    session._cycleBlobs = [];

    if (blobs.length === 0) return;

    const chunkIndex = ++session.chunkSequence;

    // Concatenate all blobs into a single Blob.
    // This is the key: the resulting Blob starts with the EBML header that
    // the fresh MediaRecorder wrote at the beginning of the cycle, so it is
    // a complete, standalone WebM file — playable without any other chunks.
    const chunkBlob = new Blob(blobs, {
      type: recorder.mimeType || session._mimeType || 'video/webm',
    });

    console.log(`[VERI-Real] Cycle #${chunkIndex} complete:`, {
      video_id:   session.metadata.video_id,
      size_bytes: chunkBlob.size,
      mime:       chunkBlob.type,
    });

    if (DEV_DOWNLOAD_CHUNKS) {
      _downloadChunkLocally(chunkBlob, session.metadata.video_id, chunkIndex);
    }

    void _uploadChunkToBackend(chunkBlob, session, chunkIndex);

    // Only auto-restart the cycle if:
    //  • the session is still alive, AND
    //  • the video is currently playing (not paused, not ended).
    //
    // If the video was paused, the 'play' event listener will call
    // _startCycle() when the user resumes — so we must not start here
    // or we'd kick off a ghost cycle that records silence/frozen frames.
    if (!session.stopped && !session.media.paused && !session.media.ended) {
      _startCycle(session);
    } else if (!session.stopped && session.media.paused) {
      console.log('[VERI-Real] Capture suspended (video is paused).');
    }
  };

  recorder.onerror = (event: Event) => {
    const err = (event as Event & { error?: DOMException }).error;
    console.error('[VERI-Real] MediaRecorder error:', err?.name, err?.message);
    stopChunkedCaptureSession('recorder-error');
  };

  // Start with NO timeslice — we control the cut point ourselves via the
  // cycleTimerId.  Without a timeslice the browser collects all data and
  // delivers it in one ondataavailable call when stop() is called.
  recorder.start();

  // Schedule the end of this cycle.
  session.cycleTimerId = window.setTimeout(() => {
    if (session.stopped) return;

    // Clear the reference before calling stop() to prevent double-clear.
    session.cycleTimerId = null;

    // stop() → ondataavailable (with accumulated data) → onstop (starts next cycle).
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, CHUNK_DURATION_MS);
}

// ─── Frame drawing ────────────────────────────────────────────────────────────

/**
 * Paints the current video frame onto the offscreen canvas.
 *
 * CORS note: ctx.drawImage(crossOriginVideo) does not throw — it draws
 * successfully but marks the canvas origin-clean flag as false (tainted).
 * captureStream(), obtained before the first drawImage(), continues to stream
 * composited output from the tainted canvas without throwing.
 */
function _drawFrameToCanvas(session: ChunkedCaptureSession): void {
  if (session.stopped || !session.canvas || !session.ctx) return;

  const { media, ctx, canvas } = session;

  // Skip draw for paused / ended / not-yet-buffered frames to avoid
  // delivering duplicate frozen frames to the encoder.
  if (
    media.paused ||
    media.ended ||
    media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return;
  }

  try {
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'SecurityError') {
      if (session.status !== 'cors-error') {
        // Log once at info level — expected for cross-origin media.
        console.info(
          '[VERI-Real] CORS canvas taint — recording unavailable for this video.',
          err.name
        );
        session.status = 'cors-error';
        stopChunkedCaptureSession('cors-taint');
      }
    }
    // Any other error: skip this frame; don't tear down the session.
  }
}

// ─── Chunk upload ─────────────────────────────────────────────────────────────

/**
 * POSTs one WebM chunk directly from the content script via fetch().
 *
 * Why not via the service worker?
 *  • MV3 structured-clone limit is ~64 KB.  A 5-second 224p chunk is
 *    typically 300 KB – 1.5 MB.
 *  • Content scripts can fetch() any URL in host_permissions directly.
 *  • The service worker stays stateless and can be safely suspended by Chrome.
 */
async function _uploadChunkToBackend(
  blob: Blob,
  session: ChunkedCaptureSession,
  chunkIndex: number
): Promise<void> {
  const url = `${ORCHESTRATOR_BASE}${CHUNK_ENDPOINT}`;

  const formData = new FormData();
  formData.append(
    'chunk',
    blob,
    `chunk-${String(chunkIndex).padStart(5, '0')}.webm`
  );
  formData.append('video_id',    session.metadata.video_id);
  formData.append('chunk_index', String(chunkIndex));
  formData.append('page_url',    window.location.href);
  formData.append('captured_at', new Date().toISOString());

  if (session.metadata.channel_name) {
    formData.append('channel_name', session.metadata.channel_name);
  }
  if (session.metadata.content_title) {
    formData.append('content_title', session.metadata.content_title);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      // Never set Content-Type manually — the browser must write the
      // multipart/form-data boundary into it automatically.
    });

    if (!response.ok) {
      console.warn(
        `[VERI-Real] Chunk #${chunkIndex} upload → HTTP ${response.status}`
      );
      session.uploadErrors++;
      return;
    }

    // ── Parse and log the backend confirmation ──────────────────────────────
    const ack = await response.json() as {
      status: string;
      video_id: string;
      chunk_index: number;
      size_bytes: number;
    };

    console.log(
      `%c[VERI-Real] ✅ Chunk #${ack.chunk_index} confirmed by backend`,
      'color: #22c55e; font-weight: bold;',
      {
        status:     ack.status,
        video_id:   ack.video_id,
        chunk_index: ack.chunk_index,
        size_bytes: ack.size_bytes,
        size_kb:    `${(ack.size_bytes / 1024).toFixed(1)} KB`,
      }
    );

  } catch (err) {
    session.uploadErrors++;
    // "Failed to fetch" is expected when the backend is not yet running.
    const isNetwork = err instanceof TypeError && err.message.includes('fetch');
    if (!isNetwork) {
      console.warn(`[VERI-Real] Chunk #${chunkIndex} upload error:`, err);
    }
  }
}

// ─── Local download (dev only) ────────────────────────────────────────────────

/**
 * Downloads a WebM chunk to disk for local quality inspection.
 * Open the files in Chrome, VLC, or run: ffprobe veri-real-*.webm
 * Each file should play independently, starting from its own timestamp.
 */
function _downloadChunkLocally(
  blob: Blob,
  videoId: string,
  chunkIndex: number
): void {
  const safeId   = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `veri-real-${safeId}-chunk-${String(chunkIndex).padStart(5, '0')}.webm`;

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href     = objectUrl;
  a.download = fileName;
  a.rel      = 'noopener';

  document.body.appendChild(a);
  a.click();
  a.remove();

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Releases all resources held by a session.
 *
 * Order:
 *  1. Clear the cycle timer     — prevents a pending timeout from firing stop()
 *     on an already-stopped recorder.
 *  2. Stop MediaRecorder        — flushes final ondataavailable.
 *  3. Clear draw loop timer     — no more drawImage() calls.
 *  4. Stop all tracks           — releases GPU/hardware decoder slots.
 *  5. Null canvas references    — 224×224×4 ≈ 200 KB VRAM freed for GC.
 *  6. Remove event listeners    — prevents dangling closures on the player.
 */
function _cleanupSession(session: ChunkedCaptureSession): void {
  // 1. Cancel pending cycle timer
  if (session.cycleTimerId !== null) {
    window.clearTimeout(session.cycleTimerId);
    session.cycleTimerId = null;
  }

  // 2. Stop current recorder
  if (session.mediaRecorder && session.mediaRecorder.state !== 'inactive') {
    try {
      session.mediaRecorder.stop();
    } catch {
      // Already in error state — ignore.
    }
  }
  session.mediaRecorder = null;
  session._cycleBlobs   = [];

  // 3. Clear draw loop
  if (session.drawIntervalId !== null) {
    window.clearInterval(session.drawIntervalId);
    session.drawIntervalId = null;
  }

  // 4. Stop all media tracks
  for (const stream of [
    session.compositeStream,
    session.canvasStream,
    session.audioStream,
  ]) {
    if (stream) stopAllTracks(stream);
  }
  session.compositeStream = null;
  session.canvasStream    = null;
  session.audioStream     = null;

  // 5. Release canvas backing store
  session.ctx    = null;
  session.canvas = null;

  // 6. Remove event listeners
  if (session._onVideoEnded) {
    session.media.removeEventListener('ended', session._onVideoEnded);
    session._onVideoEnded = null;
  }
  if (session._onPause) {
    session.media.removeEventListener('pause', session._onPause);
    session._onPause = null;
  }
  if (session._onResume) {
    session.media.removeEventListener('play', session._onResume);
    session._onResume = null;
  }

  console.log('[VERI-Real] Session resources released:', session.metadata.video_id);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function stopAllTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
