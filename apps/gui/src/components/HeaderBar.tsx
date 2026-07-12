import type { SessionModeState } from "@minerva/protocol";

/** Project + session controls: folder, session browser, new session, mode,
 * profile, compact. The GUI's equivalent of the TUI's slash commands. */
export function HeaderBar({
  cwd,
  modes,
  currentModeId,
  profiles,
  profile,
  busy,
  onOpenFolder,
  onOpenSessions,
  onNewSession,
  onSetMode,
  onSetProfile,
  onCompact,
}: {
  cwd: string;
  modes: SessionModeState | null;
  currentModeId: string | undefined;
  profiles: string[];
  profile: string | null;
  busy: boolean;
  onOpenFolder: () => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  onSetMode: (modeId: string) => void;
  onSetProfile: (profile: string | null) => void;
  onCompact: () => void;
}) {
  const folder = cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  return (
    <header className="flex items-center gap-2 border-b px-4 py-2 text-sm">
      <button
        type="button"
        onClick={onOpenFolder}
        title={`${cwd} — open another project folder`}
        className="rounded-md px-2 py-1 font-medium hover:bg-secondary"
      >
        📁 {folder}
      </button>
      <button
        type="button"
        onClick={onOpenSessions}
        title="Browse sessions for this project"
        className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary"
      >
        Sessions
      </button>
      <button
        type="button"
        onClick={onNewSession}
        title="Start a new session in this project"
        className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary"
      >
        New
      </button>
      <div className="ml-auto flex items-center gap-2">
        {profiles.length > 0 ? (
          <select
            value={profile ?? ""}
            onChange={(event) => onSetProfile(event.target.value || null)}
            title="Profile"
            className="rounded-md border bg-background px-1.5 py-1 text-xs"
          >
            <option value="">no profile</option>
            {profiles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        {modes ? (
          <select
            value={currentModeId ?? modes.currentModeId}
            onChange={(event) => onSetMode(event.target.value)}
            title="Session mode"
            className="rounded-md border bg-background px-1.5 py-1 text-xs"
          >
            {modes.availableModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={onCompact}
          disabled={busy}
          title="Summarize the conversation and reset model context"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          Compact
        </button>
      </div>
    </header>
  );
}
