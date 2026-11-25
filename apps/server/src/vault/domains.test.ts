import { describe, expect, it } from "@effect/vitest";

import { normalizeDomain, originAllowed, registrableDomain } from "./domains.ts";

describe("vault domains", () => {
  it("binds a domain to its registrable domain from the Public Suffix List", () => {
    expect(registrableDomain("login.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("github.io")).toBeNull();
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(normalizeDomain("https://Login.Example.com:8443/path")).toBe("login.example.com");
  });

  it("covers subdomains and the registrable domain itself", () => {
    expect(originAllowed(["example.com"], "https://login.example.com/session")).toBe(true);
    expect(originAllowed(["example.com"], "https://example.com")).toBe(true);
    expect(originAllowed(["login.example.com"], "https://www.example.com")).toBe(true);
    expect(originAllowed(["*.example.com"], "https://a.example.com")).toBe(true);
  });

  it("keeps sites under a shared public suffix apart", () => {
    expect(originAllowed(["alice.github.io"], "https://alice.github.io/app")).toBe(true);
    expect(originAllowed(["alice.github.io"], "https://bob.github.io")).toBe(false);
    expect(originAllowed(["github.io"], "https://bob.github.io")).toBe(false);
    expect(originAllowed(["example.com"], "https://example.com.evil.net")).toBe(false);
    expect(originAllowed(["example.com"], "https://notexample.com")).toBe(false);
    expect(originAllowed(["example.co.uk"], "https://other.co.uk")).toBe(false);
  });

  it("types only into https pages, or http on localhost", () => {
    expect(originAllowed(["example.com"], "http://example.com")).toBe(false);
    expect(originAllowed(["localhost"], "http://localhost:3000/login")).toBe(true);
    expect(originAllowed(["127.0.0.1"], "http://127.0.0.1:8080")).toBe(true);
    expect(originAllowed(["::1"], "http://[::1]:5173")).toBe(true);
    expect(originAllowed(["localhost"], "http://127.0.0.1")).toBe(false);
    expect(originAllowed(["example.com"], "ftp://example.com")).toBe(false);
    expect(originAllowed(["example.com"], "javascript:alert(1)")).toBe(false);
    expect(originAllowed(["example.com"], "not a url")).toBe(false);
  });

  it("never allows an entry with no domains", () => {
    expect(originAllowed([], "https://example.com")).toBe(false);
    expect(originAllowed([], "http://localhost")).toBe(false);
  });
});
