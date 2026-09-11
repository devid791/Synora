import { z } from "zod";
import {
  ProviderCredentials,
  type CredentialCipher,
} from "./provider-credentials";
import type { Integration } from "../shared/contracts";
import {
  googleClientSchema,
  type GoogleClient,
  type GoogleAccountStatus,
} from "../shared/google-oauth";
import {
  GOOGLE_ENDPOINT,
  GoogleOAuthError,
  GoogleOAuthTransport,
  googleGrantSchema,
  type GoogleGrant,
} from "../engine/google-oauth";
const recordSchema = z
  .object({
    version: z.literal(1),
    client: googleClientSchema,
    grant: googleGrantSchema.optional(),
    needsLogin: z.boolean().default(false),
  })
  .strict();
type RecordValue = z.infer<typeof recordSchema>;
/** Private store distinct from API keys; mutation and refresh share one per-ID
 * queue so a logout/replacement cannot be undone by a late token refresh. */
export class GoogleAccounts {
  private vault: ProviderCredentials;
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    directory: string,
    cipher?: CredentialCipher,
    readonly transport = new GoogleOAuthTransport(),
    private now = Date.now,
  ) {
    this.vault = new ProviderCredentials(directory, cipher);
  }
  private valid(p: Integration) {
    if (
      p.kind !== "provider" ||
      p.providerType !== "gemini" ||
      p.auth !== "oauth" ||
      p.endpoint.replace(/\/$/, "") !== GOOGLE_ENDPOINT
    )
      throw Error(
        "Google OAuth requires the official Gemini endpoint and browser authentication",
      );
  }
  private async serial<T>(
    p: Integration,
    action: () => Promise<T>,
  ): Promise<T> {
    this.valid(p);
    const previous = this.queues.get(p.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    this.queues.set(p.id, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(p.id) === pending) this.queues.delete(p.id);
    }
  }
  private async read(p: Integration): Promise<RecordValue | undefined> {
    const raw = await this.vault.loadPrivateRecord(p);
    if (!raw) return;
    try {
      return recordSchema.parse(JSON.parse(raw));
    } catch {
      throw Error(
        "Stored Google authorization is invalid. Reconfigure it explicitly.",
      );
    }
  }
  private save(p: Integration, record: RecordValue) {
    return this.vault.savePrivateRecord(
      p,
      JSON.stringify(recordSchema.parse(record)),
    );
  }
  private async statusUnlocked(p: Integration): Promise<GoogleAccountStatus> {
    const storage = await this.vault.status(p),
      r = await this.read(p);
    const needsLogin =
      !!r?.needsLogin ||
      (!!r?.grant?.refreshExpiresAt && r.grant.refreshExpiresAt <= this.now());
    return {
      providerId: p.id,
      configured: !!r,
      authorized: !!r?.grant && !needsLogin,
      storage: storage.storage,
      needsLogin,
      ...(r
        ? { clientId: r.client.clientId, quotaProject: r.client.quotaProject }
        : {}),
      ...(r?.grant
        ? {
            expiresAt: r.grant.expiresAt,
            refreshExpiresAt: r.grant.refreshExpiresAt,
          }
        : {}),
    };
  }
  status(p: Integration) {
    return this.serial(p, () => this.statusUnlocked(p));
  }
  configure(p: Integration, raw: GoogleClient) {
    return this.serial(p, async () => {
      const client = googleClientSchema.parse(raw),
        previous = await this.read(p);
      if (
        previous?.grant &&
        JSON.stringify(previous.client) !== JSON.stringify(client)
      )
        throw Error(
          "Disconnect the saved Google account before replacing its OAuth client or quota project",
        );
      await this.save(
        p,
        previous?.grant ? previous : { version: 1, client, needsLogin: false },
      );
      return this.statusUnlocked(p);
    });
  }
  client(p: Integration) {
    return this.serial(p, async () => {
      const r = await this.read(p);
      if (!r)
        throw Error(
          "Configure your own Google Desktop OAuth client and quota project first",
        );
      return structuredClone(r.client);
    });
  }
  saveGrant(p: Integration, client: GoogleClient, grant: GoogleGrant) {
    return this.serial(p, async () => {
      const r = await this.read(p);
      if (
        !r ||
        JSON.stringify(r.client) !==
          JSON.stringify(googleClientSchema.parse(client))
      )
        throw Error("Google OAuth client changed during authorization");
      await this.save(p, {
        ...r,
        grant: googleGrantSchema.parse(grant),
        needsLogin: false,
      });
    });
  }
  access(p: Integration, signal: AbortSignal = AbortSignal.timeout(15000)) {
    return this.serial(p, async () => {
      signal.throwIfAborted();
      const r = await this.read(p);
      if (!r?.grant || r.needsLogin)
        throw Error("Sign in with Google before selecting Gemini");
      if (r.grant.refreshExpiresAt && r.grant.refreshExpiresAt <= this.now())
        throw Error("Google authorization expired. Sign in again.");
      if (r.grant.expiresAt <= this.now() + 60000) {
        try {
          r.grant = await this.transport.refresh(r.client, r.grant, signal);
          signal.throwIfAborted();
          await this.save(p, r);
        } catch (e) {
          if (e instanceof GoogleOAuthError && e.needsLogin) {
            await this.save(p, { ...r, needsLogin: true });
          }
          throw e;
        }
      }
      signal.throwIfAborted();
      return {
        accessToken: r.grant.accessToken,
        quotaProject: r.client.quotaProject,
      };
    });
  }
  disconnect(p: Integration, revoke: boolean) {
    return this.serial(p, async () => {
      const r = await this.read(p);
      if (revoke && r?.grant)
        await this.transport.revoke(r.grant, AbortSignal.timeout(15000));
      // Failed revocation preserves credentials for explicit retry/local removal.
      if (r)
        await this.save(p, { version: 1, client: r.client, needsLogin: false });
      return this.statusUnlocked(p);
    });
  }
  forget(p: Integration) {
    return this.serial(p, async () => {
      // Explicit recovery also works when the old record cannot be parsed or
      // decrypted. Local removal does not claim revocation at Google.
      await this.vault.remove(p);
      return this.statusUnlocked(p);
    });
  }
}
