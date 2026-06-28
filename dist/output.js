export function printJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
export function printError(error, json) {
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
    process.stderr.write(`Error: ${message}\n`);
}
//# sourceMappingURL=output.js.map