export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }
  | Record<string, unknown>;

export interface StudioBridge {
  /** MCP servers exposed to the agent, keyed by server name. */
  mcpServers(): Record<string, McpServerConfig>;
  /** Fully-qualified tool names the agent may call without prompting. */
  allowedTools(): string[];
}
