function FingerprintSection({ fingerprint }) {
  const words = fingerprint.split('-');
  const longestWord = words.reduce((a, b) => a.length > b.length ? a : b);
  const pillWidth = longestWord.length * 6 + 28;

  return (
    <div className="mt-3 pt-3 border-t border-gray-900">
      <div className="flex flex-wrap gap-1">
        {words.map((word, i) => (
          <div
            key={i}
            className="bg-[#1c1c1e] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
            style={{ minWidth: `${pillWidth}px` }}
          >
            <span className="text-[8px] text-gray-600">{i + 1}.</span>
            <span className="text-[9px] text-white">{word}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default FingerprintSection;
