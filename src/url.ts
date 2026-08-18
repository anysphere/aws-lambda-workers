/**
 * Callers must use `canonicalizeUrl` rather than `new URL()`.
 */

export function canonicalizeUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("canonicalizeUrl: empty value");
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme);
}
