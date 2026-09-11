import { providerRuntimeLabel } from "../shared/provider-registry";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bearerHeaders, validateBearer } from "../engine/axiom-auth";
import type {
  Integration,
  ProviderCredentialStatus,
} from "../shared/contracts";
export interface CredentialCipher {
  seal(value: string): Buffer;
  open(value: Buffer): string;
}
type Envelope = {
  version: 1;
  endpoint: string;
  storage: "os-encrypted" | "private-file";
  value: string;
};
/** Dedicated owned storage. UI can set/delete/query presence, never read tokens. */
export class ProviderCredentials {
  constructor(
    private directory: string,
    private cipher?: CredentialCipher,
  ) {}
  private target(provider: Integration) {
    if (provider.kind !== "provider" || !/^[a-z0-9-]{1,80}$/.test(provider.id))
      throw new Error("Invalid credential provider identity");
    return join(this.directory, `${provider.id}.json`);
  }
  private async envelope(provider: Integration): Promise<Envelope | undefined> {
    const target = this.target(provider);
    let info;
    try {
      info = await lstat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Cannot access Synora provider credential file");
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
      throw new Error("Invalid Synora provider credential file");
    let v: Envelope;
    try {
      v = JSON.parse(await readFile(target, "utf8"));
    } catch {
      throw new Error("Cannot read Synora provider credential file");
    }
    if (
      v.version !== 1 ||
      !["os-encrypted", "private-file"].includes(v.storage) ||
      typeof v.value !== "string"
    )
      throw new Error("Invalid Synora provider credential envelope");
    // Never forward a saved secret to a newly edited endpoint.
    if (v.endpoint !== provider.endpoint.replace(/\/$/, "")) return;
    return v;
  }
  async status(provider: Integration): Promise<ProviderCredentialStatus> {
    const value = await this.envelope(provider);
    return {
      providerId: provider.id,
      present: !!value,
      storage:
        value?.storage ?? (this.cipher ? "os-encrypted" : "private-file"),
      usable: !!value && (value.storage === "private-file" || !!this.cipher),
    };
  }
  async load(provider: Integration): Promise<string | undefined> {
    const name = providerRuntimeLabel(provider.providerType);
    if (provider.auth === "none") return;
    if (provider.auth !== "api-key")
      throw new Error(
        `${name} provider OAuth is not mounted; select Bearer token or no authentication`,
      );
    const token = await this.loadPrivateRecord(provider);
    if (!token)
      throw new Error(
        `Save a Bearer token for this exact ${name} provider endpoint first`,
      );
    try {
      bearerHeaders(provider.endpoint, token);
    } catch {
      throw new Error(
        `The saved ${name} credential is unavailable or invalid. Unlock the OS credential store or replace it explicitly.`,
      );
    }
    return token;
  }
  async save(provider: Integration, raw: string) {
    if (provider.auth !== "api-key")
      throw new Error(
        "Select Bearer token authentication for this provider first",
      );
    const token = validateBearer(raw);
    bearerHeaders(provider.endpoint, token);
    return this.savePrivateRecord(provider, token);
  }
  /** Host-only typed OAuth stores reuse encryption/atomicity, not the API-key
   * interface. Each must use its own directory and validate its record schema. */
  async loadPrivateRecord(provider: Integration): Promise<string | undefined> {
    const value = await this.envelope(provider);
    if (!value) return;
    try {
      if (value.storage === "private-file") return value.value;
      if (!this.cipher) throw Error();
      return this.cipher.open(Buffer.from(value.value, "base64"));
    } catch {
      throw Error(
        "The saved credential is unavailable or invalid. Unlock the OS credential store or replace it explicitly.",
      );
    }
  }
  async savePrivateRecord(provider: Integration, record: string) {
    if (Buffer.byteLength(record) > 48000)
      throw Error("Private credential record exceeds storage bound");
    if (
      (await this.envelope(provider))?.storage === "os-encrypted" &&
      !this.cipher
    )
      throw new Error(
        "Unlock the OS credential store before replacing this encrypted token, or explicitly remove the old credential first",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.directory)).isDirectory() ||
      (await lstat(this.directory)).isSymbolicLink()
    )
      throw new Error(
        "Credential directory must be an owned directory, not a symbolic link",
      );
    const storage = this.cipher ? "os-encrypted" : "private-file";
    let value: string;
    try {
      value = this.cipher
        ? this.cipher.seal(record).toString("base64")
        : record;
    } catch {
      throw new Error(
        "OS credential encryption failed; the previous saved token was not replaced",
      );
    }
    const file = this.target(provider),
      temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          endpoint: provider.endpoint.replace(/\/$/, ""),
          storage,
          value,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      });
    }
    return this.status(provider);
  }
  async remove(provider: Integration) {
    await unlink(this.target(provider)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Cannot remove this Synora provider credential");
    });
    return this.status(provider);
  }
}
