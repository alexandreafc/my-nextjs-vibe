"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div style={{ padding: 24, fontFamily: "monospace" }}>
          <h2>Something went wrong</h2>
          <pre style={{ color: "red", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {error.message}
          </pre>
          {error.digest && (
            <p style={{ color: "#888" }}>Digest: {error.digest}</p>
          )}
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
