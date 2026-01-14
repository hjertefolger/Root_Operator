import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCw } from 'lucide-react';

function PairingScreen({ code, status, error }) {
  const [secondsLeft, setSecondsLeft] = useState(120);
  const codeWithSpaces = code ? code.split('').join(' ') : '';

  useEffect(() => {
    if (secondsLeft <= 0) return;

    const timer = setInterval(() => {
      setSecondsLeft((s) => s - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsLeft]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const isExpired = secondsLeft <= 0;

  // Safe area wrapper for all pairing screens
  const SafeAreaWrapper = ({ children }) => (
    <div className="h-dvh w-full flex flex-col bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-top)]" />
      <div className="flex-1 flex flex-col items-center justify-center p-10 bg-black">
        {children}
      </div>
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-bottom)]" />
    </div>
  );

  if (error) {
    return (
      <SafeAreaWrapper>
        <span className="font-mono text-xs font-normal tracking-wider text-foreground mb-8">
          ROOT_OPERATOR
        </span>

        <p className="text-sm text-destructive text-center mb-6">
          {error}
        </p>

        <button
          onClick={() => location.reload()}
          className="bg-muted text-foreground px-6 py-3 rounded-lg text-sm"
        >
          Try Again
        </button>
      </SafeAreaWrapper>
    );
  }

  if (status === 'connecting') {
    return (
      <SafeAreaWrapper>
        <span className="font-mono text-xs font-normal tracking-wider text-foreground mb-8">
          ROOT_OPERATOR
        </span>

        <p className="text-sm text-muted-foreground">
          Connecting...
        </p>
      </SafeAreaWrapper>
    );
  }

  return (
    <SafeAreaWrapper>
      <div className="flex flex-col items-center gap-8">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          ROOT_OPERATOR
        </span>

        <div className="flex flex-col items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground text-center">
            Pair Your Device
          </h1>

          <p className="text-sm text-muted-foreground text-center max-w-[280px] leading-relaxed">
            Open the desktop app, tap the + icon, and enter this code
          </p>
        </div>

        <div className="font-mono text-3xl font-medium tracking-[0.3em] text-foreground mt-4">
          {codeWithSpaces}
        </div>

        <div className="flex flex-col items-center gap-3 mt-4">
          <p className="text-xs text-muted-foreground/60 text-center">
            {isExpired
              ? 'Code expired'
              : `Code expires in ${minutes}m ${seconds.toString().padStart(2, '0')}s`
            }
          </p>

          <Button variant="ghost" size="sm" onClick={() => location.reload()}>
            <RotateCw />
            Refresh code
          </Button>
        </div>
      </div>
    </SafeAreaWrapper>
  );
}

export default PairingScreen;
