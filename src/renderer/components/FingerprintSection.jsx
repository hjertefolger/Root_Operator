function FingerprintSection({ fingerprint }) {
  const words = fingerprint.split('-');
  const longestWord = words.reduce((a, b) => a.length > b.length ? a : b);
  const pillWidth = longestWord.length * 6 + 28;

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex flex-wrap gap-1">
        {words.map((word, i) => (
          <div
            key={i}
            className="bg-secondary px-1.5 py-0.5 rounded inline-flex items-center gap-1"
            style={{ minWidth: `${pillWidth}px` }}
          >
            <span className="text-xs text-muted-foreground">{i + 1}.</span>
            <span className="text-xs text-foreground">{word}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default FingerprintSection;
