import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { create } from "zustand";

type CredentialRequest =
  | { key: string; kind: "unlock" }
  | { key: string; kind: "connection"; reference: string };
type Pending = {
  request: CredentialRequest;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
const pending: Pending[] = [];
export const useCredentialPrompt = create<{
  request: CredentialRequest | null;
}>(() => ({ request: null }));

export function requestCredentialAccess(reference?: string): Promise<void> {
  const key = reference ? `connection:${reference}` : "unlock";
  const existing = pending.find((item) => item.request.key === key);
  if (existing) return existing.promise;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const request: CredentialRequest = reference
    ? { key, kind: "connection", reference }
    : { key, kind: "unlock" };
  pending.push({ request, promise, resolve, reject });
  if (pending.length === 1) useCredentialPrompt.setState({ request });
  return promise;
}

export function finishCredentialAccess(success: boolean) {
  const current = pending.shift();
  useCredentialPrompt.setState({ request: pending[0]?.request ?? null });
  if (success) current?.resolve();
  else current?.reject(new Error("已取消凭据输入"));
}

// Credential errors occur before the command can use the connection. Coalesce
// concurrent unlocks and replay only after the user supplies the missing secret.
// Timeouts cover IPC/network work, never time spent typing into a prompt.
export async function credentialInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  timeout?: { ms: number; message: string },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = tauriInvoke<T>(command, args);
      return await (timeout
        ? Promise.race([
            call,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(timeout.message)),
                timeout.ms,
              );
            }),
          ])
        : call);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        attempt >= 3
      )
        throw error;
      if (error.code === "credentials_locked") {
        const status = await tauriInvoke<{ locked: boolean }>(
          "get_credential_settings",
        );
        if (status.locked) await requestCredentialAccess();
      } else if (
        error.code === "credentials_required" &&
        "credential_ref" in error &&
        typeof error.credential_ref === "string"
      ) {
        await requestCredentialAccess(error.credential_ref);
      } else throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type CredentialMode = "plain" | "master" | "memory";
export type CredentialStatus = {
  mode: CredentialMode;
  locked: boolean;
  legacy_import_available: boolean;
};
export const credentialSettingsKey = ["credential-settings"];
export const credentialApi = {
  status: () => tauriInvoke<CredentialStatus>("get_credential_settings"),
  configure: (
    mode: CredentialMode,
    password: string,
    currentPassword: string,
  ) =>
    tauriInvoke<CredentialStatus>("save_credential_settings", {
      mode,
      password: password || null,
      currentPassword: currentPassword || null,
    }),
  unlock: (password: string) =>
    tauriInvoke<CredentialStatus>("unlock_credentials", { password }),
  reset: () =>
    tauriInvoke<CredentialStatus>("reset_credentials", { confirmed: true }),
  importLegacy: () => credentialInvoke<number>("import_legacy_credentials"),
};
