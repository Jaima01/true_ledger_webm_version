import { useEffect, useMemo, useState } from 'react';

const ORCHESTRATOR_BASE =
  import.meta.env.VITE_ORCHESTRATOR_BASE ?? 'http://localhost:3000';

export function App() {
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chrome.storage.sync.get('veriRealEnabled').then((data) => {
      setEnabled(data.veriRealEnabled !== false);
    });
  }, []);

  const statusText = useMemo(
    () => (enabled ? 'Trust badges are active.' : 'Trust badges are paused.'),
    [enabled]
  );

  async function onToggle(checked: boolean) {
    setEnabled(checked);
    await chrome.storage.sync.set({ veriRealEnabled: checked });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  return (
    <main className="panel">
      <section className="hero">
        <h1>
          VERI-Real
          <span className="seal-badge" aria-hidden="true">
            <svg viewBox="0 0 64 64" role="img">
              <path
                d="M32 6l8 5 9-1 3 8 8 4-1 9 5 8-6 7 1 9-8 4-3 8-9-1-8 5-8-5-9 1-3-8-8-4 1-9-5-8 6-7-1-9 8-4 3-8 9 1z"
                fill="#334155"
              />
              <circle cx="32" cy="32" r="13" fill="#e2e8f0" />
              <path d="M25 33l5 5 10-11" fill="none" stroke="#334155" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M24 48l-4 10 9-5 3 9 5-8" fill="#475569" />
              <path d="M40 54l3 8 6-9 8 5-5-11" fill="#475569" />
            </svg>
          </span>
        </h1>
        <p>
          AI + blockchain trust indicator for images and videos across any site.
        </p>
      </section>

      <section className="card">
        <label className="toggleRow">
          <span>Enable live scanning</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void onToggle(e.target.checked)}
          />
        </label>
        <p className="status">{statusText}</p>
        {saved && <p className="saved">Saved</p>}
      </section>

      <section className="legend">
        <h2>Badge Legend</h2>
        <p><span className="dot green" /> Green: Match found on blockchain.</p>
        <p><span className="dot yellow" /> Yellow: No match, AI says likely human.</p>
        <p><span className="dot gray" /> Gray: Neutral/unverified (source unavailable or backend fallback).</p>
        <p><span className="dot red" /> Red: AI detects synthetic manipulation.</p>
      </section>

      <footer>
        <small>Verifier API: {ORCHESTRATOR_BASE}/api/verify</small>
      </footer>
    </main>
  );
}