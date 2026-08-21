// Helpers for the read-only terminal-history proxy. Keep terminal control
// sequences out of the browser so copied history stays readable and harmless.
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

export interface BashOutputEvent {
  id?: string;
  timestamp?: string;
  command_id?: string;
  order?: number;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  kind?: string;
}

/** Strip output fields and enforce one bounded response budget across chunks. */
export function sanitizeBashOutputs(items: BashOutputEvent[]): { items: BashOutputEvent[]; truncated: boolean } {
  let remaining = MAX_TERMINAL_OUTPUT_CHARS;
  let truncated = false;
  const take = (value: string | null | undefined): string | null => {
    if (value == null) return null;
    const clean = stripAnsi(value);
    if (clean.length <= remaining) {
      remaining -= clean.length;
      return clean;
    }
    truncated = true;
    const result = clean.slice(0, Math.max(0, remaining));
    remaining = 0;
    return result;
  };

  return {
    items: items.map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      command_id: item.command_id,
      order: item.order,
      exit_code: item.exit_code,
      stdout: take(item.stdout),
      stderr: take(item.stderr),
      kind: "BashOutput",
    })),
    truncated,
  };
}
