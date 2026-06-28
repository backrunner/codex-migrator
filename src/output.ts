import { status } from "./tui.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);

  if (json) {
    printJson({
      ok: false,
      error: {
        message,
      },
    });
    return;
  }

  process.stderr.write(`${status("error", message)}\n`);
}
