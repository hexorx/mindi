export const DESKTOP_AGENT_TOOLS = [
  "desktop_capture",
  "window_capture",
  "desktop_input",
  "window_input",
] as const;
export interface DesktopToolLease {
  url: string;
  token: string;
  tools: string[];
  close(): void;
}
