import { Button } from "@/components/ui/button";
import { Loader2, Square } from "lucide-react";

function PowerButton({ active, connecting, onClick }) {
  if (connecting) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="rounded-full text-xs uppercase tracking-wide"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        CONNECTING
      </Button>
    );
  }

  if (active) {
    return (
      <Button
        variant="default"
        size="sm"
        onClick={onClick}
        className="rounded-full text-xs uppercase tracking-wide"
      >
        <Square className="h-3 w-3 fill-current" />
        CONNECTED
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="rounded-full text-xs uppercase tracking-wide"
    >
      START
    </Button>
  );
}

export default PowerButton;
