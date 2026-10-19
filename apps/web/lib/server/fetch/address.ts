import "server-only";

import { BlockList, isIP } from "node:net";

// The address check of the SSRF guard (ADR 0008). Ranges are blocked whole, never decoded
// to an embedded IPv4, so every unclear case fails closed.

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT, includes 100.100.100.200 (Alibaba metadata)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes 169.254.169.254 and 169.254.170.2
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

// IPv6: only global unicast (2000::/3) is allowed, minus these special ranges inside it.
// Everything else (loopback, IPv4-mapped, NAT64, unique local incl. fd00:ec2::254,
// link-local, multicast, ...) lies outside 2000::/3 and is blocked by that rule.
const BLOCKED_V6_IN_GLOBAL: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6
];

const blockedV4 = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

const blockedV6 = new BlockList();
for (const [net, prefix] of BLOCKED_V6_IN_GLOBAL) blockedV6.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.includes("%")) return true; // zone ids are never allowed
  try {
    const family = isIP(ip);
    if (family === 4) return blockedV4.check(ip, "ipv4");
    if (family === 6) return !globalV6.check(ip, "ipv6") || blockedV6.check(ip, "ipv6");
    return true;
  } catch {
    return true;
  }
}
