'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error('[ui-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: '#0f1115',
          color: '#f5f5f5',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 340 }}>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Something went wrong</p>
          <p style={{ margin: '8px 0 0', fontSize: 14, opacity: 0.7 }}>
            የተሳሳተ ነገር ተፈጥሯል· Wanti tokko dogoggora ta&apos;e
          </p>
          {error.digest ? (
            <p style={{ margin: '12px 0 0', fontSize: 12, opacity: 0.5 }}>Ref: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: 20,
              padding: '10px 20px',
              borderRadius: 8,
              border: '1px solid #3a3f4a',
              background: '#1a1d23',
              color: 'inherit',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again · እንደገና ሞክር
          </button>
        </div>
      </body>
    </html>
  );
}
