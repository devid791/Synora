import { isAbsolute, relative, sep } from "node:path";

/** Inputs are registered realpaths, not renderer-supplied resource aliases. */
export function workspaceOverlap(a: string, b: string): boolean {
  const inside = (root: string, target: string) => {
    const path = relative(root, target);
    return (
      !path ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  };
  return inside(a, b) || inside(b, a);
}
