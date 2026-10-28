/** The workspace list a host keeps in its settings, one `Name = path` per line. */
export interface NamedWorkspace {
  name: string;
  path: string;
}

export const MAX_NAMED_WORKSPACES = 20;
export const MAX_WORKSPACE_NAME_LENGTH = 60;
export const MAX_WORKSPACE_PATH_LENGTH = 4096;

/** Whether `path` is acceptable as something to open on a host. */
export function pathProblem(path: string): string | null {
  if (!path) return "The path is empty";
  if (path.length > MAX_WORKSPACE_PATH_LENGTH) return "The path is too long";
  if (path.includes("\0")) return "The path contains a NUL character";
  return null;
}

function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return last || path;
}

/**
 * Reads the setting leniently so a typo never hides the other lines: bad lines
 * are skipped and described in `errors`, which the settings form shows.
 *
 *   # comments and blank lines are ignored
 *   API = ~/work/api
 *   Infra = ~/work/infra/infra.code-workspace
 *   /var/www                      (no name: the last path segment is used)
 */
export function parseWorkspaces(text: unknown): {
  entries: NamedWorkspace[];
  errors: string[];
} {
  const entries: NamedWorkspace[] = [];
  const errors: string[] = [];
  if (typeof text !== "string") return { entries, errors };

  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const where = `Line ${index + 1}`;

    // A name never contains a slash, so "/srv/a=b" is a path that has an "=".
    const equals = line.indexOf("=");
    const named = equals >= 0 && !line.slice(0, equals).includes("/");
    const path = (named ? line.slice(equals + 1) : line).trim();
    const name = (named ? line.slice(0, equals) : nameFromPath(path)).trim();

    const problem = pathProblem(path);
    if (problem) return void errors.push(`${where}: ${problem}`);
    if (!name) return void errors.push(`${where}: the name is empty`);
    if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
      return void errors.push(
        `${where}: the name is longer than ${MAX_WORKSPACE_NAME_LENGTH} characters`,
      );
    }
    if (seen.has(name.toLowerCase()))
      return void errors.push(`${where}: "${name}" is listed twice`);
    if (entries.length >= MAX_NAMED_WORKSPACES) {
      return void errors.push(
        `${where}: at most ${MAX_NAMED_WORKSPACES} workspaces per host`,
      );
    }
    seen.add(name.toLowerCase());
    entries.push({ name, path });
  });

  return { entries, errors };
}
