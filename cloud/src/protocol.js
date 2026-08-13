/**
 * Message type constants shared between agent and cloud relay.
 */
export const MSG = {
  // Terminal I/O
  TERMINAL_ATTACH: 'terminal:attach',
  TERMINAL_ATTACHED: 'terminal:attached',
  TERMINAL_HISTORY: 'terminal:history',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_PASTE_IMAGE: 'terminal:pasteImage',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_CLOSED: 'terminal:closed',
  TERMINAL_DETACH: 'terminal:detach',
  TERMINAL_DETACHED: 'terminal:detached',
  TERMINAL_ERROR: 'terminal:error',

  // Claude states
  CLAUDE_STATES: 'claude:states',

  // Metrics
  METRICS: 'metrics',

  // REST-over-WS
  REQUEST: 'request',
  RESPONSE: 'response',

  // Agent <-> Cloud
  AGENT_AUTH: 'agent:auth',
  AGENT_AUTH_OK: 'agent:auth:ok',
  AGENT_AUTH_FAIL: 'agent:auth:fail',
  AGENT_PING: 'agent:ping',
  AGENT_PONG: 'agent:pong',
};
