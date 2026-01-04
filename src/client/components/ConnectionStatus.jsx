function ConnectionStatus({ message }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black z-50">
      <div className="text-center">
        <div className="text-white text-sm mb-2">Root Operator</div>
        <div className="text-gray-400 text-xs">{message}</div>
      </div>
    </div>
  );
}

export default ConnectionStatus;
