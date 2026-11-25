import { describe, expect, it } from "@effect/vitest";

import * as VaultCrypto from "./VaultCrypto.ts";

describe("VaultCrypto", () => {
  it("round-trips an entry and refuses another entry id, generation or key", () => {
    const vaultKey = VaultCrypto.generateVaultKey();
    const ciphertext = VaultCrypto.encryptEntry({
      vaultKey,
      generation: 1,
      entryId: "a",
      plaintext: '{"value":"hunter2"}',
    });
    expect(ciphertext).not.toContain("hunter2");
    expect(VaultCrypto.decryptEntry({ vaultKey, generation: 1, entryId: "a", ciphertext })).toBe(
      '{"value":"hunter2"}',
    );
    expect(() =>
      VaultCrypto.decryptEntry({ vaultKey, generation: 1, entryId: "b", ciphertext }),
    ).toThrow();
    expect(() =>
      VaultCrypto.decryptEntry({ vaultKey, generation: 2, entryId: "a", ciphertext }),
    ).toThrow();
    expect(() =>
      VaultCrypto.decryptEntry({
        vaultKey: VaultCrypto.generateVaultKey(),
        generation: 1,
        entryId: "a",
        ciphertext,
      }),
    ).toThrow();
  });

  it("seals the vault key to one environment only", () => {
    const vaultKey = VaultCrypto.generateVaultKey();
    const recipient = VaultCrypto.generateKeyPair();
    const other = VaultCrypto.generateKeyPair();
    const wrappedKey = VaultCrypto.sealVaultKey({
      vaultKey,
      generation: 3,
      recipientPublicKey: recipient.publicKey,
    });
    expect(VaultCrypto.openVaultKey({ wrappedKey, generation: 3, keyPair: recipient })).toEqual(
      vaultKey,
    );
    expect(() => VaultCrypto.openVaultKey({ wrappedKey, generation: 3, keyPair: other })).toThrow();
    expect(() =>
      VaultCrypto.openVaultKey({ wrappedKey, generation: 4, keyPair: recipient }),
    ).toThrow();
  });
});
