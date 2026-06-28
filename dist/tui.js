const ansiPattern = /\u001b\[[0-9;]*m/g;
function shouldColor() {
    if (process.env.NO_COLOR) {
        return false;
    }
    return Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY);
}
function style(open, close) {
    return (value) => (shouldColor() ? `${open}${value}${close}` : value);
}
export const tui = {
    bold: style("\u001b[1m", "\u001b[22m"),
    dim: style("\u001b[2m", "\u001b[22m"),
    red: style("\u001b[31m", "\u001b[39m"),
    green: style("\u001b[32m", "\u001b[39m"),
    yellow: style("\u001b[33m", "\u001b[39m"),
    blue: style("\u001b[34m", "\u001b[39m"),
    magenta: style("\u001b[35m", "\u001b[39m"),
    cyan: style("\u001b[36m", "\u001b[39m"),
    gray: style("\u001b[90m", "\u001b[39m"),
};
export function status(kind, text) {
    switch (kind) {
        case "success":
            return tui.green(`OK ${text}`);
        case "dry":
            return tui.yellow(`DRY ${text}`);
        case "warning":
            return tui.yellow(`WARN ${text}`);
        case "error":
            return tui.red(`ERR ${text}`);
        case "info":
            return tui.cyan(`INFO ${text}`);
    }
}
export function command(value) {
    return tui.cyan(value);
}
export function pathValue(value) {
    return tui.magenta(value);
}
export function section(title) {
    return `\n${tui.bold(title)}\n`;
}
export function hint(text) {
    return `${tui.cyan("Hint")} ${text}`;
}
export function warnLine(text) {
    return `${status("warning", text)}`;
}
export function table(rows, headers) {
    const allRows = headers ? [headers, ...rows] : rows;
    const widths = allRows.reduce((acc, row) => {
        row.forEach((cell, index) => {
            acc[index] = Math.max(acc[index] ?? 0, visibleLength(cell));
        });
        return acc;
    }, []);
    const renderedRows = rows.map((row) => renderRow(row, widths));
    if (!headers) {
        return renderedRows.join("\n");
    }
    return [
        renderRow(headers.map((header) => tui.bold(header)), widths),
        renderRow(headers.map((header, index) => tui.gray("-".repeat(widths[index] || visibleLength(header)))), widths),
        ...renderedRows,
    ].join("\n");
}
export function list(items) {
    return items.map((item) => `  ${tui.gray("-")} ${item}`).join("\n");
}
function renderRow(row, widths) {
    return row
        .map((cell, index) => `${cell}${" ".repeat(Math.max(0, (widths[index] ?? 0) - visibleLength(cell)))}`)
        .join("  ");
}
function visibleLength(value) {
    return value.replace(ansiPattern, "").length;
}
//# sourceMappingURL=tui.js.map