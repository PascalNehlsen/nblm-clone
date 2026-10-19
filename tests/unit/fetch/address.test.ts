// C2 URL import: isBlockedAddress is the address half of the SSRF guard.
// See .git/C2-API-SPEC.md ("address.ts") and ADR 0008: IPv4 special-purpose ranges
// are blocked, for IPv6 only 2000::/3 minus a few sub-ranges is allowed, anything
// that net.isIP() rejects is blocked. Ranges are blocked whole (first, middle, last).
import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "@/lib/server/fetch/address";

const blockedV4: Array<[string, string[]]> = [
  ["0.0.0.0/8", ["0.0.0.0", "0.1.2.3", "0.255.255.255"]],
  ["10.0.0.0/8", ["10.0.0.0", "10.128.0.1", "10.255.255.255"]],
  ["100.64.0.0/10", ["100.64.0.0", "100.100.100.200", "100.127.255.255"]],
  ["127.0.0.0/8", ["127.0.0.0", "127.0.0.1", "127.255.255.255"]],
  ["169.254.0.0/16", ["169.254.0.0", "169.254.169.254", "169.254.170.2", "169.254.255.255"]],
  ["172.16.0.0/12", ["172.16.0.0", "172.20.1.1", "172.31.255.255"]],
  ["192.0.0.0/24", ["192.0.0.0", "192.0.0.128", "192.0.0.255"]],
  ["192.0.2.0/24", ["192.0.2.0", "192.0.2.128", "192.0.2.255"]],
  ["192.88.99.0/24", ["192.88.99.0", "192.88.99.128", "192.88.99.255"]],
  ["192.168.0.0/16", ["192.168.0.0", "192.168.1.1", "192.168.255.255"]],
  ["198.18.0.0/15", ["198.18.0.0", "198.19.0.1", "198.19.255.255"]],
  ["198.51.100.0/24", ["198.51.100.0", "198.51.100.128", "198.51.100.255"]],
  ["203.0.113.0/24", ["203.0.113.0", "203.0.113.128", "203.0.113.255"]],
  ["224.0.0.0/4", ["224.0.0.0", "230.1.1.1", "239.255.255.255"]],
  ["240.0.0.0/4", ["240.0.0.0", "250.1.1.1", "255.255.255.255"]],
];

const blockedV6: Array<[string, string[]]> = [
  ["2001::/23 (includes Teredo)", [
    "2001::",
    "2001:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
  ]],
  ["2001:db8::/32", ["2001:db8::", "2001:db8:1::1", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["2002::/16 (6to4)", ["2002::", "2002:7f00:1::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["3fff::/20", ["3fff::", "3fff:800::1", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["5f00::/16", ["5f00::", "5f00:1::1", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["unspecified and loopback", ["::", "0:0:0:0:0:0:0:0", "::1", "0:0:0:0:0:0:0:1"]],
  ["IPv4-mapped, any notation, even to a public IPv4", [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::FFFF:7F00:1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
  ]],
  ["IPv4-compatible ::/96", ["::127.0.0.1", "::7f00:1", "::8.8.8.8"]],
  ["NAT64", ["64:ff9b::a9fe:a9fe", "64:ff9b::1", "64:ff9b::8.8.8.8", "64:ff9b:1::1", "64:ff9b:1:ffff::1"]],
  ["discard 100::/64", ["100::", "100::1", "100::ffff:ffff:ffff:ffff"]],
  ["unique local fc00::/7 (includes AWS IPv6 metadata)", [
    "fc00::",
    "fd00:ec2::254",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ]],
  ["link-local fe80::/10", ["fe80::", "fe80::1", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["site-local fec0::/10", ["fec0::", "fec0::1", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["multicast ff00::/8", ["ff00::", "ff02::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["everything outside 2000::/3", ["4000::1", "8000::1", "c000::1", "e000::1", "1fff:ffff::1"]],
];

describe("isBlockedAddress: IPv4 special-purpose ranges", () => {
  for (const [range, addresses] of blockedV4) {
    it(`blocks ${range}`, () => {
      for (const address of addresses) {
        expect(isBlockedAddress(address), address).toBe(true);
      }
    });
  }

  it("allows public addresses and the neighbours just outside each range", () => {
    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.215.14",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
    ];
    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("isBlockedAddress: IPv6", () => {
  for (const [range, addresses] of blockedV6) {
    it(`blocks ${range}`, () => {
      for (const address of addresses) {
        expect(isBlockedAddress(address), address).toBe(true);
      }
    });
  }

  it("allows global unicast addresses outside the blocked sub-ranges", () => {
    const allowed = [
      "2606:4700::1111",
      "2a00:1450:4001:81b::200e",
      "2001:4860:4860::8888",
      "2001:200::1",
      "2001:db9::1",
      "2003::1",
      "3fff:1000::1",
    ];
    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("isBlockedAddress: the named metadata and rebinding targets", () => {
  it("blocks every cloud metadata address", () => {
    for (const address of ["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });
});

describe("isBlockedAddress: garbage input fails closed", () => {
  it("blocks anything net.isIP() rejects", () => {
    const garbage = [
      "",
      " ",
      "abc",
      "example.com",
      "1.2.3",
      "256.1.1.1",
      "127.1",
      "0x7f.0.0.1",
      "2130706433",
      "1.1.1.1/8",
      " 8.8.8.8",
      "8.8.8.8\n",
      "[::1]",
      "fe80::1%eth0",
      "::g",
    ];
    for (const input of garbage) {
      expect(isBlockedAddress(input), JSON.stringify(input)).toBe(true);
    }
  });
});
