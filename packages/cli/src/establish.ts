import type { MinervaClient, SessionStore } from "@minerva/client";
import type { InstructionsInfo } from "@minerva/protocol";

/**
 * Session establishment shared by the TUI and print mode: new session,
 * resume-latest, or resume-by-id — plus the profile handoff. An EXPLICIT
 * profile request (--profile) overrides a resumed session's persisted
 * profile; the settings-default profile never does (callers pass only the
 * flag), so a resumed session keeps the persona it was left with.
 */

export interface EstablishOptions {
  /** null = new session; "latest" = most recent for cwd; else a session id. */
  resume?: string | null | undefined;
  /** Explicit profile request from --profile. */
  profile?: string | null | undefined;
}

export interface EstablishedSession {
  sessionId: string;
  store: SessionStore;
  instructions?: InstructionsInfo | undefined;
  profile?: string | undefined;
}

export async function establishSession(
  client: MinervaClient,
  cwd: string,
  options: EstablishOptions,
): Promise<EstablishedSession> {
  const { resume, profile } = options;
  const load = async (sessionId: string): Promise<EstablishedSession> => {
    const result = await client.loadSession(sessionId, cwd);
    if (profile && result.profile !== profile) {
      // Applies from the next prompt; an unknown name fails establish loudly.
      await client.setProfile(result.sessionId, profile);
      return { ...result, profile };
    }
    return result;
  };
  if (resume === "latest") {
    const sessions = await client.listSessions(cwd);
    const latest = sessions[0];
    if (!latest) throw new Error(`no previous sessions for ${cwd}`);
    return load(latest.sessionId);
  }
  if (resume) return load(resume);
  return client.newSession(cwd, profile ? { profile } : {});
}
