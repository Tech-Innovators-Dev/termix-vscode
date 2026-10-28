import { useEffect, useState } from "react";
import {
  usePluginApi,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { useVSCodeSession } from "../hooks/useVSCodeSession.js";
import { WorkspaceChooser, type WorkspaceInfo } from "./WorkspaceChooser.js";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-6 text-center text-foreground">
      {children}
    </div>
  );
}

/** What the tab was opened with: a workspace to open, or a request to ask. */
interface TabData {
  workspacePath?: string;
  prompt?: boolean;
}

type Problem = { path: string; kind: "missing" | "unsupported" };

const FALLBACK: WorkspaceInfo = { default: "~", named: [], recent: [] };

export function VSCodeTab({ tab, host, isVisible }: TabProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const data = (tab?.data ?? {}) as TabData;

  // null: nothing chosen yet. A string: open that. The tab's own workspace wins;
  // otherwise the last one used on this host; otherwise the user is asked.
  const [chosen, setChosen] = useState<string | null>(
    data.workspacePath ?? null,
  );
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [problem, setProblem] = useState<Problem | undefined>();
  const [infoVersion, setInfoVersion] = useState(0);

  const session = useVSCodeSession(host?.id, chosen);

  useEffect(() => {
    // A workspace the tab was opened with needs no lookup, until it fails and
    // the user has to choose another.
    if (!host || (data.workspacePath && infoVersion === 0)) return;
    let current = true;
    api
      .get<WorkspaceInfo>(`/workspaces/${host.id}`)
      .then(
        ({ data: loaded }) => loaded,
        () => FALLBACK,
      )
      .then((loaded) => {
        if (!current) return;
        setInfo(loaded);
        if (!data.prompt && !problem && loaded.recent[0])
          setChosen(loaded.recent[0]);
      });
    return () => {
      current = false;
    };
    // infoVersion reloads the list after a path turned out to be missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, infoVersion]);

  // The host did not have the path: forget the choice and ask again.
  useEffect(() => {
    if (
      session.status !== "workspace_missing" &&
      session.status !== "workspace_unsupported"
    )
      return;
    setProblem({
      path: chosen ?? "",
      kind: session.status === "workspace_missing" ? "missing" : "unsupported",
    });
    setChosen(null);
    setInfo(null);
    setInfoVersion((version) => version + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status]);

  if (!host) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">{t("tab.noHost")}</p>
      </Centered>
    );
  }

  if (chosen === null) {
    return info ? (
      <WorkspaceChooser
        info={info}
        problem={problem}
        onChoose={(path) => {
          setProblem(undefined);
          setChosen(path);
        }}
      />
    ) : (
      <Centered>
        <p className="text-xs text-muted-foreground">{t("tab.launching")}</p>
      </Centered>
    );
  }

  const { status, iframeUrl, errorMessage, retry } = session;

  if (status === "launching" || status === "idle") {
    return (
      <Centered>
        <h3 className="text-sm font-medium">{t("tab.launching")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("tab.launchingDetail")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("tab.opening", { path: chosen })}
        </p>
      </Centered>
    );
  }

  if (status === "workspace_missing" || status === "workspace_unsupported") {
    return (
      <Centered>
        <p className="text-xs text-muted-foreground">{t("tab.launching")}</p>
      </Centered>
    );
  }

  if (status === "not_installed") {
    return (
      <Centered>
        <h3 className="text-sm font-medium">{t("tab.notInstalled")}</h3>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("tab.notInstalledDetail")}
        </p>
        <code className="border border-border px-2 py-1 text-xs">
          {t("tab.installCommand")}
        </code>
        <button
          type="button"
          className="border border-border px-3 py-1 text-xs"
          onClick={() => void retry()}
        >
          {t("tab.retry")}
        </button>
      </Centered>
    );
  }

  if (status === "too_many") {
    return (
      <Centered>
        <h3 className="text-sm font-medium">{t("tab.tooMany")}</h3>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("tab.tooManyDetail")}
        </p>
        <button
          type="button"
          className="border border-border px-3 py-1 text-xs"
          onClick={() => void retry()}
        >
          {t("tab.retry")}
        </button>
      </Centered>
    );
  }

  if (status === "error" || !iframeUrl) {
    return (
      <Centered>
        <h3 className="text-sm font-medium text-destructive">
          {t("tab.error")}
        </h3>
        {errorMessage && (
          <pre className="max-w-xl whitespace-pre-wrap text-xs text-muted-foreground">
            {errorMessage}
          </pre>
        )}
        <button
          type="button"
          className="border border-border px-3 py-1 text-xs"
          onClick={() => void retry()}
        >
          {t("tab.retry")}
        </button>
      </Centered>
    );
  }

  return (
    <iframe
      title={t("tab.title")}
      src={iframeUrl}
      className="h-full w-full border-0"
      style={{ display: isVisible ? "block" : "none" }}
      allow="clipboard-read; clipboard-write"
    />
  );
}
