// Pure path helpers shared across main + renderer.

/** Last path segment, handling both POSIX ('/') and Windows ('\\') separators. */
export function basename(p: string): string {
  return p.split('/').pop()!.split('\\').pop()!;
}
