import type {
  CapturedFrame,
  RuntimeMessage,
  VerifyMediaMessage,
  VerifyResult,
  VideoFramesBatchMessage,
  VideoMetadataMessage,
  VideoMetadataPayload
} from '../shared/types';
import {
  startChunkedCaptureSession,
  stopChunkedCaptureSession,
  getActiveChunkedSession,
  type ChunkCaptureStatus
} from './chunkedCapture';

type MediaElement = HTMLImageElement | HTMLVideoElement;
type VerificationStatus = 'checking' | 'done' | 'error';

type VerificationIdentityState = {
  status: VerificationStatus;
  result: VerifyResult;
  startedAt: number;
  updatedAt: number;
  requestId: number;
  lastMediaRef: MediaElement | null;
};

const OVERLAY_ID = 'veri-real-overlay-root';
const CLASS_BADGE = 'veri-real-badge';
const CLASS_CHECK_BUTTON = 'veri-real-check-button';
const CLASS_STATUS_DOT = 'veri-real-status-dot';
const CLASS_STATUS_TOOLTIP = 'veri-real-status-tooltip';
const CLASS_CHECK_BUTTON_CHECKING_ACTIVE = 'is-checking-active';
const VERIFY_MIN_INTERVAL_MS = 3000;
const MAX_CONCURRENT_VERIFICATIONS = 3;
const MAX_FRAME_DATA_URL_CHARS = 2_000_000;
const BACKGROUND_RESPONSE_TIMEOUT_MS = 130_000;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_IDENTITIES = 50;
const FRAME_CAPTURE_INTERVAL_MS = 67;
const FRAME_FLUSH_INTERVAL_MS = 5000;
const FRAME_BATCH_SIZE = 75;
const FRAME_BATCH_PREVIEW_VIDEO_ENABLED = true;
const FRAME_BATCH_PREVIEW_FPS = 15;
const FRAME_CAPTURE_SIZE = 224;
const FRAME_CAPTURE_JPEG_QUALITY = 0.82;
const AUTO_CAPTURE_ON_PLAY_STORAGE_KEY = 'veriRealAutoCaptureOnPlay';
const AUDIO_RECORD_DURATION_MS = 5000;

let extensionEnabled = true;
let autoCaptureOnPlayEnabled = true;
let nextId = 1;
let inFlightVerifications = 0;
let hoveredMedia: MediaElement | null = null;
let lastPointerTarget: Element | null = null;
let cardMedia: MediaElement | null = null;
let extensionContextInvalid = false;
let contextRecoveryAttempts = 0;
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 3;

const checkButtonsByMedia = new Map<MediaElement, HTMLButtonElement>();
let statusDotEl: HTMLButtonElement | null = null;
let statusTooltipEl: HTMLDivElement | null = null;
let activeMedia: MediaElement | null = null;
let activeResult: VerifyResult | null = null;
let isCheckingActive = false;
let activeMediaContentIdentity: string | null = null;
let nextVerificationRequestId = 1;
const verificationByIdentity = new Map<string, VerificationIdentityState>();
const verificationState = new WeakMap<
  MediaElement,
  {
    lastSignature: string;
    lastCheckedAt: number;
    inFlight: boolean;
  }
>();

type FrameCaptureSession = {
  sessionKey: string;
  media: HTMLVideoElement;
  metadata: VideoMetadataPayload;
  sequence: number;
  capturedFrames: CapturedFrame[];
  pendingFrames: CapturedFrame[];
  pendingAudioChunks: Blob[];
  captureTimerId: number | null;
  flushTimerId: number | null;
  inFlight: boolean;
  stopped: boolean;
  mediaRecorder: MediaRecorder | null;
  audioChunks: Blob[];
  audioStream: MediaStream | null;
  audioMimeType: string;
};

let activeFrameCaptureSession: FrameCaptureSession | null = null;
const completedFrameCaptureKeys = new Map<
  string,
  {
    completedAt: string;
    metadata: VideoMetadataPayload;
  }
>();

function normalizeDurationSeconds(durationSeconds: number): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }

  return Number(durationSeconds.toFixed(1));
}

function getFrameCaptureCompletionKey(metadata: VideoMetadataPayload): string | null {
  const normalizedDuration = normalizeDurationSeconds(metadata.duration_seconds);
  if (normalizedDuration === null) {
    return null;
  }

  return `youtube:${metadata.video_id}:${normalizedDuration}`;
}

function isFrameCaptureAlreadyCompleted(metadata: VideoMetadataPayload): boolean {
  const completionKey = getFrameCaptureCompletionKey(metadata);
  return completionKey ? completedFrameCaptureKeys.has(completionKey) : false;
}

function markFrameCaptureCompleted(metadata: VideoMetadataPayload): void {
  const completionKey = getFrameCaptureCompletionKey(metadata);
  if (!completionKey || completedFrameCaptureKeys.has(completionKey)) {
    return;
  }

  completedFrameCaptureKeys.set(completionKey, {
    completedAt: new Date().toISOString(),
    metadata
  });

  console.log('[VERI-Real] Marked video capture complete:', {
    video_id: metadata.video_id,
    duration_seconds: metadata.duration_seconds,
    completion_key: completionKey
  });
}

function getRemainingDurationMs(media: HTMLVideoElement): number | null {
  if (!Number.isFinite(media.duration) || media.duration <= 0) {
    return null;
  }

  const remainingSeconds = media.duration - media.currentTime;
  if (!Number.isFinite(remainingSeconds)) {
    return null;
  }

  return Math.max(0, Math.round(remainingSeconds * 1000));
}

function isNearMediaEnd(media: HTMLVideoElement, thresholdSeconds = 1): boolean {
  const remainingMs = getRemainingDurationMs(media);
  if (remainingMs === null) {
    return false;
  }

  return remainingMs <= thresholdSeconds * 1000;
}

function hasChromeStorageApi(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.storage !== 'undefined' &&
    typeof chrome.storage.sync !== 'undefined' &&
    typeof chrome.storage.onChanged !== 'undefined'
  );
}

function hasChromeRuntimeApi(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.id === 'string'
  );
}

bootstrap().catch((err) => {
  console.warn('[VERI-Real] bootstrap failed:', err);
});

async function bootstrap(): Promise<void> {
  console.log('[VERI-Real] Extension initializing on:', window.location.href);

  if (!hasChromeStorageApi() || !hasChromeRuntimeApi()) {
    console.warn('[VERI-Real] Chrome extension APIs are unavailable in this context.');
    return;
  }

  injectStyles();
  ensureUiElements();
  await hydrateEnabledState();
  console.log('[VERI-Real] Extension enabled state:', extensionEnabled);
  updateUiVisibility();

  const observer = new MutationObserver(() => {
    updateUiVisibility();
    scheduleReposition();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc', 'poster']
  });

  window.addEventListener(
    'scroll',
    () => {
      // Don't completely reset hoveredMedia; instead update it based on current mouse position
      // This ensures the check button stays accessible when scrolling to new content
      updateUiVisibility();
      scheduleReposition();
    },
    true
  );
  window.addEventListener('resize', () => {
    hoveredMedia = null;
    lastPointerTarget = null;
    updateUiVisibility();
    scheduleReposition();
  });
  window.addEventListener('mousemove', handlePointerMove, { passive: true });
  window.addEventListener('mouseleave', () => {
    hoveredMedia = null;
    lastPointerTarget = null;
    updateUiVisibility();
    scheduleReposition();
  });

  setInterval(() => {
    if (extensionEnabled) {
      updateUiVisibility();
      scheduleReposition();
    }
  }, 2500);

  document.addEventListener(
    'play',
    (event) => {
      if (!(event.target instanceof HTMLVideoElement)) {
        return;
      }

      if (!extensionEnabled || !autoCaptureOnPlayEnabled) {
        return;
      }

      void maybeAutoStartCaptureForVideo(event.target);
    },
    true
  );

  const activeVideo = document.querySelector('video');
  if (
    activeVideo instanceof HTMLVideoElement &&
    !activeVideo.paused &&
    !activeVideo.ended &&
    extensionEnabled &&
    autoCaptureOnPlayEnabled
  ) {
    void maybeAutoStartCaptureForVideo(activeVideo);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') {
      return;
    }

    if (changes.veriRealEnabled) {
      extensionEnabled = Boolean(changes.veriRealEnabled.newValue);
    }

    if (changes[AUTO_CAPTURE_ON_PLAY_STORAGE_KEY]) {
      autoCaptureOnPlayEnabled =
        changes[AUTO_CAPTURE_ON_PLAY_STORAGE_KEY].newValue !== false;
    }

    if (extensionEnabled) {
      updateUiVisibility();
    } else {
      // Tear down the chunked capture pipeline when the user disables the extension.
      stopChunkedCaptureSession('extension-disabled');
      clearAllBadges();
    }
  });

  window.addEventListener('beforeunload', () => {
    // Release all stream/canvas resources before the page tears down.
    stopChunkedCaptureSession('page-unload');
  });
}

async function hydrateEnabledState(): Promise<void> {
  if (!hasChromeStorageApi()) {
    extensionEnabled = true;
    autoCaptureOnPlayEnabled = true;
    return;
  }

  const state = await chrome.storage.sync.get([
    'veriRealEnabled',
    AUTO_CAPTURE_ON_PLAY_STORAGE_KEY
  ]);
  extensionEnabled = state.veriRealEnabled !== false;
  autoCaptureOnPlayEnabled = state[AUTO_CAPTURE_ON_PLAY_STORAGE_KEY] !== false;
}

function updateUiVisibility(): void {
  if (!extensionEnabled) {
    hideAllCheckButtons();
    hideStatusDot();
    return;
  }

  // Check if hoveredMedia is still valid (connected and on screen)
  if (hoveredMedia && (!hoveredMedia.isConnected || !isCandidate(hoveredMedia) || !isOnScreen(hoveredMedia))) {
    hoveredMedia = null;
    lastPointerTarget = null;
  }

  pruneVerificationState();
  syncActiveStateFromVisibleMedia();

  syncCheckButtons();

  for (const [media, button] of checkButtonsByMedia.entries()) {
    if (!media.isConnected || !button.isConnected || !extractContentData(media)) {
      continue;
    }

    if (isOnScreen(media)) {
      showCheckButton(media);
    } else {
      button.style.display = 'none';
    }
  }
}

function isMediaVisible(media: MediaElement): boolean {
  return media.isConnected && isCandidate(media) && isOnScreen(media);
}

function isCandidate(media: MediaElement): boolean {
  const rect = media.getBoundingClientRect();
  return rect.width >= 48 && rect.height >= 48;
}

function isOnScreen(media: MediaElement): boolean {
  const rect = media.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

// function getMediaUrl(media: MediaElement): string | null {
//   if (media instanceof HTMLImageElement) {
//     return media.currentSrc || media.src || null;
//   }

//   return media.currentSrc || media.src || media.poster || null;
// }
function getMediaUrl(media: MediaElement): string | null {
  // .currentSrc is the 'truth' for what is actually rendered/playing
  const activeUrl = media.currentSrc || media.src;

  if (media instanceof HTMLVideoElement) {
    // If no active source, try the first child <source> tag or the poster
    if (!activeUrl) {
      const sourceTag = media.querySelector('source');
      return sourceTag?.src || media.poster || null;
    }
  }

  return activeUrl || null;
}

function getMediaContentIdentity(media: MediaElement): string {
  const mediaUrl = normalizeUrl(getMediaUrl(media) ?? '');
  const extracted = extractContentData(media)?.url ?? '';
  const pageUrl = normalizeUrl(window.location.href);
  return `${media.tagName.toLowerCase()}|${mediaUrl}|${extracted}|${pageUrl}`;
}

function hasAnyCheckingVerification(): boolean {
  for (const state of verificationByIdentity.values()) {
    if (state.status === 'checking') {
      return true;
    }
  }
  return false;
}

function getCheckingIdentity(): string | null {
  for (const [identity, state] of verificationByIdentity.entries()) {
    if (state.status === 'checking') {
      return identity;
    }
  }

  return null;
}

function pickVisibleMediaForIdentity(identity: string): MediaElement | null {
  if (hoveredMedia && isMediaVisible(hoveredMedia) && getMediaContentIdentity(hoveredMedia) === identity) {
    return hoveredMedia;
  }

  if (activeMedia && isMediaVisible(activeMedia) && getMediaContentIdentity(activeMedia) === identity) {
    return activeMedia;
  }

  const mediaNodes = collectVerifiableMedia();
  for (const media of mediaNodes) {
    if (!isMediaVisible(media)) {
      continue;
    }
    if (getMediaContentIdentity(media) === identity) {
      return media;
    }
  }

  return null;
}

function syncActiveStateFromVisibleMedia(preferredIdentity?: string): void {
  const hoveredIdentity =
    hoveredMedia && isMediaVisible(hoveredMedia) ? getMediaContentIdentity(hoveredMedia) : null;
  let targetIdentity = preferredIdentity ?? activeMediaContentIdentity;

  if (!targetIdentity || !verificationByIdentity.has(targetIdentity)) {
    targetIdentity = hoveredIdentity && verificationByIdentity.has(hoveredIdentity) ? hoveredIdentity : null;
  }

  if (!targetIdentity) {
    activeMedia = null;
    activeResult = null;
    activeMediaContentIdentity = null;
    isCheckingActive = false;
    hideStatusDot();
    return;
  }

  const identityState = verificationByIdentity.get(targetIdentity);
  if (!identityState) {
    activeMedia = null;
    activeResult = null;
    activeMediaContentIdentity = null;
    isCheckingActive = false;
    hideStatusDot();
    return;
  }

  activeMediaContentIdentity = targetIdentity;
  activeResult = identityState.result;
  isCheckingActive = identityState.status === 'checking';
  const targetMedia = pickVisibleMediaForIdentity(targetIdentity);
  activeMedia = targetMedia;

  if (targetMedia && isMediaVisible(targetMedia)) {
    showStatusDot(targetMedia);
  } else {
    hideStatusDot();
  }
}

function upsertIdentityState(
  identity: string,
  update: Omit<VerificationIdentityState, 'updatedAt'>
): VerificationIdentityState {
  const nextState: VerificationIdentityState = {
    ...update,
    updatedAt: Date.now()
  };
  verificationByIdentity.set(identity, nextState);
  pruneVerificationState();
  return nextState;
}

function pruneVerificationState(): void {
  const now = Date.now();
  for (const [identity, state] of verificationByIdentity.entries()) {
    if (now - state.updatedAt > VERIFICATION_TTL_MS) {
      verificationByIdentity.delete(identity);
      if (activeMediaContentIdentity === identity) {
        activeMedia = null;
        activeResult = null;
        activeMediaContentIdentity = null;
        isCheckingActive = false;
      }
    }
  }

  while (verificationByIdentity.size > MAX_VERIFICATION_IDENTITIES) {
    let oldestIdentity: string | null = null;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;
    for (const [identity, state] of verificationByIdentity.entries()) {
      if (state.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = state.updatedAt;
        oldestIdentity = identity;
      }
    }
    if (!oldestIdentity) {
      break;
    }
    verificationByIdentity.delete(oldestIdentity);
  }
}

function resetActiveVerificationState(): void {
  activeMedia = null;
  activeResult = null;
  isCheckingActive = false;
  activeMediaContentIdentity = null;
  hideStatusDot();
}

async function verifyMedia(
  media: MediaElement,
  mediaUrl: string,
  frameDataUrl: string | null,
  signature: string,
  extracted: { url: string; platform: 'youtube' | 'twitter' } | null,
  contentIdentity: string,
  requestId: number
): Promise<void> {
  const mediaId = String(nextId++);

  const message: VerifyMediaMessage = {
    type: 'VERIFY_MEDIA',
    payload: {
      mediaId,
      mediaUrl,
      effectiveUrl:
        media instanceof HTMLVideoElement && isSupportedAiVideoPage(window.location.href)
          ? window.location.href
          : undefined,
      contentUrl: extracted?.url,
      platform: extracted?.platform,
      frameDataUrl: frameDataUrl ?? undefined,
      signature,
      mediaType: media instanceof HTMLImageElement ? 'img' : 'video',
      pageUrl: window.location.href
    }
  };

  const result = await sendVerifyMessage(message);

  const current = verificationByIdentity.get(contentIdentity);
  if (!current || current.requestId !== requestId || current.status !== 'checking') {
    return;
  }

  const normalized = normalizeCardResult(result);
  upsertIdentityState(contentIdentity, {
    status: normalized.label.toLowerCase().includes('checking') ? 'checking' : 'done',
    result: normalized,
    startedAt: current.startedAt,
    requestId,
    lastMediaRef: media
  });
  syncActiveStateFromVisibleMedia(contentIdentity);
}

async function maybeVerifyMedia(media: MediaElement, force = false): Promise<void> {
  if (extensionContextInvalid && contextRecoveryAttempts >= MAX_CONTEXT_RECOVERY_ATTEMPTS) {
    console.warn('[VERI-Real] Extension context invalid, recovery attempts exhausted');
    return;
  }

  if (inFlightVerifications >= MAX_CONCURRENT_VERIFICATIONS) {
    console.warn('[VERI-Real] Max concurrent verifications reached');
    return;
  }

  const mediaUrl = getMediaUrl(media) ?? '';
  const frameDataUrl = await captureFrameDataUrl(media);
  const extracted = extractContentData(media);
  const contentIdentity = getMediaContentIdentity(media);

  if (media instanceof HTMLVideoElement && extracted?.platform === 'youtube') {
    const metadata = extractYouTubeMetadata(media);
    if (metadata) {
      void sendVideoMetadataMessage(metadata);
      // Replace old frame-batching pipeline with the composite chunked recorder.
      // startChunkedCaptureSession is idempotent for the same videoId.
      startChunkedCaptureSession(media, metadata, (status: ChunkCaptureStatus) => {
        console.log('[VERI-Real] Chunk capture status →', status, 'for', metadata.video_id);
      });
    }
  } else {
    // Switched to a non-YouTube media element — tear down any active capture.
    const activeChunked = getActiveChunkedSession();
    if (activeChunked && activeChunked.media !== media) {
      stopChunkedCaptureSession('media-switched');
    }
  }

  if (!mediaUrl && !frameDataUrl && !extracted?.url) {
    console.warn('[VERI-Real] No source found to verify for this element.');
    return;
  }


  const signature = await signatureFor(media, mediaUrl, frameDataUrl);
  console.log('[VERI-Real] Starting verification for:', { mediaUrl, hasFrame: !!frameDataUrl, signature });
  const now = Date.now();
  const state =
    verificationState.get(media) ?? {
      lastSignature: '',
      lastCheckedAt: 0,
      inFlight: false
    };

  if (state.inFlight) {
    console.log('[VERI-Real] Verification already in flight');
    return;
  }

  const unchanged = state.lastSignature === signature;
  const tooSoon = now - state.lastCheckedAt < VERIFY_MIN_INTERVAL_MS;
  if (!force && unchanged && tooSoon) {
    return;
  }

  const existingCheckingIdentity = Array.from(verificationByIdentity.entries()).find(
    ([, value]) => value.status === 'checking'
  )?.[0];
  if (existingCheckingIdentity && existingCheckingIdentity !== contentIdentity) {
    return;
  }

  const requestId = nextVerificationRequestId++;
  const pending = normalizeCardResult({
    trustLevel: 'yellow',
    label: 'Checking',
    reason: 'Submitting media signature to AI and blockchain layers...',
    source: 'extension'
  });
  upsertIdentityState(contentIdentity, {
    status: 'checking',
    result: pending,
    startedAt: now,
    requestId,
    lastMediaRef: media
  });
  syncActiveStateFromVisibleMedia(contentIdentity);
  updateAllButtonDisabledStates();
  scheduleReposition();

  state.inFlight = true;
  verificationState.set(media, state);
  inFlightVerifications++;

  try {
    await verifyMedia(media, mediaUrl, frameDataUrl, signature, extracted, contentIdentity, requestId);
    state.lastSignature = signature;
    state.lastCheckedAt = Date.now();
    // Reset recovery attempts on success
    if (extensionContextInvalid) {
      contextRecoveryAttempts = 0;
      extensionContextInvalid = false;
      console.log('[VERI-Real] Extension context recovered successfully');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isExtensionReloadError(msg)) {
      contextRecoveryAttempts++;
      console.warn(`[VERI-Real] Extension context invalid (attempt ${contextRecoveryAttempts}/${MAX_CONTEXT_RECOVERY_ATTEMPTS})`);

      const checkingState = verificationByIdentity.get(contentIdentity);
      if (checkingState && checkingState.requestId === requestId) {
        const reconnectingResult: VerifyResult =
          contextRecoveryAttempts >= MAX_CONTEXT_RECOVERY_ATTEMPTS
            ? {
                trustLevel: 'yellow',
                label: 'Extension Reloaded',
                reason: 'Reload this page to re-attach live verification.',
                source: 'extension-reload'
              }
            : {
                trustLevel: 'yellow',
                label: 'Reconnecting',
                reason: 'Re-establishing extension connection...',
                source: 'extension-recovery'
              };

        upsertIdentityState(contentIdentity, {
          status: 'error',
          result: reconnectingResult,
          startedAt: checkingState.startedAt,
          requestId,
          lastMediaRef: media
        });
        syncActiveStateFromVisibleMedia(contentIdentity);
      }
      
      if (contextRecoveryAttempts >= MAX_CONTEXT_RECOVERY_ATTEMPTS) {
        extensionContextInvalid = true;
      }
      return;
    }

    const checkingState = verificationByIdentity.get(contentIdentity);
    if (checkingState && checkingState.requestId === requestId) {
      upsertIdentityState(contentIdentity, {
        status: 'error',
        result: {
          trustLevel: 'gray',
          label: 'Error',
          reason: 'Verification temporarily unavailable. Please try again.',
          source: 'extension-fallback'
        },
        startedAt: checkingState.startedAt,
        requestId,
        lastMediaRef: media
      });
      syncActiveStateFromVisibleMedia(contentIdentity);
    }
    state.lastCheckedAt = Date.now();
  } finally {
    inFlightVerifications = Math.max(0, inFlightVerifications - 1);
    state.inFlight = false;
    verificationState.set(media, state);
    updateAllButtonDisabledStates();
    scheduleReposition();
  }
}

async function signatureFor(
  media: MediaElement,
  mediaUrl: string,
  frameDataUrl: string | null
): Promise<string> {
  const normalized = mediaUrl ? normalizeUrl(mediaUrl) : 'no-url';
  const size = `${Math.round(media.clientWidth)}x${Math.round(media.clientHeight)}`;
  const videoBucket =
    media instanceof HTMLVideoElement ? `|t${Math.floor(media.currentTime / 15)}` : '';
  const frameBucket = frameDataUrl ? `|f${frameDataUrl.slice(0, 96)}` : '';
  const fingerprint = `${media.tagName.toLowerCase()}|${normalized}|${size}${videoBucket}${frameBucket}`;
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(fingerprint)
  );
  const bytes = new Uint8Array(buffer);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

async function captureFrameDataUrl(media: MediaElement): Promise<string | null> {
  try {
    // Check if we even have permission to read this media
    // If the canvas is "tainted", toDataURL() will throw a SecurityError
    if (media instanceof HTMLImageElement) {
      if (!media.complete) return null;
      return drawToDataUrl(media, media.naturalWidth, media.naturalHeight);
    }
    return drawToDataUrl(media, media.videoWidth, media.videoHeight);
  } catch (err) {
    console.warn('[VERI-Real] SecurityError: Cannot read pixels (CORS).', err);
    return null; // This returns null, which your code handles, but verifyMedia still runs!
  }
}

function drawToDataUrl(source: CanvasImageSource, width: number, height: number): string | null {
//   const canvas = document.createElement('canvas');
//   const maxSide = 512;
//   const scale = Math.min(1, maxSide / Math.max(width, height));
//   canvas.width = Math.max(1, Math.round(width * scale));
//   canvas.height = Math.max(1, Math.round(height * scale));

//   const ctx = canvas.getContext('2d', { willReadFrequently: false });
//   if (!ctx) {
//     return null;
//   }
  const canvas = document.createElement('canvas');
  const maxSide = 512;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true }); // Changed to true for performance
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true; // Ensures AI gets a clear (though smaller) image
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  if (dataUrl.length > MAX_FRAME_DATA_URL_CHARS) {
    return null;
  }
  return dataUrl;
}

async function sendVerifyMessage(message: VerifyMediaMessage): Promise<VerifyResult> {
  // Check if extension context is still valid
  if (!hasChromeRuntimeApi()) {
    throw new Error('Extension context invalidated.');
  }

  console.log('[VERI-Real] Sending verify message:', message);

  // Create a timeout so the badge doesn't stay "Checking" forever
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('Timeout: Background script did not respond')),
      BACKGROUND_RESPONSE_TIMEOUT_MS
    )
  );

  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      timeout
    ]);
    console.log('[VERI-Real] Got response from service worker:', response);
    return response as VerifyResult;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    // Check if this is a context invalidation error
    if (isExtensionReloadError(errorMsg)) {
      console.error('[VERI-Real] Extension context invalidated:', err);
      throw new Error('Extension context invalidated.');
    }
    
    console.error('[VERI-Real] Message Error:', err);
    throw err; 
  }
}

function isTransientChannelError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('message channel closed') ||
    m.includes('receiving end does not exist') ||
    m.includes('could not establish connection')
  );
}

function isExtensionReloadError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('extension context invalidated') ||
    m.includes('could not establish connection') ||
    m.includes('receiving end does not exist') ||
    m.includes('message channel closed')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseYouTubeVideoId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const watchId = parsed.searchParams.get('v');
    if (watchId) {
      return watchId;
    }

    const shortsMatch = parsed.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
  } catch {
    // Ignore malformed URLs.
  }

  return null;
}

function extractMetaContent(selector: string): string | null {
  const el = document.querySelector(selector) as HTMLMetaElement | null;
  const value = el?.content?.trim();
  return value ? value : null;
}

function extractTextContent(selector: string): string | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  const value = el?.textContent?.trim();
  return value ? value : null;
}

function extractYouTubePublishDate(): string | null {
  const fromMeta =
    extractMetaContent('meta[itemprop="datePublished"]') ??
    extractMetaContent('meta[property="video:release_date"]') ??
    extractMetaContent('meta[name="date"]');

  if (fromMeta) {
    return fromMeta;
  }

  const timeEl = document.querySelector('ytd-watch-info-text tp-yt-paper-tooltip, #info-strings yt-formatted-string') as
    | HTMLElement
    | null;
  const text = timeEl?.textContent ?? '';
  const match = text.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function extractYouTubeMetadata(media: HTMLVideoElement): VideoMetadataPayload | null {
  const canonicalUrl = extractYouTubeUrl(media) ?? window.location.href;
  const videoId = parseYouTubeVideoId(canonicalUrl);
  if (!videoId) {
    return null;
  }

  const duration = Number.isFinite(media.duration)
    ? Number(media.duration.toFixed(1))
    : Number(media.currentTime.toFixed(1));

  const channelName =
    extractTextContent('#owner #channel-name a') ??
    extractTextContent('ytd-channel-name a') ??
    extractTextContent('a.yt-simple-endpoint.yt-formatted-string');

  const contentTitle =
    extractTextContent('h1.ytd-watch-metadata yt-formatted-string') ??
    extractTextContent('h1.title yt-formatted-string') ??
    extractMetaContent('meta[name="title"]');

  return {
    url: canonicalUrl,
    video_id: videoId,
    duration_seconds: duration,
    publish_date: extractYouTubePublishDate(),
    channel_name: channelName,
    content_title: contentTitle,
    captured_at: new Date().toISOString()
  };
}

async function sendRuntimeMessage(message: RuntimeMessage): Promise<void> {
  if (!hasChromeRuntimeApi()) {
    return;
  }

  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.warn('[VERI-Real] Failed to send runtime message:', err);
  }
}

async function sendVideoMetadataMessage(payload: VideoMetadataPayload): Promise<void> {
  const message: VideoMetadataMessage = {
    type: 'VIDEO_METADATA',
    payload
  };

  console.log('[VERI-Real] YouTube metadata:', payload);
  await sendRuntimeMessage(message);
}

async function maybeAutoStartCaptureForVideo(media: HTMLVideoElement): Promise<void> {
  if (!extensionEnabled || !autoCaptureOnPlayEnabled) {
    return;
  }

  if (!media.isConnected || media.ended || media.readyState < 1) {
    return;
  }

  const extracted = extractContentData(media);
  if (extracted?.platform !== 'youtube') {
    return;
  }

  const metadata = extractYouTubeMetadata(media);
  if (!metadata) {
    return;
  }

  if (isFrameCaptureAlreadyCompleted(metadata)) {
    console.log('[VERI-Real] Skipping already completed video:', {
      video_id: metadata.video_id,
      duration_seconds: metadata.duration_seconds
    });
    return;
  }

  await sendVideoMetadataMessage(metadata);
  // Kick off the composite chunked capture session (idempotent).
  startChunkedCaptureSession(media, metadata, (status: ChunkCaptureStatus) => {
    console.log('[VERI-Real] Auto-capture status →', status, 'for', metadata.video_id);
  });
}

async function captureVideoFrameBlob(media: HTMLVideoElement): Promise<Blob | null> {
  try {
    const width = media.videoWidth;
    const height = media.videoHeight;
    if (!width || !height) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = FRAME_CAPTURE_SIZE;
    canvas.height = FRAME_CAPTURE_SIZE;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return null;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(media, 0, 0, FRAME_CAPTURE_SIZE, FRAME_CAPTURE_SIZE);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        FRAME_CAPTURE_JPEG_QUALITY
      );
    });
  } catch (err) {
    console.warn('[VERI-Real] Failed to capture frame blob:', err);
    return null;
  }
}

async function captureAudioStream(media: HTMLVideoElement): Promise<MediaStream | null> {
  try {
    console.log('[VERI-Real] Attempting to capture audio stream from video element');
    console.log('[VERI-Real] Video element details:', {
      videoWidth: media.videoWidth,
      videoHeight: media.videoHeight,
      currentTime: media.currentTime,
      duration: media.duration,
      paused: media.paused,
      readyState: media.readyState
    });

    const mediaWithCapture = media as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const stream = mediaWithCapture.captureStream?.() || mediaWithCapture.mozCaptureStream?.();
    console.log('[VERI-Real] captureStream result:', { stream: stream ? 'obtained' : 'null' });

    if (!stream) {
      console.warn('[VERI-Real] captureStream not supported on video element');
      return null;
    }

    const audioTracks = stream.getAudioTracks();
    console.log('[VERI-Real] Audio tracks found:', audioTracks.length);
    
    if (audioTracks.length > 0) {
      audioTracks.forEach((track: MediaStreamTrack, i: number) => {
        console.log(`[VERI-Real] Audio track ${i}:`, {
          kind: track.kind,
          enabled: track.enabled,
          readyState: track.readyState,
          label: track.label
        });
      });
    }

    if (audioTracks.length === 0) {
      console.warn('[VERI-Real] No audio tracks available from video stream');
      return null;
    }

    const audioOnlyStream = new MediaStream(audioTracks);
    console.log('[VERI-Real] Captured audio stream with', audioTracks.length, 'audio track(s)');
    return audioOnlyStream;
  } catch (err) {
    console.warn('[VERI-Real] Failed to capture audio stream:', err);
    return null;
  }
}

async function startAudioRecording(session: FrameCaptureSession): Promise<void> {
  console.log('[VERI-Real] startAudioRecording called for video:', session.metadata.video_id);
  
  if (session.stopped || session.mediaRecorder) {
    console.log('[VERI-Real] Audio recording already active or session stopped');
    return;
  }

  console.log('[VERI-Real] Calling captureAudioStream...');
  const audioStream = await captureAudioStream(session.media);
  if (!audioStream) {
    console.log('[VERI-Real] Skipping audio capture: no audio stream available');
    return;
  }

  session.audioStream = audioStream;
  session.audioChunks = [];

  try {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

    const mediaRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});
    session.audioMimeType = mediaRecorder.mimeType || mimeType || 'audio/webm';

    mediaRecorder.ondataavailable = (event) => {
      console.log('[VERI-Real] Audio data available:', {
        size: event.data.size,
        type: event.data.type
      });
      if (event.data.size > 0) {
        session.audioChunks.push(event.data);
        session.pendingAudioChunks.push(event.data);
      }
    };

    mediaRecorder.onerror = (event) => {
      console.warn('[VERI-Real] MediaRecorder error:', event.error);
    };

    mediaRecorder.onstop = () => {
      console.log('[VERI-Real] MediaRecorder stopped for video:', session.metadata.video_id);

      const chunkCount = session.audioChunks.length;
      const totalSize = session.audioChunks.reduce((sum, blob) => sum + blob.size, 0);
      console.log('[VERI-Real] Checking audio chunks after stop:', {
        chunk_count: chunkCount,
        total_size: totalSize
      });

      if (chunkCount > 0) {
        const audioBlob = new Blob(session.audioChunks, {
          type: mediaRecorder.mimeType || 'audio/webm'
        });

        const safeVideoId = session.metadata.video_id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `veri-real-audio-${safeVideoId}-${Date.now()}.webm`;
        const objectUrl = URL.createObjectURL(audioBlob);
        const downloadLink = document.createElement('a');
        downloadLink.href = objectUrl;
        downloadLink.download = fileName;
        downloadLink.rel = 'noopener';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

        console.log('[VERI-Real] Audio recording completed:', {
          video_id: session.metadata.video_id,
          audio_size_bytes: audioBlob.size,
          chunk_count: chunkCount,
          mime_type: audioBlob.type,
          downloaded_as: fileName
        });
      } else {
        console.warn('[VERI-Real] No audio chunks captured');
      }

      if (session.audioStream) {
        session.audioStream.getTracks().forEach((track) => {
          console.log('[VERI-Real] Stopping audio track:', { kind: track.kind, readyState: track.readyState });
          track.stop();
        });
        session.audioStream = null;
      }
    };

    mediaRecorder.start(AUDIO_RECORD_DURATION_MS);
    session.mediaRecorder = mediaRecorder;

    console.log('[VERI-Real] Started audio recording:', {
      video_id: session.metadata.video_id,
      mime_type: mediaRecorder.mimeType || 'default',
      chunk_interval_ms: AUDIO_RECORD_DURATION_MS
    });

  } catch (err) {
    console.warn('[VERI-Real] Failed to start audio recording:', err);
    // Clean up stream if recording failed
    audioStream.getTracks().forEach((track) => track.stop());
  }
}

function stopAudioRecording(session: FrameCaptureSession): void {
  console.log('[VERI-Real] stopAudioRecording called');
  if (!session.mediaRecorder) {
    console.log('[VERI-Real] No MediaRecorder to stop');
    return;
  }

  const mediaRecorder = session.mediaRecorder;
  session.mediaRecorder = null;

  console.log('[VERI-Real] MediaRecorder state before stop:', mediaRecorder.state);
  if (mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function clearFrameCaptureTimers(session: FrameCaptureSession): void {
  if (session.captureTimerId !== null) {
    window.clearInterval(session.captureTimerId);
    session.captureTimerId = null;
  }
  if (session.flushTimerId !== null) {
    window.clearInterval(session.flushTimerId);
    session.flushTimerId = null;
  }
}

function getPreferredWebmMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return 'video/webm';
}

function sanitizeFileNameSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function stitchFramesToWebm(
  frames: CapturedFrame[],
  fps: number
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (frames.length === 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_CAPTURE_SIZE;
  canvas.height = FRAME_CAPTURE_SIZE;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  const stream = canvas.captureStream(fps);
  const mimeType = getPreferredWebmMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();

  const frameDurationMs = Math.max(1, Math.round(1000 / fps));
  let previousFrameTime = performance.now();

  for (const frame of frames) {
    const bitmap = await createImageBitmap(frame.blob);
    try {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }

    const now = performance.now();
    const elapsed = now - previousFrameTime;
    const remaining = Math.max(0, frameDurationMs - elapsed);
    previousFrameTime = now + remaining;
    if (remaining > 0) {
      await sleep(remaining);
    }
  }

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());

  const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
  if (blob.size === 0) {
    return null;
  }

  return {
    blob,
    mimeType: blob.type || recorder.mimeType || mimeType || 'video/webm'
  };
}

function downloadBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const downloadLink = document.createElement('a');
  downloadLink.href = objectUrl;
  downloadLink.download = fileName;
  downloadLink.rel = 'noopener';
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function maybeDownloadFrameBatchPreviewVideo(
  session: FrameCaptureSession,
  frames: CapturedFrame[],
  flushMode: 'interval' | 'forced'
): Promise<void> {
  if (!FRAME_BATCH_PREVIEW_VIDEO_ENABLED) {
    return;
  }

  if (flushMode !== 'interval' || frames.length !== FRAME_BATCH_SIZE) {
    return;
  }

  try {
    const stitched = await stitchFramesToWebm(frames, FRAME_BATCH_PREVIEW_FPS);
    if (!stitched) {
      return;
    }

    const safeVideoId = sanitizeFileNameSegment(session.metadata.video_id);
    const fileName = `veri-real-frames-${safeVideoId}-seq-${frames[0].sequence_id}-${frames[frames.length - 1].sequence_id}.webm`;
    downloadBlob(stitched.blob, fileName);

    console.log('[VERI-Real] Downloaded stitched frame batch preview video:', {
      video_id: session.metadata.video_id,
      frame_count: frames.length,
      sequence_range: [frames[0].sequence_id, frames[frames.length - 1].sequence_id],
      mime_type: stitched.mimeType,
      size_bytes: stitched.blob.size,
      file_name: fileName
    });
  } catch (err) {
    console.warn('[VERI-Real] Failed to stitch and download frame batch preview video:', err);
  }
}

async function flushCapturedFrames(
  session: FrameCaptureSession,
  options?: { force?: boolean }
): Promise<void> {
  if (activeFrameCaptureSession !== session || session.stopped) {
    return;
  }

  const force = options?.force === true;

  if (session.pendingFrames.length === 0 && session.pendingAudioChunks.length === 0) {
    return;
  }

  if (!force && session.pendingFrames.length > 0 && session.pendingFrames.length < FRAME_BATCH_SIZE) {
    return;
  }

  const framesToSendCount = force
    ? session.pendingFrames.length
    : Math.min(FRAME_BATCH_SIZE, session.pendingFrames.length);
  const audioToSendCount = force
    ? session.pendingAudioChunks.length
    : session.pendingAudioChunks.length;

  const frames = session.pendingFrames.splice(0, framesToSendCount);
  const audioChunks = session.pendingAudioChunks.splice(0, audioToSendCount);
  const flushMode: 'interval' | 'forced' = force ? 'forced' : 'interval';

  await maybeDownloadFrameBatchPreviewVideo(session, frames, flushMode);

  const message: VideoFramesBatchMessage = {
    type: 'VIDEO_FRAMES_BATCH',
    payload: {
      url: session.metadata.url,
      video_id: session.metadata.video_id,
      page_url: window.location.href,
      sent_at: new Date().toISOString(),
      frames,
      audio_chunks: audioChunks,
      audio_mime_type: session.audioMimeType || 'audio/webm'
    }
  };

  console.log('[VERI-Real] Sending frame batch:', {
    video_id: session.metadata.video_id,
    frame_count: frames.length,
    frame_batch_size_target: FRAME_BATCH_SIZE,
    flush_mode: flushMode,
    audio_chunk_count: audioChunks.length,
    sequence_range: [frames[0]?.sequence_id, frames[frames.length - 1]?.sequence_id],
    frame_sizes: frames.map((frame) => frame.size_bytes),
    audio_sizes: audioChunks.map((chunk) => chunk.size)
  });

  await sendRuntimeMessage(message);
}

function stopFrameCaptureSession(reason: string): void {
  const session = activeFrameCaptureSession;
  if (!session) {
    return;
  }

  // Stop audio recording if active
  stopAudioRecording(session);

  session.stopped = true;
  clearFrameCaptureTimers(session);
  console.log('[VERI-Real] Stopped frame capture session:', {
    reason,
    video_id: session.metadata.video_id,
    captured_total: session.capturedFrames.length
  });
  activeFrameCaptureSession = null;
}

async function finalizeFrameCaptureSession(session: FrameCaptureSession, reason: string): Promise<void> {
  await flushCapturedFrames(session, { force: true });
  markFrameCaptureCompleted(session.metadata);
  stopFrameCaptureSession(reason);
}

async function captureFrameTick(session: FrameCaptureSession): Promise<void> {
  if (activeFrameCaptureSession !== session || session.stopped || session.inFlight) {
    return;
  }

  session.inFlight = true;

  try {
    const media = session.media;
    if (!media.isConnected) {
      stopFrameCaptureSession('media-disconnected');
      return;
    }

    const currentVideoId = parseYouTubeVideoId(window.location.href);
    if (currentVideoId && currentVideoId !== session.metadata.video_id) {
      await flushCapturedFrames(session, { force: true });
      stopFrameCaptureSession('video-changed');
      return;
    }

    if (media.ended) {
      await finalizeFrameCaptureSession(session, 'video-ended');
      return;
    }

    if (media.paused || media.readyState < 2 || media.currentTime < 1) {
      return;
    }

    if (isNearMediaEnd(media)) {
      const remainingMs = getRemainingDurationMs(media);
      if (remainingMs !== null && remainingMs > 0) {
        await sleep(remainingMs);
      }

      if (activeFrameCaptureSession !== session || session.stopped) {
        return;
      }

      if (!media.isConnected) {
        stopFrameCaptureSession('media-disconnected');
        return;
      }

      const finalBlob = await captureVideoFrameBlob(media);
      if (finalBlob) {
        const finalFrame: CapturedFrame = {
          sequence_id: ++session.sequence,
          timestamp_seconds: Number(media.currentTime.toFixed(3)),
          captured_at: new Date().toISOString(),
          mime_type: finalBlob.type || 'image/jpeg',
          size_bytes: finalBlob.size,
          blob: finalBlob
        };

        session.capturedFrames.push(finalFrame);
        session.pendingFrames.push(finalFrame);

        console.log('[VERI-Real] Captured final frame near video end:', {
          video_id: session.metadata.video_id,
          sequence_id: finalFrame.sequence_id,
          timestamp: finalFrame.timestamp_seconds,
          size_bytes: finalFrame.size_bytes
        });
      }

      await finalizeFrameCaptureSession(session, 'video-ended');
      return;
    }

    const blob = await captureVideoFrameBlob(media);
    if (!blob) {
      return;
    }

    const frame: CapturedFrame = {
      sequence_id: ++session.sequence,
      timestamp_seconds: Number(media.currentTime.toFixed(3)),
      captured_at: new Date().toISOString(),
      mime_type: blob.type || 'image/jpeg',
      size_bytes: blob.size,
      blob
    };

    session.capturedFrames.push(frame);
    session.pendingFrames.push(frame);

    console.log('[VERI-Real] Captured frame:', {
      video_id: session.metadata.video_id,
      sequence_id: frame.sequence_id,
      timestamp: frame.timestamp_seconds,
      size_bytes: frame.size_bytes
    });
  } finally {
    session.inFlight = false;
  }
}

function startFrameCaptureSession(media: HTMLVideoElement, metadata: VideoMetadataPayload): void {
  if (isFrameCaptureAlreadyCompleted(metadata)) {
    console.log('[VERI-Real] Not starting capture for completed video:', {
      video_id: metadata.video_id,
      duration_seconds: metadata.duration_seconds
    });
    return;
  }

  const sessionKey = `${metadata.video_id}|${window.location.href}`;
  if (activeFrameCaptureSession?.sessionKey === sessionKey && !activeFrameCaptureSession.stopped) {
    return;
  }

  stopFrameCaptureSession('start-new-session');

  const session: FrameCaptureSession = {
    sessionKey,
    media,
    metadata,
    sequence: 0,
    capturedFrames: [],
    pendingFrames: [],
    pendingAudioChunks: [],
    captureTimerId: null,
    flushTimerId: null,
    inFlight: false,
    stopped: false,
    mediaRecorder: null,
    audioChunks: [],
    audioStream: null,
    audioMimeType: 'audio/webm'
  };

  activeFrameCaptureSession = session;
  session.captureTimerId = window.setInterval(() => {
    void captureFrameTick(session);
  }, FRAME_CAPTURE_INTERVAL_MS);
  session.flushTimerId = window.setInterval(() => {
    void flushCapturedFrames(session);
  }, FRAME_FLUSH_INTERVAL_MS);

  void captureFrameTick(session);
  void startAudioRecording(session);

  console.log('[VERI-Real] Started frame capture session:', {
    video_id: metadata.video_id,
    url: metadata.url,
    capture_every_ms: FRAME_CAPTURE_INTERVAL_MS,
    flush_every_ms: FRAME_FLUSH_INTERVAL_MS
  });
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw, window.location.href);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function isSupportedAiVideoPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return (
      host === 'x.com' ||
      host === 'www.x.com' ||
      host === 'twitter.com' ||
      host === 'www.twitter.com' ||
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be'
    );
  } catch {
    return false;
  }
}

function extractContentData(
  media: MediaElement
): { url: string; platform: 'youtube' | 'twitter' } | null {
  const host = window.location.hostname.toLowerCase();

  if (host.includes('youtube.com') || host === 'youtu.be') {
    const youtubeUrl = extractYouTubeUrl(media);
    if (!youtubeUrl) {
      return null;
    }
    return { url: youtubeUrl, platform: 'youtube' };
  }

  if (host.includes('x.com') || host.includes('twitter.com')) {
    const twitterUrl = extractTwitterUrl(media);
    if (!twitterUrl) {
      return null;
    }
    return { url: twitterUrl, platform: 'twitter' };
  }

  return null;
}

function extractYouTubeUrl(media: MediaElement): string | null {
  const candidates: Array<string | null | undefined> = [];

  // Search for YouTube video/shorts links in the parent hierarchy
  const pointerAnchor = lastPointerTarget?.closest?.('a[href*="/watch?v="], a[href*="/shorts/"]') as
    | HTMLAnchorElement
    | null;
  const mediaAnchor = media.closest('a[href*="/watch?v="], a[href*="/shorts/"]') as HTMLAnchorElement | null;

  // Try to find actual video links in the parent chain (not image links)
  if (pointerAnchor?.getAttribute('href')?.includes('/watch?v=') || pointerAnchor?.getAttribute('href')?.includes('/shorts/')) {
    candidates.push(pointerAnchor?.getAttribute('href'));
  }
  if (mediaAnchor?.getAttribute('href')?.includes('/watch?v=') || mediaAnchor?.getAttribute('href')?.includes('/shorts/')) {
    candidates.push(mediaAnchor?.getAttribute('href'));
  }

  // Try to find video links in nearby parent containers (for embedded/feed videos)
  let parent = media.parentElement;
  let depth = 0;
  while (parent && depth < 5) {
    const videoLink = parent.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') as HTMLAnchorElement | null;
    if (videoLink?.getAttribute('href')?.includes('/watch?v=') || videoLink?.getAttribute('href')?.includes('/shorts/')) {
      candidates.push(videoLink.getAttribute('href'));
      break;
    }
    parent = parent.parentElement;
    depth++;
  }

  candidates.push(window.location.href);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed = new URL(candidate, window.location.origin);
      const videoId = parsed.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }

      // Try to extract from /shorts/ URL
      const shortsMatch = parsed.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
      if (shortsMatch) {
        return `https://www.youtube.com/shorts/${shortsMatch[1]}`;
      }

      // Try to extract video ID from other YouTube URL formats
      const watchMatch = parsed.pathname.match(/\/watch\?v=([A-Za-z0-9_-]+)/);
      if (watchMatch) {
        return `https://www.youtube.com/watch?v=${watchMatch[1]}`;
      }
    } catch {
      // Ignore malformed URLs and continue to next candidate.
    }
  }

  return null;
}

function extractTwitterUrl(media: MediaElement): string | null {
  const pointerArticle = lastPointerTarget?.closest?.('article') as HTMLElement | null;
  const mediaArticle = media.closest('article') as HTMLElement | null;
  const article = pointerArticle ?? mediaArticle;
  if (!article) {
    return null;
  }

  const anchors = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href) {
      continue;
    }

    try {
      const parsed = new URL(href, window.location.origin);
      const match = parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!match) {
        continue;
      }
      return `${window.location.origin}/${match[1]}/status/${match[2]}`;
    } catch {
      // Ignore malformed href values.
    }
  }

  return null;
}

function handlePointerMove(event: MouseEvent): void {
  lastPointerTarget = event.target instanceof Element ? event.target : null;
}

function getCheckButtonContainer(media: MediaElement): HTMLElement {
  if (window.location.pathname.startsWith('/shorts/')) {
    const shortsContainer = media.closest(
      'ytd-reel-video-renderer, ytd-reel-item-renderer, ytd-shorts, ytd-watch-flexy'
    ) as HTMLElement | null;
    if (shortsContainer) {
      return shortsContainer;
    }
  }

  const preferred = media.closest(
    'article, ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer, a#thumbnail'
  ) as HTMLElement | null;

  return preferred ?? media.parentElement ?? media;
}

function isHoverPreviewMedia(media: HTMLVideoElement): boolean {
  return Boolean(
    media.closest(
      'ytd-moving-thumbnail-renderer, ytd-video-preview, ytd-rich-grid-media #hover-overlays, #mouseover-overlay, #hover-overlays'
    )
  );
}

function isSelectedPlayingVideo(media: HTMLVideoElement): boolean {
  if (media.paused || media.ended || media.readyState < 2) {
    return false;
  }

  if (isHoverPreviewMedia(media)) {
    return false;
  }

  // On YouTube, only attach to the main selected player/reel, not grid thumbnails.
  if (window.location.hostname.includes('youtube.com')) {
    const selectedPlayer = media.closest(
      '#movie_player, ytd-player, ytd-watch-flexy, ytd-reel-video-renderer, ytd-reel-item-renderer, ytd-shorts'
    );
    if (!selectedPlayer) {
      return false;
    }
  }

  return true;
}

function applyCheckButtonPlacement(
  _media: MediaElement,
  button: HTMLButtonElement,
  _container: HTMLElement
): void {
  button.classList.remove('is-home-thumbnail-left', 'is-shorts-action-stack');

  button.style.left = '';
  button.style.right = '8px';
  button.style.bottom = '';

  // YouTube videos: position at top-right corner, fully visible
  if (window.location.hostname.includes('youtube.com')) {
    button.style.top = '8px';
    button.style.transform = '';
  } else {
    // Other platforms: position at right-middle
    button.style.top = '50%';
    button.style.transform = 'translateY(-50%)';
  }
}

function findMappedButtonInContainer(
  container: HTMLElement
): { media: MediaElement; button: HTMLButtonElement } | null {
  for (const [mappedMedia, mappedButton] of checkButtonsByMedia.entries()) {
    if (!mappedButton.isConnected) {
      continue;
    }

    if (mappedButton.parentElement === container) {
      return { media: mappedMedia, button: mappedButton };
    }
  }

  return null;
}

function ensureCheckButton(media: MediaElement): HTMLButtonElement {
  const container = getCheckButtonContainer(media);
  const existing = checkButtonsByMedia.get(media);
  if (existing) {
    if (existing.parentElement !== container) {
      if (window.getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
      container.appendChild(existing);
    }
    applyCheckButtonPlacement(media, existing, container);
    return existing;
  }

  const existingInContainer = findMappedButtonInContainer(container);
  if (existingInContainer) {
    if (existingInContainer.media !== media) {
      checkButtonsByMedia.delete(existingInContainer.media);
      checkButtonsByMedia.set(media, existingInContainer.button);
    }
    applyCheckButtonPlacement(media, existingInContainer.button, container);
    return existingInContainer.button;
  }

  const iconUrl = hasChromeRuntimeApi()
    ? chrome.runtime.getURL('icons/icon6.png')
    : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const btn = document.createElement('button');
  btn.className = CLASS_CHECK_BUTTON;
  btn.type = 'button';
  btn.innerHTML = `<img src="${iconUrl}" alt="VERI-Real check" />`;
  btn.title = 'Check Deepfake';
  btn.style.display = 'none';
  btn.addEventListener('click', () => {
    const checkingIdentity = getCheckingIdentity();
    if (!extensionEnabled || !media.isConnected || checkingIdentity !== null) {
      return;
    }

    hoveredMedia = media;
    syncActiveStateFromVisibleMedia(getMediaContentIdentity(media));
    updateAllButtonDisabledStates();
    scheduleReposition();
    void maybeVerifyMedia(media, true).finally(() => {
      updateAllButtonDisabledStates();
      updateUiVisibility();
      scheduleReposition();
    });
  });

  btn.addEventListener('mouseenter', () => {
    const contentIdentity = getMediaContentIdentity(media);
    const identityState = verificationByIdentity.get(contentIdentity);
    
    if (!identityState || !statusTooltipEl) {
      return;
    }

    const result = identityState.result;
    const normalized = normalizeCardResult(result);
    const deepfakeText = normalized.isDeepfake === true ? 'True' : normalized.isDeepfake === false ? 'False' : 'Unknown';
    const confidenceText = formatConfidence(normalized.confidence);
    
    statusTooltipEl.innerHTML = [
      `<div class="veri-real-tooltip-title">Deepfake: ${escapeHtml(deepfakeText)}</div>`,
      `<div class="veri-real-tooltip-sub">${escapeHtml(confidenceText)}</div>`
    ].join('');
    statusTooltipEl.dataset.trustLevel = normalized.trustLevel;
    statusTooltipEl.style.display = 'block';
    positionStatusTooltip(media, statusTooltipEl);
  });

  btn.addEventListener('mouseleave', () => {
    if (statusTooltipEl) {
      statusTooltipEl.style.display = 'none';
    }
  });

  container.appendChild(btn);
  applyCheckButtonPlacement(media, btn, container);
  checkButtonsByMedia.set(media, btn);
  return btn;
}

function updateAllButtonDisabledStates(): void {
  const checkingIdentity = getCheckingIdentity();

  for (const [media, button] of checkButtonsByMedia.entries()) {
    if (!media.isConnected || !button.isConnected) {
      checkButtonsByMedia.delete(media);
      continue;
    }

    const mediaIdentity = getMediaContentIdentity(media);
    const shouldDisable = Boolean(checkingIdentity && mediaIdentity !== checkingIdentity);
    button.disabled = shouldDisable;
    button.classList.toggle('is-disabled', shouldDisable);
    button.classList.toggle(
      CLASS_CHECK_BUTTON_CHECKING_ACTIVE,
      Boolean(checkingIdentity && mediaIdentity === checkingIdentity)
    );
  }
}

function collectVerifiableMedia(): MediaElement[] {
  const all = document.querySelectorAll('video');
  const mediaByContainer = new Map<HTMLElement, MediaElement>();

  for (const node of all) {
    if (!(node instanceof HTMLVideoElement)) {
      continue;
    }

    if (!isCandidate(node) || !isSelectedPlayingVideo(node) || !extractContentData(node)) {
      continue;
    }

    const container = getCheckButtonContainer(node);
    if (!mediaByContainer.has(container)) {
      mediaByContainer.set(container, node);
    }
  }

  return Array.from(mediaByContainer.values());
}

function syncCheckButtons(): void {
  const verifiable = collectVerifiableMedia();
  const verifiableSet = new Set(verifiable);
  for (const media of verifiable) {
    ensureCheckButton(media);
  }

  for (const [media, button] of checkButtonsByMedia.entries()) {
    if (
      !media.isConnected ||
      !button.isConnected ||
      !extractContentData(media) ||
      !verifiableSet.has(media)
    ) {
      button.remove();
      checkButtonsByMedia.delete(media);
    }
  }

  updateAllButtonDisabledStates();
}
function overlayRoot(): HTMLDivElement {
  let root = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483646';
    document.documentElement.appendChild(root);
  }
  return root;
}

function ensureUiElements(): void {
  const root = overlayRoot();

  if (!statusDotEl) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `${CLASS_BADGE} ${CLASS_STATUS_DOT}`;
    dot.style.display = 'none';
    dot.innerHTML = `<span class="veri-real-status-dot-core"></span>`;
    dot.addEventListener('mouseenter', () => {
      if (!statusTooltipEl || !activeResult || !activeMedia) {
        return;
      }
      const normalized = normalizeCardResult(activeResult);
      const statusText = normalized.isDeepfake === true ? 'Deepfake' : normalized.isDeepfake === false ? 'Natural' : normalized.label;
      const confidenceText = formatConfidence(normalized.confidence);
      statusTooltipEl.innerHTML = [
        `<div class="veri-real-tooltip-title">${escapeHtml(statusText)}</div>`,
        `<div class="veri-real-tooltip-sub">${escapeHtml(confidenceText)}</div>`
      ].join('');
      statusTooltipEl.style.display = 'block';
      positionStatusTooltip(activeMedia, statusTooltipEl);
    });
    dot.addEventListener('mouseleave', () => {
      if (statusTooltipEl) {
        statusTooltipEl.style.display = 'none';
      }
    });
    root.appendChild(dot);
    statusDotEl = dot;
  }

  if (!statusTooltipEl) {
    const tooltip = document.createElement('div');
    tooltip.className = CLASS_STATUS_TOOLTIP;
    tooltip.style.display = 'none';
    root.appendChild(tooltip);
    statusTooltipEl = tooltip;
  }
}

function showCheckButton(media: MediaElement): void {
  const button = ensureCheckButton(media);
  if (!button || !media.isConnected || !isOnScreen(media)) {
    return;
  }

  button.style.display = 'flex';
}

function hideAllCheckButtons(): void {
  for (const [media, button] of checkButtonsByMedia.entries()) {
    if (!media.isConnected || !button.isConnected) {
      checkButtonsByMedia.delete(media);
      continue;
    }
    button.style.display = 'none';
  }
}

function hideStatusDot(): void {
  if (statusDotEl) {
    statusDotEl.style.display = 'none';
  }
  if (statusTooltipEl) {
    statusTooltipEl.style.display = 'none';
  }
}

function renderBadge(
  media: MediaElement,
  result: VerifyResult,
  showCard = false,
  expectedContentIdentity?: string
): void {
  ensureUiElements();
  if (!statusDotEl) {
    return;
  }

  const currentContentIdentity = getMediaContentIdentity(media);
  if (expectedContentIdentity && currentContentIdentity !== expectedContentIdentity) {
    return;
  }

  const normalized = normalizeCardResult(result);
  const isChecking = normalized.label.toLowerCase().includes('checking');
  statusDotEl.dataset.trustLevel = normalized.trustLevel;
  statusDotEl.title = isChecking ? 'Checking in progress' : 'Hover for result details';

  // Apply trust level to the check button so its circle changes color
  const button = checkButtonsByMedia.get(media);
  if (button) {
    button.dataset.trustLevel = normalized.trustLevel;
    
    if (isChecking) {
      button.classList.add('is-checking-active');
      button.classList.remove('is-result-ready');
    } else {
      button.classList.remove('is-checking-active');
      button.classList.add('is-result-ready');
    }
  }

  // Keep status dot hidden - we show color only via button circle
  statusDotEl.style.display = 'none';
}

function normalizeCardResult(result: VerifyResult): VerifyResult {
  if (result.isDeepfake === true) {
    return {
      ...result,
      trustLevel: 'red',
      label: 'Deepfake',
      reason: result.reason || 'Deepfake detected'
    };
  }

  if (result.isDeepfake === false) {
    return {
      ...result,
      trustLevel: 'green',
      label: 'Natural',
      reason: result.reason || 'Content appears natural'
    };
  }

  if (result.label.toLowerCase().includes('checking')) {
    return {
      ...result,
      trustLevel: 'yellow',
      label: 'Checking',
      reason: 'Verification in progress...'
    };
  }

  return result;
}

function mediaIntersectsViewport(media: MediaElement): boolean {
  const rect = media.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function positionStatusDot(media: MediaElement, dot: HTMLButtonElement): void {
  if (!media.isConnected) {
    dot.style.display = 'none';
    return;
  }

  const rect = media.getBoundingClientRect();
  
  // Calculate position, clamping to viewport to keep dot visible
  let left = rect.right - 40;
  let top = rect.top + 8;
  
  // Clamp to viewport bounds
  left = Math.max(Math.min(left, window.innerWidth - 40), 4);
  top = Math.max(Math.min(top, window.innerHeight - 40), 4);

  dot.style.display = 'block';
  dot.style.left = `${left}px`;
  dot.style.top = `${top}px`;
}

function positionStatusTooltip(media: MediaElement, tooltip: HTMLDivElement): void {
  if (!media.isConnected) {
    tooltip.style.display = 'none';
    return;
  }

  const rect = media.getBoundingClientRect();
  const tooltipWidth = 170;
  let left = rect.right - tooltipWidth - 8;
  let top = rect.top + 44;
  
  // Clamp to viewport bounds
  left = Math.max(Math.min(left, window.innerWidth - tooltipWidth - 4), 4);
  top = Math.max(Math.min(top, window.innerHeight - 100), 4);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function clearAllBadges(): void {
  stopFrameCaptureSession('clear-ui');

  const root = document.getElementById(OVERLAY_ID);
  if (root) {
    root.remove();
  }
  for (const button of checkButtonsByMedia.values()) {
    button.remove();
  }
  checkButtonsByMedia.clear();
  statusDotEl = null;
  statusTooltipEl = null;
  verificationByIdentity.clear();
  activeMedia = null;
  activeResult = null;
  isCheckingActive = false;
  activeMediaContentIdentity = null;
}

let rafId: number | null = null;
function scheduleReposition(): void {
  if (rafId !== null) {
    return;
  }

  rafId = window.requestAnimationFrame(() => {
    rafId = null;

    pruneVerificationState();
    syncActiveStateFromVisibleMedia();

    if (activeMedia && activeResult && statusDotEl && extensionEnabled && isMediaVisible(activeMedia)) {
      renderBadge(activeMedia, activeResult, true, activeMediaContentIdentity ?? undefined);
      if (statusTooltipEl?.style.display === 'block') {
        positionStatusTooltip(activeMedia, statusTooltipEl);
      }
    } else if (statusDotEl) {
      statusDotEl.style.display = 'none';
      if (statusTooltipEl) {
        statusTooltipEl.style.display = 'none';
      }
    }

    if (extensionEnabled) {
      updateUiVisibility();
    }
  });
}

function injectStyles(): void {
  if (document.getElementById('veri-real-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'veri-real-style';
  style.textContent = `
    .veri-real-check-button {
      position: absolute;
      display: none;
      pointer-events: auto;
      border: 0;
      border-radius: 50%;
      width: 42px;
      height: 42px;
      right: 8px;
      top: 8px;
      padding: 0;
      background: transparent;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
      align-items: center;
      justify-content: center;
      overflow: visible;
      z-index: 2147483645;
    }

    .veri-real-check-button.is-disabled {
      opacity: 0.45;
      cursor: not-allowed;
      filter: grayscale(0.5);
    }

    .veri-real-check-button img {
      width: 44px;
      height: 44px;
      object-fit: contain;
      pointer-events: none;
    }

    .veri-real-check-button.is-checking-active {
      cursor: progress;
    }

    .veri-real-check-button.is-checking-active::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid transparent;
      background: conic-gradient(from 0deg, #a8762b 0deg, #ea8d28 180deg, #ceae7b 360deg);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
      animation: veri-real-spin 0.9s linear infinite;
      pointer-events: none;
    }

    .veri-real-check-button.is-result-ready::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid;
      background: transparent;
      pointer-events: none;
      animation: none;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="green"]::after {
      border-color: #16a34a;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="red"]::after {
      border-color: #dc2626;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="yellow"]::after {
      border-color: #f59e0b;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="gray"]::after {
      border-color: #64748b;
    }

    .veri-real-status-dot {
      position: fixed;
      display: none;
      pointer-events: auto;
      width: 30px;
      height: 30px;
      border: 2px solid #cbd5e1;
      border-radius: 50%;
      padding: 3px;
      background: transparent;
      cursor: default;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
    }

    .veri-real-status-dot-core {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: transparent;
    }

    .veri-real-status-dot[data-trust-level="green"] {
      border-color: #16a34a;
    }

    .veri-real-status-dot[data-trust-level="red"] {
      border-color: #dc2626;
    }

    .veri-real-status-dot[data-trust-level="yellow"] {
      border-color: #f59e0b;
    }

    .veri-real-status-dot[data-trust-level="gray"] {
      border-color: #64748b;
    }

    .veri-real-status-tooltip {
      position: fixed;
      display: none;
      min-width: 128px;
      max-width: 170px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.96);
      color: #f8fafc;
      padding: 8px 10px;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      line-height: 1.2;
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
      pointer-events: none;
      z-index: 2147483647;
    }

    .veri-real-tooltip-title {
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 2px;
    }

    .veri-real-status-tooltip[data-trust-level="green"] .veri-real-tooltip-title {
      color: #16a34a;
    }

    .veri-real-status-tooltip[data-trust-level="red"] .veri-real-tooltip-title {
      color: #dc2626;
    }

    .veri-real-status-tooltip[data-trust-level="yellow"] .veri-real-tooltip-title {
      color: #f59e0b;
    }

    .veri-real-status-tooltip[data-trust-level="gray"] .veri-real-tooltip-title {
      color: #64748b;
    }

    .veri-real-tooltip-sub {
      font-size: 11px;
      opacity: 0.92;
    }

    @keyframes veri-real-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function showStatusDot(media: MediaElement): void {
  ensureUiElements();
  if (!statusDotEl || !activeResult) {
    return;
  }

  renderBadge(media, activeResult, true, activeMediaContentIdentity ?? undefined);
}

function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return 'Confidence: N/A';
  }

  const normalized = confidence > 1 ? confidence : confidence * 100;
  const bounded = Math.max(0, Math.min(100, normalized));
  return `Confidence: ${bounded.toFixed(1)}%`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
