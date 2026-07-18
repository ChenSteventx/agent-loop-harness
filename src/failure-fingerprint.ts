// Stable identity for repeated-failure detection. The raw evidence keeps the
// exact captured output; only the SIGNATURE normalizes declared non-semantic
// noise classes, so the same root cause hashes identically across reruns
// while a genuinely different failure still changes the hash.
//
// Declared noise classes (each covered by a regression test):
// - ISO-8601 timestamps and epoch milliseconds
// - durations (e.g. "in 123ms", "took 4.56s")
// - hexadecimal identifiers of 8+ characters (commit shas, request ids)
// - OS temp paths (/tmp/..., /var/folders/..., Windows %TEMP% shapes)
// - process ids ("pid 1234", "process 1234")
// - port numbers in listen/connect phrases
export function normalizeFailureText(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu, "<timestamp>")
    .replace(/\b1[5-9]\d{11}\b/gu, "<epoch-ms>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|milliseconds|s|sec|seconds)\b/gu, "<duration>")
    // At least one a-f letter: a purely decimal value (order ids, amounts)
    // is semantic content, not a hash-like identifier.
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}\b/gu, "<hex>")
    // Temp DIRECTORY segments are noise; the final path segment (the file
    // that failed) is semantic and survives, so failures in different files
    // under the same temp worktree do not collapse into one signature.
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var)\/[^\s"']*\/(?=[^/\s"'][^/\s"']*)/gu, "<tmp-path>/")
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var)\/[^\s"'/]+(?=[\s"']|$)/gu, "<tmp-path>")
    .replace(/\b[A-Z]:\\+(?:Users\\+[^\\\s]+\\+AppData\\+Local\\+Temp|Windows\\+Temp)\\+(?:[^\s"'\\]+\\+)*(?=[^\s"'\\]+)/gu, "<tmp-path>\\")
    .replace(/\b(?:pid|process)[ =:]+\d+\b/giu, "<pid>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/gu, "<address>")
    .replace(/\blocalhost:\d{2,5}\b/giu, "<address>")
    .replace(/\b(?:port|listening on)\s+\d{2,5}\b/giu, "<port>");
}
