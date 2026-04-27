import type {
  DeepfakeCacheEntry,
  RuntimeMessage,
  VerifyMediaMessage,
  VerifyResult,
  VideoMetadataPayload
} from '../shared/types';

const ORCHESTRATOR_BASE =
  import.meta.env.VITE_ORCHESTRATOR_BASE ?? 'http://localhost:3000';
const RESULT_TTL_MS = 30000;
const BACKEND_VERIFY_TIMEOUT_MS = 125000;
const DEEPFAKE_CACHE_STORAGE_KEY = 'veri-deepfake-cache';
const DEEPFAKE_CACHE_MAX_ITEMS = 5;

const recentResults = new Map<
  string,
  {
    value: VerifyResult;
    at: number;
  }
>();

/**
 * Manages persistent Chrome storage cache for the last N deepfake verification results
 */
class DeepfakeCache {
  private entries: Map<string, DeepfakeCacheEntry> = new Map();
  private initialized: Promise<void>;

  constructor() {
    this.initialized = this.loadFromStorage();
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const data = await chrome.storage.local.get(DEEPFAKE_CACHE_STORAGE_KEY);
      if (data[DEEPFAKE_CACHE_STORAGE_KEY]) {
        const items = data[DEEPFAKE_CACHE_STORAGE_KEY] as DeepfakeCacheEntry[];
        items.forEach((entry) => {
          this.entries.set(entry.signature, entry);
        });
        console.log('[VERI-Real] Loaded cache with', this.entries.size, 'entries');
      }
    } catch (err) {
      console.warn('[VERI-Real] Failed to load cache from storage:', err);
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      const items = Array.from(this.entries.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, DEEPFAKE_CACHE_MAX_ITEMS);
      await chrome.storage.local.set({
        [DEEPFAKE_CACHE_STORAGE_KEY]: items
      });
      console.log('[VERI-Real] Saved cache with', items.length, 'entries');
    } catch (err) {
      console.warn('[VERI-Real] Failed to save cache to storage:', err);
    }
  }

  async ensureInitialized(): Promise<void> {
    await this.initialized;
  }

  get(signature: string): DeepfakeCacheEntry | undefined {
    return this.entries.get(signature);
  }

  async set(signature: string, entry: DeepfakeCacheEntry): Promise<void> {
    this.entries.set(signature, entry);
    // Auto-prune to keep only max items
    if (this.entries.size > DEEPFAKE_CACHE_MAX_ITEMS) {
      const sorted = Array.from(this.entries.values())
        .sort((a, b) => b.timestamp - a.timestamp);
      this.entries.clear();
      sorted.slice(0, DEEPFAKE_CACHE_MAX_ITEMS).forEach((entry) => {
        this.entries.set(entry.signature, entry);
      });
    }
    await this.saveToStorage();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    try {
      await chrome.storage.local.remove(DEEPFAKE_CACHE_STORAGE_KEY);
    } catch (err) {
      console.warn('[VERI-Real] Failed to clear cache:', err);
    }
  }
}

const deepfakeCache = new DeepfakeCache();

type IconTrust = 'green' | 'yellow' | 'red' | 'gray' | 'unknown';
const tabTrust = new Map<number, IconTrust>();

chrome.runtime.onInstalled.addListener(async () => {
  const { veriRealEnabled } = await chrome.storage.sync.get('veriRealEnabled');
  if (typeof veriRealEnabled !== 'boolean') {
    await chrome.storage.sync.set({ veriRealEnabled: true });
  }
  await chrome.action.setBadgeText({ text: '' });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  console.log('[VERI-Real] Service Worker received message:', message);

  if (message.type === 'VIDEO_METADATA') {
    void (async () => {
      try {
        console.log('[VERI-Real] Metadata payload:', {
          timestamp: new Date().toISOString(),
          ...message.payload
        });
        await forwardMetadataToBackend(message.payload);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[VERI-Real] Metadata forwarding failed:', err);
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true;
  }

  if (message.type === 'VIDEO_FRAMES_BATCH') {
    const frameSizes = message.payload.frames.map((frame) => frame.size_bytes);
    console.log('[VERI-Real] Frame batch payload:', {
      timestamp: new Date().toISOString(),
      url: message.payload.url,
      video_id: message.payload.video_id,
      page_url: message.payload.page_url,
      frame_count: message.payload.frames.length,
      frame_sizes: frameSizes,
      first_frame_timestamp: message.payload.frames[0]?.timestamp_seconds,
      last_frame_timestamp:
        message.payload.frames[message.payload.frames.length - 1]?.timestamp_seconds
    });
    sendResponse({ ok: true, received: message.payload.frames.length });
    return true;
  }
  
  if (message.type !== 'VERIFY_MEDIA') {
    return false;
  }

  // A. This IIFE ensures the async work is contained and always calls sendResponse
  (async () => {
    try {
      // 1. Attempt the backend verification
      const result = await verifyWithBackend(message.payload);
      console.log('[VERI-Real] Backend verification result:', result);
      
      // 2. Update the UI icon
      if (sender.tab?.id) {
        await updateTabIcon(sender.tab.id, result.trustLevel).catch(() => {});
      }
      
      // 3. CRITICAL: Send the result back to main.ts
      sendResponse(result);
    } catch (err) {
      console.error('[VERI-Real] Service Worker Error:', err);
      
      // 4. Fallback so main.ts doesn't hang on "Checking"
      const fallback: VerifyResult = {
        trustLevel: 'gray',
        label: 'Neutral (Unverified)',
        reason: err instanceof Error ? err.message : 'Backend connection failed',
        source: 'extension-fallback'
      };
      sendResponse(fallback);
    }
  })();

  // B. This must remain at the bottom to tell Chrome we will respond asynchronously
  return true; 
});

async function forwardMetadataToBackend(payload: VideoMetadataPayload): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${ORCHESTRATOR_BASE}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentUrl: payload.url,
        platform: 'youtube',
        metadata: payload
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Metadata endpoint status ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function verifyWithBackend(
  payload: VerifyMediaMessage['payload']
): Promise<VerifyResult> {
  await deepfakeCache.ensureInitialized();

  const effectiveUrl = payload.contentUrl ?? preferredVerificationUrl(payload);
  const platform = payload.platform ?? inferPlatform(payload, effectiveUrl);
  const hasHttpMediaUrl = isHttpUrl(effectiveUrl);

  if (!hasHttpMediaUrl) {
    return {
      trustLevel: 'gray',
      label: 'Neutral (Unverified)',
      reason: 'No usable HTTP media URL was available for verification.',
      source: 'extension-skip'
    };
  }

  const cacheKey = `${payload.mediaType}:${payload.signature}`;
  
  // Check memory cache first (fast, short-lived)
  const cached = recentResults.get(cacheKey);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) {
    console.log('[VERI-Real] Using in-memory cache for:', payload.signature);
    return cached.value;
  }

  // Check persistent localStorage cache
  const persistedCacheEntry = deepfakeCache.get(payload.signature);
  if (persistedCacheEntry) {
    console.log('[VERI-Real] Using persistent cache for:', payload.signature);
    const result = persistedCacheEntryToVerifyResult(persistedCacheEntry);
    recentResults.set(cacheKey, { value: result, at: Date.now() });
    return result;
  }

  // Cache miss - call backend
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_VERIFY_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${ORCHESTRATOR_BASE}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentUrl: effectiveUrl,
        platform
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        trustLevel: 'gray',
        label: 'Neutral (Unverified)',
        reason: 'Verification timed out while waiting for backend response.',
        source: 'extension-timeout'
      };
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    return {
      trustLevel: 'gray',
      label: 'Neutral (Unverified)',
      reason: `Verification backend unavailable (status ${res.status}).`,
      source: 'extension-fallback'
    };
  }

  const raw = (await res.json()) as {
    verified?: boolean | null;
    is_deepfake?: boolean;
    source?: string;
    confidence?: number;
    details?: string[];
    error?: string;
    status?: string;
    verification_skipped?: boolean;
  };

  if (raw.error) {
    return {
      trustLevel: 'gray',
      label: 'Error',
      reason: `Verification temporarily unavailable: ${raw.error}`,
      source: 'extension-fallback',
      status: 'error'
    };
  }

  if (raw.status === 'no_human_subject') {
    return {
      trustLevel: 'gray',
      label: 'No Human Subject',
      reason: raw.details?.[0] ?? 'No human subject detected. Analysis skipped.',
      source: raw.source ?? 'face_detection_gate',
      status: raw.status,
      isDeepfake: undefined
    };
  }

  if (raw.status === 'no_actionable_content') {
    return {
      trustLevel: 'gray',
      label: 'No Actionable Content',
      reason: raw.details?.[0] ?? 'No actionable content found. Analysis skipped.',
      source: raw.source ?? 'content_gate',
      status: raw.status,
      isDeepfake: undefined
    };
  }

  const source = (raw.source ?? 'unknown').toLowerCase();
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  
  // Determine isDeepfake: blockchain-first, fallback to AI analysis
  let isDeepfake: boolean | undefined;
  if (typeof raw.is_deepfake === 'boolean') {
    isDeepfake = raw.is_deepfake;
  } else if (raw.verified === true) {
    isDeepfake = false;
  } else if (raw.verified === false) {
    isDeepfake = true;
  } else {
    isDeepfake = undefined;
  }

  // Build result with simplified binary color logic
  const result = buildDeepfakeResult(
    payload.signature,
    payload.mediaUrl,
    isDeepfake,
    confidence,
    source,
    raw.details ?? [],
    raw.status
  );

  // Cache the result
  await deepfakeCache.set(payload.signature, {
    url: payload.mediaUrl,
    signature: payload.signature,
    isDeepfake: isDeepfake ?? false,
    confidence,
    timestamp: Date.now()
  });

  recentResults.set(cacheKey, { value: result, at: Date.now() });
  return result;
}

/**
 * Convert a persisted cache entry back to VerifyResult
 */
function persistedCacheEntryToVerifyResult(entry: DeepfakeCacheEntry): VerifyResult {
  return buildDeepfakeResult(
    entry.signature,
    entry.url,
    entry.isDeepfake,
    entry.confidence,
    'cache',
    []
  );
}

/**
 * Build a simplified verification result based on deepfake status
 * Red: deepfake detected
 * Green: authentic detected
 * Gray: unknown/no data
 */
function buildDeepfakeResult(
  signature: string,
  url: string,
  isDeepfake: boolean | undefined,
  confidence: number | undefined,
  source: string,
  details: string[],
  status?: string
): VerifyResult {
  if (isDeepfake === undefined) {
    return {
      trustLevel: 'gray',
      label: 'Neutral (Unverified)',
      reason: 'Verification result inconclusive.',
      source,
      status,
      isDeepfake: undefined
    };
  }

  if (isDeepfake) {
    // RED: Deepfake detected
    return {
      trustLevel: 'red',
      label: '⚠️ Deepfake Detected',
      reason: confidence !== undefined ? `Deepfake confidence: ${confidence.toFixed(0)}%` : 'Deepfake detected',
      confidence,
      source,
      status,
      isDeepfake: true,
      manipulationPoints: details
    };
  } else {
    // GREEN: Authentic
    return {
      trustLevel: 'green',
      label: '✓ Authentic',
      reason: confidence !== undefined ? `Authentic confidence: ${confidence.toFixed(0)}%` : 'Content appears authentic',
      confidence,
      source,
      status,
      isDeepfake: false
    };
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function preferredVerificationUrl(payload: VerifyMediaMessage['payload']): string {
  if (payload.mediaType === 'video' && isSupportedVideoPageUrl(payload.pageUrl)) {
    return payload.pageUrl;
  }

  if (payload.effectiveUrl) {
    return payload.effectiveUrl;
  }

  return payload.mediaUrl;
}

function inferPlatform(
  payload: VerifyMediaMessage['payload'],
  effectiveUrl: string
): 'youtube' | 'twitter' {
  const candidateUrls = [effectiveUrl, payload.pageUrl, payload.mediaUrl];

  for (const raw of candidateUrls) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (
        host === 'x.com' ||
        host === 'www.x.com' ||
        host === 'twitter.com' ||
        host === 'www.twitter.com'
      ) {
        return 'twitter';
      }
      if (
        host === 'youtube.com' ||
        host === 'www.youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'youtu.be'
      ) {
        return 'youtube';
      }
    } catch {
      // Ignore invalid URLs and continue to next candidate.
    }
  }

  return 'youtube';
}

function isSupportedVideoPageUrl(raw: string): boolean {
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

async function updateTabIcon(tabId: number | undefined, trust: IconTrust): Promise<void> {
  if (typeof tabId !== 'number') {
    return;
  }

  const prev = tabTrust.get(tabId) ?? 'unknown';
  const next = mergeTrust(prev, trust);
  tabTrust.set(tabId, next);

  try {
    if (next === 'unknown') {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }

    await chrome.action.setBadgeText({ tabId, text: '●' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor(next) });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setTitle({
      tabId,
      title:
        next === 'green'
          ? 'VERI-Real: Verified Human'
          : next === 'yellow'
            ? 'VERI-Real: Likely Human'
            : next === 'gray'
              ? 'VERI-Real: Neutral (Unverified)'
              : 'VERI-Real: Synthetic Suspected'
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No tab with id')) {
      tabTrust.delete(tabId);
      return;
    }
    throw err;
  }
}

function mergeTrust(prev: IconTrust, next: IconTrust): IconTrust {
  const score = (value: IconTrust): number => {
    if (value === 'red') {
      return 3;
    }
    if (value === 'yellow') {
      return 2;
    }
    if (value === 'green') {
      return 1;
    }
    if (value === 'gray') {
      return 0.5;
    }
    return 0;
  };

  return score(next) >= score(prev) ? next : prev;
}

function badgeColor(trust: Exclude<IconTrust, 'unknown'>): string {
  if (trust === 'green') {
    return '#10b981';
  }
  if (trust === 'yellow') {
    return '#f59e0b';
  }
  if (trust === 'gray') {
    return '#64748b';
  }
  return '#ef4444';
}