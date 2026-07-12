import { describe, expect, test } from "bun:test";
import { assertPublicHost, isPrivateAddress, PrivateHostError } from "../src/tools/net-guard";

describe("isPrivateAddress", () => {
  test("IPv4 private/reserved ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "0.255.1.2",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.9.9",
      "127.0.0.1",
      "127.8.8.8",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "224.0.0.251",
      "240.1.2.3",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  test("IPv4 public addresses, including range edges", () => {
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.1.1",
      "169.255.1.1",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.1.1",
      "192.169.1.1",
      "223.255.255.255",
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  test("IPv6 private forms: loopback, unspecified, link-local, ULA, mapped", () => {
    for (const ip of [
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "fe80::1%en0",
      "febf::1",
      "fc00::1",
      "fdab:cdef::9",
      "::ffff:127.0.0.1",
      "::ffff:a00:1", // ::ffff:10.0.0.1 as the URL parser stores it
      "[::ffff:c0a8:101]", // ::ffff:192.168.1.1
      "ff02::1", // multicast, link-local scope
      "ff05::1:3", // multicast, site-local scope
      "ff0e::1", // multicast, global scope
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  test("IPv6 public forms, including mapped public IPv4", () => {
    for (const ip of ["2001:db8::1", "2606:4700:4700::1111", "::ffff:808:808", "fec0::1"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  test("unparseable input fails closed", () => {
    for (const ip of ["not-an-ip", "1.2.3", "1.2.3.4.5", "1.2.3.256", "::g", "12345::", ":::"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
});

describe("assertPublicHost", () => {
  const noDns = () => Promise.reject(new Error("DNS must not be consulted"));

  test("literal IPs are decided without DNS", async () => {
    await expect(assertPublicHost(new URL("http://127.0.0.1/x"), noDns)).rejects.toThrow(
      PrivateHostError,
    );
    await expect(assertPublicHost(new URL("http://[::1]/"), noDns)).rejects.toThrow(
      "private/loopback",
    );
    await expect(assertPublicHost(new URL("http://8.8.8.8/"), noDns)).resolves.toBeUndefined();
  });

  test("exotic literals normalized by the URL parser are caught", async () => {
    // 0x7f000001 → 127.0.0.1 and [::ffff:10.0.0.1] → [::ffff:a00:1] at parse.
    await expect(assertPublicHost(new URL("http://0x7f000001/"), noDns)).rejects.toThrow(
      PrivateHostError,
    );
    await expect(assertPublicHost(new URL("http://[::ffff:10.0.0.1]/"), noDns)).rejects.toThrow(
      PrivateHostError,
    );
  });

  test("one private record among many rejects, naming the address", async () => {
    const lookup = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
    await expect(assertPublicHost(new URL("http://mixed.example/"), lookup)).rejects.toThrow(
      "10.0.0.5",
    );
  });

  test("all-public records pass", async () => {
    const lookup = async () => [{ address: "93.184.216.34" }];
    await expect(assertPublicHost(new URL("http://ok.example/"), lookup)).resolves.toBeUndefined();
  });

  test("resolution failure fails closed as a plain (non-refusal) error", async () => {
    const failing = () => Promise.reject(new Error("boom"));
    const rejection = assertPublicHost(new URL("http://nope.invalid/"), failing);
    await expect(rejection).rejects.toThrow("cannot resolve host");
    await expect(
      assertPublicHost(new URL("http://nope.invalid/"), failing).catch((error) => {
        throw error instanceof PrivateHostError ? new Error("wrong class") : error;
      }),
    ).rejects.toThrow("cannot resolve host");
  });
});
