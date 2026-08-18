/**
 * URL helpers used for repo matching.
 *
 * Callers must use `canonicalizeUrl` rather than `new URL()` so scheme-less
 * git hosts and `.git` suffixes normalize the same way everywhere.
 */

export function canonicalizeUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("canonicalizeUrl: empty value");
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return new URL(withScheme);
}

/** Normalize a git remote so `github.com/Acme/Repo.git` matches `https://github.com/acme/repo`. */
export function canonicalizeRepoUrl(value: string): string {
  const url = canonicalizeUrl(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(".git")) {
    pathname = pathname.slice(0, -4);
  }
  // GitHub / GitLab treat owner and repo as case-insensitive.
  pathname = pathname
    .split("/")
    .map((part, index) => (index <= 2 ? part.toLowerCase() : part))
    .join("/");
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

export function repoUrlsEqual(a: string, b: string): boolean {
  try {
    return canonicalizeRepoUrl(a) === canonicalizeRepoUrl(b);
  } catch {
    return a.trim() === b.trim();
  }
}

export function repoIdentityFromUrl(value: string): { owner: string; name: string } | undefined {
  try {
    const url = canonicalizeUrl(canonicalizeRepoUrl(value));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return undefined;
    }
    return { owner: parts[0], name: parts[1] };
  } catch {
    return undefined;
  }
}
