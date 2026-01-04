import { useState } from 'react';

function EncryptionBadge({ fingerprint }) {
  const [showModal, setShowModal] = useState(false);

  const words = fingerprint ? fingerprint.split('-') : [];

  return (
    <>
      {/* Lock icon button */}
      <button
        onClick={() => setShowModal(true)}
        className="fixed top-2 right-2 p-2 cursor-pointer z-[1000] bg-transparent border-none text-foreground hover:text-primary transition-colors"
        title="E2E Encrypted - Click to verify fingerprint"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </button>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-background z-[2000] flex flex-col p-5">
          <div className="flex justify-between items-center mb-5">
            <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
              E2E Fingerprint
            </span>
            <button
              onClick={() => setShowModal(false)}
              className="bg-transparent border-none text-primary text-xs cursor-pointer hover:underline"
            >
              Close
            </button>
          </div>

          <div className="flex flex-wrap gap-2 justify-center">
            {words.map((word, i) => {
              const longestWord = words.reduce((a, b) => a.length > b.length ? a : b);
              return (
                <div
                  key={i}
                  className="bg-secondary px-3 py-2 rounded-lg inline-flex items-center gap-2"
                  style={{ minWidth: `${longestWord.length * 9 + 40}px` }}
                >
                  <span className="text-xs text-muted-foreground font-mono">{i + 1}.</span>
                  <span className="text-sm text-foreground font-mono">{word}</span>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground mt-5 text-center">
            Verify these words match your Mac
          </p>
        </div>
      )}
    </>
  );
}

export default EncryptionBadge;
