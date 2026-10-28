import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { NamedWorkspace } from "../../shared/workspaces.js";

export interface WorkspaceInfo {
  default: string;
  named: NamedWorkspace[];
  recent: string[];
}

interface Props {
  info: WorkspaceInfo;
  /** Set when the path just tried could not be opened, and why. */
  problem?: { path: string; kind: "missing" | "unsupported" };
  onChoose: (path: string) => void;
}

const BUTTON =
  "border border-border px-3 py-1 text-left text-xs hover:bg-accent-brand/10";

export function WorkspaceChooser({ info, problem, onChoose }: Props) {
  const { t } = useTranslation();
  const [path, setPath] = useState(
    problem?.path ?? info.recent[0] ?? info.default,
  );
  const trimmed = path.trim();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-auto bg-background p-6 text-foreground">
      <div className="text-center">
        <h3 className="text-sm font-medium">{t("tab.choose")}</h3>
        {problem ? (
          <p className="mt-1 text-xs text-destructive">
            {t(
              problem.kind === "missing"
                ? "tab.missingDetail"
                : "tab.unsupportedDetail",
              {
                path: problem.path,
              },
            )}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("tab.chooseDetail")}
          </p>
        )}
      </div>

      {info.named.length > 0 && (
        <section className="flex w-full max-w-md flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{t("tab.named")}</h4>
          {info.named.map((workspace) => (
            <button
              key={workspace.name}
              type="button"
              className={BUTTON}
              onClick={() => onChoose(workspace.path)}
            >
              <span className="font-medium">{workspace.name}</span>
              <span className="ml-2 text-muted-foreground">
                {workspace.path}
              </span>
            </button>
          ))}
        </section>
      )}

      {info.recent.length > 0 && (
        <section className="flex w-full max-w-md flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{t("tab.recent")}</h4>
          {info.recent.map((recent) => (
            <button
              key={recent}
              type="button"
              className={BUTTON}
              onClick={() => onChoose(recent)}
            >
              {recent}
            </button>
          ))}
        </section>
      )}

      <form
        className="flex w-full max-w-md flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onChoose(trimmed);
        }}
      >
        <label className="text-xs text-muted-foreground" htmlFor="vscode-path">
          {t("tab.pathLabel")}
        </label>
        <div className="flex gap-2">
          <input
            id="vscode-path"
            className="h-8 flex-1 border border-border bg-background px-2 text-sm"
            value={path}
            placeholder={t("tab.pathPlaceholder")}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" className={BUTTON} disabled={!trimmed}>
            {t("tab.open")}
          </button>
        </div>
      </form>
    </div>
  );
}
