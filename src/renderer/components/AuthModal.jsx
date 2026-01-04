import { Button } from "@/components/ui/button";

function AuthModal({ device, onApprove }) {
  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center p-4 z-[100]">
      <div className="flex items-center gap-3">
        <span className="text-[9px] text-muted-foreground tracking-wide">
          New device: {device.kid.substring(0, 12)}...
        </span>
        <Button
          onClick={onApprove}
          size="sm"
          className="rounded-full text-[9px] uppercase tracking-wide"
        >
          ALLOW
        </Button>
      </div>
    </div>
  );
}

export default AuthModal;
