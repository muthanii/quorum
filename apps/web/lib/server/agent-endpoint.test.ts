import { describe, expect, it } from "vitest";

import { AgentEndpointError, assertSaneAgentEndpoint } from "./agent-endpoint";

describe("assertSaneAgentEndpoint", () => {
  it("accepts a public https URL", () => {
    const url = assertSaneAgentEndpoint("https://agents.example.com/hooks/quorum");
    expect(url.hostname).toBe("agents.example.com");
  });

  it("rejects non-https schemes", () => {
    expect(() => assertSaneAgentEndpoint("http://agents.example.com/hook")).toThrow(
      AgentEndpointError,
    );
    expect(() => assertSaneAgentEndpoint("ftp://agents.example.com")).toThrow(AgentEndpointError);
  });

  it("rejects invalid URLs", () => {
    expect(() => assertSaneAgentEndpoint("not a url")).toThrow(AgentEndpointError);
  });

  it("rejects embedded credentials", () => {
    expect(() => assertSaneAgentEndpoint("https://user:pass@example.com/hook")).toThrow(
      AgentEndpointError,
    );
  });

  it("rejects localhost and internal-looking hostnames", () => {
    for (const hostname of [
      "localhost",
      "api.localhost",
      "printer.local",
      "vault.internal",
      "router.home.arpa",
      "metadata.google.internal",
    ]) {
      expect(() => assertSaneAgentEndpoint(`https://${hostname}/hook`)).toThrow(AgentEndpointError);
    }
  });

  it("rejects private, loopback, link-local, CGNAT, and metadata IPv4 literals", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.254",
    ]) {
      expect(() => assertSaneAgentEndpoint(`https://${ip}/hook`)).toThrow(AgentEndpointError);
    }
  });

  it("accepts public IPv4 literals and boundary neighbors of blocked ranges", () => {
    for (const ip of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "11.0.0.1"]) {
      expect(assertSaneAgentEndpoint(`https://${ip}/hook`).hostname).toBe(ip);
    }
  });

  it("rejects IPv6 literals at this layer", () => {
    expect(() => assertSaneAgentEndpoint("https://[::1]/hook")).toThrow(AgentEndpointError);
    expect(() => assertSaneAgentEndpoint("https://[fd00::1]/hook")).toThrow(AgentEndpointError);
  });
});
