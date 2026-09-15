import type { SafeStorage } from "electron";
import type { CredentialCipher } from "./provider-credentials";

type Storage = Pick<SafeStorage,"isEncryptionAvailable"|"getSelectedStorageBackend"|"encryptString"|"decryptString"> &
  Partial<Pick<SafeStorage,"isAsyncEncryptionAvailable"|"encryptStringAsync"|"decryptStringAsync">>;

/** Do not initialize the macOS Keychain merely to display an empty profile.
 * macOS operations are asynchronous: an OS consent dialog must not block the
 * application main thread. Existing envelopes are read without rewriting them;
 * no ACL changes, password entry, forced key rotation or plaintext fallback.
 * Windows/Linux retain their existing providers and encrypted-byte contracts. */
export function nativeCredentialCipher(storage: Storage, platform: NodeJS.Platform,
  options: { timeoutMs?: number } = {}): CredentialCipher | undefined {
  if (platform === "darwin") {
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error("Invalid credential operation timeout");
    const unavailable = () => Error("The operating system's encrypted credential store is unavailable");
    let readiness: Promise<boolean> | undefined;
    let initializationFailed = false;
    let pendingOperation: Promise<unknown> | undefined;
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    };
    const available = async () => {
      if (initializationFailed) throw unavailable();
      if (!readiness) {
        if (!storage.isAsyncEncryptionAvailable || !storage.encryptStringAsync || !storage.decryptStringAsync)
          throw unavailable(); // Never fall back to a blocking macOS call.
        readiness = Promise.resolve().then(() => storage.isAsyncEncryptionAvailable!()).then(value => {
          initializationFailed = !value;
          return value;
        }, () => { initializationFailed = true; return false; });
      }
      try {
        if (!await bounded(readiness)) throw unavailable();
      } catch {
        // Share the one pending OS initialization. A later positive completion
        // permits recovery; polling must not create a new consent request.
        initializationFailed = true;
        throw unavailable();
      }
    };
    const perform = async <T>(action: () => Promise<T>): Promise<T> => {
      await available();
      // A caller timeout cannot cancel the OS operation. Keep its slot until
      // the original promise settles, so polling never starts overlapping
      // Keychain requests. Timed-out waiters do not execute their action later.
      while (pendingOperation) await bounded(pendingOperation.then(() => {}, () => {}));
      const operation = Promise.resolve().then(action);
      pendingOperation = operation;
      const clear = () => { if (pendingOperation === operation) pendingOperation = undefined; };
      void operation.then(clear, clear);
      return bounded(operation);
    };
    return {
      async seal(value) {
        return perform(() => storage.encryptStringAsync!(value));
      },
      async open(value) {
        const decrypted = await perform(() => storage.decryptStringAsync!(value));
        if (typeof decrypted.result !== "string") throw unavailable();
        // A key-rotation hint must not silently rewrite stored user credentials.
        return decrypted.result;
      },
    };
  }
  if (platform === "linux" && (!storage.isEncryptionAvailable() ||
      !["gnome_libsecret","kwallet","kwallet5","kwallet6"].includes(storage.getSelectedStorageBackend())))
    return undefined; // Preserve the existing explicit Linux storage policy.
  const available = () => {
    if (!storage.isEncryptionAvailable()) throw Error("The operating system's encrypted credential store is unavailable");
  };
  return {
    seal(value) { available(); return storage.encryptString(value); },
    open(value) { available(); return storage.decryptString(value); },
  };
}
