import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * A certificate authority for proxy mode, as Zyte has one: to apply bans, retries and providers
 * to HTTPS traffic, the proxy must read it, so it presents a certificate for each site signed by
 * this CA, which clients are told to trust. Built with node:crypto (P-256 keys, ECDSA-SHA256) and a
 * minimal DER encoder, no dependencies.
 */
export interface CertificateAuthority {
  /** PEM certificate: what clients install (curl --cacert, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE…). */
  cert: string;
  /** PEM private key: keep it secret; anyone holding it can impersonate sites to those clients. */
  key: string;
}

// --- DER ---------------------------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (content: Buffer) => tlv(0x04, content);
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
/** UTCTime (YYMMDDHHMMSSZ), valid until 2049. */
function time(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${s}Z`, 'ascii'));
}
const bitString = (content: Buffer) => tlv(0x03, Buffer.from([0]), content);

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const name = (commonName: string) =>
  seq(set(seq(oid(OID.organization), utf8('xyte'))), set(seq(oid(OID.commonName), utf8(commonName))));

const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/** keyUsage bits, first byte (digitalSignature = 0x80 … keyCertSign = 0x04, cRLSign = 0x02). */
const keyUsage = (bits: number) => tlv(0x03, Buffer.from([1, bits]));

function certificate(options: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  days: number;
  extensions: Buffer[];
}): string {
  const notBefore = new Date(Date.now() - 86_400_000);
  const notAfter = new Date(Date.now() + options.days * 86_400_000);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const algorithm = seq(oid(OID.ecdsaWithSha256));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name(options.issuer),
    seq(time(notBefore), time(notAfter)),
    name(options.subject),
    options.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...options.extensions)),
  );
  const signature = sign('sha256', tbs, options.signingKey);
  const der = seq(tbs, algorithm, bitString(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** A new CA (10 years). Keep it: clients trust this one certificate. */
export function createCertificateAuthority(commonName = 'xyte proxy CA'): CertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = certificate({
    subject: commonName,
    issuer: commonName,
    publicKey,
    signingKey: privateKey,
    days: 3650,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true))),
      extension(OID.keyUsage, true, keyUsage(0x04 | 0x02)),
    ],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** A certificate for `host` (a name or an IP), signed by the CA, valid for a year. */
export function issueCertificate(ca: CertificateAuthority, host: string): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caName = /CN=([^,\n]+)/.exec(new X509Certificate(ca.cert).subject)?.[1] ?? 'xyte proxy CA';
  const ip = isIP(host);
  const altName = ip
    ? tlv(0x87, ip === 4 ? Buffer.from(host.split('.').map(Number)) : ipv6Bytes(host))
    : tlv(0x82, Buffer.from(host, 'ascii'));
  const cert = certificate({
    subject: host,
    issuer: caName,
    publicKey,
    signingKey: createPrivateKey(ca.key),
    days: 365,
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, keyUsage(0x80)),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, seq(altName)),
    ],
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::');
  const part = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const left = part(head!);
  const right = address.includes('::') ? part(tail) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return Buffer.from(groups.flatMap((g) => [g >> 8, g & 0xff]));
}
