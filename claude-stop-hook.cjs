const fs = require('fs');

let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  const hookLogPath = process.env.ROOT_OPERATOR_HOOK_LOG;
  if (!hookLogPath) {
    process.exit(0);
  }

  let payload = {
    hookEventName: '',
    toolName: '',
    toolInput: null,
    toolResponse: null,
    toolUseId: '',
    cwd: '',
    permissionMode: '',
    stopReason: '',
    error: '',
    errorDetails: null,
    lastAssistantMessage: '',
    ts: new Date().toISOString(),
  };

  try {
    const parsed = input ? JSON.parse(input) : {};
    payload = {
      hookEventName: parsed.hook_event_name || parsed.hookEventName || '',
      toolName: parsed.tool_name || parsed.toolName || '',
      toolInput: parsed.tool_input || parsed.toolInput || null,
      toolResponse: parsed.tool_response || parsed.toolResponse || null,
      toolUseId: parsed.tool_use_id || parsed.toolUseId || '',
      cwd: parsed.cwd || '',
      permissionMode: parsed.permission_mode || parsed.permissionMode || '',
      stopReason: parsed.stop_reason || parsed.stopReason || '',
      error: parsed.error || '',
      errorDetails: parsed.error_details || parsed.errorDetails || null,
      lastAssistantMessage: parsed.last_assistant_message || parsed.lastAssistantMessage || '',
      ts: new Date().toISOString(),
    };
  } catch (error) {
    // Ignore malformed hook payloads and keep the process non-blocking.
  }

  try {
    fs.appendFileSync(hookLogPath, `${JSON.stringify(payload)}\n`);
  } catch (error) {
    // Do not block Claude's hook lifecycle on local logging failures.
  }

  process.exit(0);
});

process.stdin.resume();
