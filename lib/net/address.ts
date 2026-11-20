// 서버가 열어도 되는 주소인지 검사한다. 사설·로컬·예약 대역은 열지 않는다.
import net from 'node:net';

const blocked = new net.BlockList();

const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  // Azure가 플랫폼 내부 통신에 쓰는 주소
  ['168.63.129.16', 32],
];

const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

for (const [address, prefix] of V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of V6) blocked.addSubnet(address, prefix, 'ipv6');

/** 공개 인터넷의 주소면 true. IP 주소가 아니거나 막힌 대역이면 false */
export function isPublicAddress(address: string): boolean {
  let ip = address.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  // IPv4를 IPv6 꼴로 적은 주소는 IPv4로 풀어서 본다
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (family === 0) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
