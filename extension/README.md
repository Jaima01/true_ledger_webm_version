# VERI-Real Browser Extension

Manifest V3 Chrome extension built with React + TypeScript.

## Features

- Scans all pages for on-screen `img` and `video` elements in real time.
- Computes a deterministic media signature in the content script.
- Re-checks media when source changes and on a timed interval for live content.
- Uses bounded concurrency to reduce request spikes on media-dense pages.
- Falls back to compressed frame snapshots when direct media URLs are unavailable.
- Sends signatures and media URLs to the orchestrator (`/api/verify`) with media type metadata.
- Overlays a trust badge on each media element:
  - Green: blockchain match (`Verified Human`)
  - Yellow: no chain match, but AI says likely human or unsupported source fallback
  - Red: AI flags synthetic manipulation

## Run

1. Install dependencies.
   ```bash
   npm install
   ```
2. (Optional) configure API base URL.
   ```bash
   cp .env.example .env
   ```
3. Build the extension.
   ```bash
   npm run build
   ```
4. In Chrome, open `chrome://extensions`, enable Developer Mode, and load unpacked from `dist/`.

## Dev mode

```bash
npm run dev
```
