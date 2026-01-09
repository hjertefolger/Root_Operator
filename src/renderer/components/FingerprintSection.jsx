import { Badge } from "@/components/ui/badge";

function FingerprintSection({ fingerprint }) {
  const words = fingerprint.split('-');

  return (
    <div className="mt-2 pb-3 flex flex-col">
      <div className="grid grid-cols-3 gap-1">
        {words.map((word, i) => (
          <Badge
            key={i}
            variant="secondary"
            className="w-full py-1 text-xs rounded-full animate-roll-out gap-1"
            style={{ animationDelay: `${i * 30}ms`, animationFillMode: 'backwards' }}
          >
            <span className="text-muted-foreground font-mono">{i + 1}.</span>
            <span>{word}</span>
          </Badge>
        ))}
      </div>
      <p
        className="text-xs text-muted-foreground text-center mt-2 animate-fade-in"
        style={{ animationDelay: '360ms', animationFillMode: 'backwards' }}
      >
        Compare with words on paired device
      </p>
    </div>
  );
}

export default FingerprintSection;
