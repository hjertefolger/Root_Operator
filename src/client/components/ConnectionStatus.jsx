function ConnectionStatus({ message }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background z-50">
      <div className="text-center">
        <div className="text-foreground text-sm mb-2">Root Operator</div>
        <div className="text-muted-foreground text-xs">{message}</div>
      </div>
    </div>
  );
}

export default ConnectionStatus;
