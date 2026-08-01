import { describe, expect, it } from "vitest";

import { assertPublicHttpsUrl, blockedRangeForIp, SsrfError, type Resolver } from "../src/ssrf";

async function expectSsrf(promise: Promise<unknown>, code: SsrfError["code"]): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SsrfError);
  expect((err as SsrfError).code).toBe(code);
}

describe("assertPublicHttpsUrl", () => {
  it("rejects non-https schemes", async () => {
    await expectSsrf(assertPublicHttpsUrl("http://example.com/hook"), "not_https");
    await expectSsrf(assertPublicHttpsUrl("ftp://example.com/hook"), "not_https");
  });

  it("rejects unparseable URLs", async () => {
    await expectSsrf(assertPublicHttpsUrl("not a url"), "invalid_url");
  });

  it("rejects private and reserved IPv4 literals", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.5",
      "192.168.1.1",
      "0.0.0.0",
      "100.64.1.1",
      "192.0.2.10",
      "198.18.0.1",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      await expectSsrf(assertPublicHttpsUrl(`https://${ip}/hook`), "blocked_address");
    }
  });

  it("rejects the cloud metadata address", async () => {
    await expectSsrf(
      assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/"),
      "blocked_address",
    );
  });

  it("rejects private and reserved IPv6 literals", async () => {
    for (const ip of [
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "fec0::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "100::1",
      "2001:db8::1",
    ]) {
      await expectSsrf(assertPublicHttpsUrl(`https://[${ip}]/hook`), "blocked_address");
    }
  });

  it("rejects localhost-style and metadata hostnames without resolving", async () => {
    const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
    await expectSsrf(assertPublicHttpsUrl("https://localhost/hook", { resolve }), "blocked_host");
    await expectSsrf(assertPublicHttpsUrl("https://a.localhost/hook", { resolve }), "blocked_host");
    await expectSsrf(
      assertPublicHttpsUrl("https://metadata.google.internal/computeMetadata", { resolve }),
      "blocked_host",
    );
  });

  it("accepts public IP literals", async () => {
    const v4 = await assertPublicHttpsUrl("https://93.184.216.34/hook");
    expect(v4.pinnedAddress).toBe("93.184.216.34");
    const v6 = await assertPublicHttpsUrl("https://[2606:4700:4700::1111]/hook");
    expect(v6.addresses).toEqual(["2606:4700:4700::1111"]);
  });

  it("rejects hostnames that resolve to a private address", async () => {
    const resolve: Resolver = async () => [{ address: "10.1.2.3", family: 4 }];
    await expectSsrf(
      assertPublicHttpsUrl("https://internal.test/hook", { resolve }),
      "blocked_address",
    );
  });

  it("rejects when ANY resolved address is private (mixed answers)", async () => {
    const resolve: Resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.0.10", family: 4 },
    ];
    await expectSsrf(
      assertPublicHttpsUrl("https://rebind.test/hook", { resolve }),
      "blocked_address",
    );
  });

  it("rejects hostnames resolving to private IPv6", async () => {
    const resolve: Resolver = async () => [{ address: "fd00::5", family: 6 }];
    await expectSsrf(assertPublicHttpsUrl("https://ula.test/hook", { resolve }), "blocked_address");
  });

  it("accepts and pins hostnames that resolve public", async () => {
    const resolve: Resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const check = await assertPublicHttpsUrl("https://agent.test/hook", { resolve });
    expect(check.hostname).toBe("agent.test");
    expect(check.pinnedAddress).toBe("93.184.216.34");
    expect(check.addresses).toEqual(["93.184.216.34", "2606:4700:4700::1111"]);
  });

  it("maps resolver failures and empty answers to dns_failed", async () => {
    const failing: Resolver = async () => {
      throw new Error("NXDOMAIN");
    };
    await expectSsrf(
      assertPublicHttpsUrl("https://gone.test/", { resolve: failing }),
      "dns_failed",
    );
    const empty: Resolver = async () => [];
    await expectSsrf(assertPublicHttpsUrl("https://empty.test/", { resolve: empty }), "dns_failed");
  });
});

describe("blockedRangeForIp", () => {
  it("classifies public addresses as unblocked", () => {
    expect(blockedRangeForIp("8.8.8.8")).toBeNull();
    expect(blockedRangeForIp("2606:4700:4700::1111")).toBeNull();
    // IPv4-mapped form of a public address is allowed too
    expect(blockedRangeForIp("::ffff:8.8.8.8")).toBeNull();
  });

  it("classifies garbage as blocked", () => {
    expect(blockedRangeForIp("agent.test")).not.toBeNull();
  });

  it("names the range for blocked addresses", () => {
    expect(blockedRangeForIp("169.254.169.254")).toContain("metadata");
    expect(blockedRangeForIp("::ffff:192.168.0.1")).toContain("IPv4-mapped");
  });
});
