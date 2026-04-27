export type TrustLevel = 'green' | 'yellow' | 'red' | 'gray';

export interface VerifyMediaMessage {
  type: 'VERIFY_MEDIA';
  payload: {
    mediaId: string;
    mediaUrl: string;
    effectiveUrl?: string;
    contentUrl?: string;
    platform?: 'youtube' | 'twitter';
    frameDataUrl?: string;
    signature: string;
    mediaType: 'img' | 'video';
    pageUrl: string;
  };
}

export interface VideoMetadataPayload {
  url: string;
  video_id: string;
  duration_seconds: number;
  publish_date: string | null;
  channel_name: string | null;
  content_title: string | null;
  captured_at: string;
}

export interface VideoMetadataMessage {
  type: 'VIDEO_METADATA';
  payload: VideoMetadataPayload;
}

export interface CapturedFrame {
  sequence_id: number;
  timestamp_seconds: number;
  captured_at: string;
  mime_type: string;
  size_bytes: number;
  blob: Blob;
}

export interface VideoFramesBatchPayload {
  url: string;
  video_id: string;
  page_url: string;
  sent_at: string;
  frames: CapturedFrame[];
  audio_chunks?: Blob[];
  audio_mime_type?: string;
}

export interface VideoFramesBatchMessage {
  type: 'VIDEO_FRAMES_BATCH';
  payload: VideoFramesBatchPayload;
}

export type RuntimeMessage =
  | VerifyMediaMessage
  | VideoMetadataMessage
  | VideoFramesBatchMessage;

export interface VerifyResult {
  trustLevel: TrustLevel;
  label: string;
  reason: string;
  status?: string;
  confidence?: number;
  manipulationPoints?: string[];
  source: string;
  isDeepfake?: boolean;
}

export interface DeepfakeCacheEntry {
  url: string;
  signature: string;
  isDeepfake: boolean;
  confidence?: number;
  timestamp: number;
}