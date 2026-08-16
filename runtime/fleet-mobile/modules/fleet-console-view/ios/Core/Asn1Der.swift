import Foundation

// LocalTlsIdentity가 자체서명 X.509를 조립/파싱하기 위한 최소 ASN.1 DER 도구.
// 인코더(Der)와, matches가 SAN/유효기간/leaf를 읽기 위한 파서(CertFields).

enum Der {
  // OID들은 06 태그를 포함한 완전한 TLV 바이트로 보관한다.
  enum OID {
    static let ecPublicKey: [UInt8] = [0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
    static let prime256v1: [UInt8] = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07]
    static let ecdsaWithSHA256: [UInt8] = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
    static let commonName: [UInt8] = [0x06, 0x03, 0x55, 0x04, 0x03]
    static let basicConstraints: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x13]
    static let keyUsage: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x0F]
    static let subjectAltName: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x11]
  }

  static func length(_ n: Int) -> [UInt8] {
    if n < 0x80 { return [UInt8(n)] }
    var bytes: [UInt8] = []
    var value = n
    while value > 0 { bytes.insert(UInt8(value & 0xff), at: 0); value >>= 8 }
    return [0x80 | UInt8(bytes.count)] + bytes
  }

  static func tlv(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] { [tag] + length(content.count) + content }

  static func sequence(_ content: [UInt8]) -> [UInt8] { tlv(0x30, content) }
  static func set(_ content: [UInt8]) -> [UInt8] { tlv(0x31, content) }
  static func integer(_ bytes: [UInt8]) -> [UInt8] { tlv(0x02, bytes) }
  static func octetString(_ content: [UInt8]) -> [UInt8] { tlv(0x04, content) }
  static func boolean(_ b: Bool) -> [UInt8] { tlv(0x01, [b ? 0xFF : 0x00]) }
  static func bitString(_ content: [UInt8]) -> [UInt8] { tlv(0x03, [0x00] + content) } // 0 unused bits
  static func utf8String(_ s: String) -> [UInt8] { tlv(0x0C, Array(s.utf8)) }
  static func explicit(_ tagNum: UInt8, _ content: [UInt8]) -> [UInt8] { tlv(0xA0 | tagNum, content) }

  // 양의 정수: 선행 0 정리 후 최상위 비트가 1이면 0x00을 앞에 붙인다.
  static func integerPositive(_ raw: [UInt8]) -> [UInt8] {
    var bytes = raw
    while bytes.count > 1 && bytes.first == 0x00 { bytes.removeFirst() }
    if let first = bytes.first, first & 0x80 != 0 { bytes.insert(0x00, at: 0) }
    if bytes.isEmpty { bytes = [0x00] }
    return integer(bytes)
  }

  static func utcTime(_ date: Date) -> [UInt8] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyMMddHHmmss'Z'"
    return tlv(0x17, Array(formatter.string(from: date).utf8))
  }

  static func algIdentifier(_ oid: [UInt8]) -> [UInt8] { sequence(oid) } // ECDSA: 파라미터 없음

  static func name(commonName host: String) -> [UInt8] {
    // Name = SEQUENCE OF RDN; RDN = SET OF ATV; ATV = SEQUENCE { OID, UTF8String }
    sequence(set(sequence(OID.commonName + utf8String(host))))
  }

  static func subjectPublicKeyInfoEC(point: [UInt8]) -> [UInt8] {
    sequence(sequence(OID.ecPublicKey + OID.prime256v1) + bitString(point))
  }

  static func extensionEntry(oid: [UInt8], critical: Bool, value: [UInt8]) -> [UInt8] {
    // Extension = SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
    sequence(oid + (critical ? boolean(true) : []) + octetString(value))
  }

  static func keyUsageDigitalSignature() -> [UInt8] {
    // KeyUsage BIT STRING, digitalSignature = bit 0(MSB) → 0x80, unused bits 7. TLV: 03 02 07 80.
    [0x03, 0x02, 0x07, 0x80]
  }

  static func subjectAltNameIP(_ ip: [UInt8]) -> [UInt8] {
    // GeneralNames = SEQUENCE { [7] IMPLICIT OCTET STRING (iPAddress) }; [7] primitive = 0x87.
    sequence([0x87] + length(ip.count) + ip)
  }
}

// matches가 읽는 인증서 필드. iOS엔 SecCertificateCopyValues가 없으므로 DER을 직접 파싱한다.
struct CertFields {
  let notBefore: Date?
  let notAfter: Date?
  let isLeaf: Bool
  let ipSans: [[UInt8]]
  let dnsSans: [String]

  private struct TLV { let tag: UInt8; let content: [UInt8]; let end: Int }

  private static func read(_ bytes: [UInt8], _ start: Int) -> TLV? {
    guard start >= 0, start + 1 < bytes.count else { return nil }
    let tag = bytes[start]
    var i = start + 1
    let first = bytes[i]; i += 1
    var len = 0
    if first < 0x80 {
      len = Int(first)
    } else {
      let n = Int(first & 0x7f)
      guard n >= 1, n <= 4, i + n <= bytes.count else { return nil }
      for _ in 0..<n { len = (len << 8) | Int(bytes[i]); i += 1 }
    }
    guard i + len <= bytes.count else { return nil }
    return TLV(tag: tag, content: Array(bytes[i..<(i + len)]), end: i + len)
  }

  // 한 SEQUENCE/SET의 자식 TLV들을 순서대로 읽는다.
  private static func children(_ content: [UInt8]) -> [TLV] {
    var result: [TLV] = []
    var offset = 0
    while offset < content.count {
      guard let tlv = read(content, offset) else { break }
      result.append(tlv)
      offset = tlv.end
    }
    return result
  }

  static func parse(_ der: [UInt8]) -> CertFields? {
    guard let cert = read(der, 0), cert.tag == 0x30 else { return nil }        // Certificate
    guard let tbs = read(cert.content, 0), tbs.tag == 0x30 else { return nil } // TBSCertificate
    let fields = children(tbs.content)
    // v3 인증서 순서: [0]version, serial, sigAlg, issuer, validity, subject, spki, [3]extensions
    var idx = 0
    if idx < fields.count, fields[idx].tag == 0xA0 { idx += 1 } // version(optional)
    guard idx + 5 < fields.count else { return nil }
    idx += 1 // serial
    idx += 1 // sigAlg
    idx += 1 // issuer
    let validity = fields[idx]; idx += 1
    idx += 1 // subject
    idx += 1 // spki
    // 나머지 중 [3] 태그가 extensions.
    let extensionsField = fields[idx...].first { $0.tag == 0xA3 }

    let (notBefore, notAfter) = parseValidity(validity)
    var isLeaf = true
    var ipSans: [[UInt8]] = []
    var dnsSans: [String] = []
    if let extensionsField, let extSeq = read(extensionsField.content, 0), extSeq.tag == 0x30 {
      for ext in children(extSeq.content) where ext.tag == 0x30 {
        let parts = children(ext.content)
        guard let oid = parts.first, oid.tag == 0x06 else { continue }
        // extnValue = 마지막 OCTET STRING.
        guard let octet = parts.last(where: { $0.tag == 0x04 }) else { continue }
        if oid.content == Array(Der.OID.basicConstraints.dropFirst(2)) {
          isLeaf = !basicConstraintsIsCA(octet.content)
        } else if oid.content == Array(Der.OID.subjectAltName.dropFirst(2)) {
          let (ips, dns) = parseSans(octet.content)
          ipSans.append(contentsOf: ips)
          dnsSans.append(contentsOf: dns)
        }
      }
    }
    return CertFields(notBefore: notBefore, notAfter: notAfter, isLeaf: isLeaf, ipSans: ipSans, dnsSans: dnsSans)
  }

  private static func parseValidity(_ validity: TLV) -> (Date?, Date?) {
    guard validity.tag == 0x30 else { return (nil, nil) }
    let times = children(validity.content)
    guard times.count >= 2 else { return (nil, nil) }
    return (parseTime(times[0]), parseTime(times[1]))
  }

  private static func parseTime(_ tlv: TLV) -> Date? {
    guard let text = String(bytes: tlv.content, encoding: .ascii) else { return nil }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    if tlv.tag == 0x17 { // UTCTime yyMMddHHmmssZ
      formatter.dateFormat = "yyMMddHHmmss'Z'"
    } else if tlv.tag == 0x18 { // GeneralizedTime yyyyMMddHHmmssZ
      formatter.dateFormat = "yyyyMMddHHmmss'Z'"
    } else {
      return nil
    }
    return formatter.date(from: text)
  }

  // basicConstraints extnValue(OCTET STRING content) = SEQUENCE { cA BOOLEAN DEFAULT FALSE, ... }
  private static func basicConstraintsIsCA(_ octetContent: [UInt8]) -> Bool {
    guard let seq = read(octetContent, 0), seq.tag == 0x30 else { return false }
    for child in children(seq.content) where child.tag == 0x01 {
      return child.content.first == 0xFF
    }
    return false
  }

  // SAN extnValue(OCTET STRING content) = SEQUENCE OF GeneralName.
  // iPAddress = [7] primitive(0x87), dNSName = [2] primitive(0x82, IA5String content).
  private static func parseSans(_ octetContent: [UInt8]) -> (ip: [[UInt8]], dns: [String]) {
    guard let seq = read(octetContent, 0), seq.tag == 0x30 else { return ([], []) }
    var ip: [[UInt8]] = []
    var dns: [String] = []
    for name in children(seq.content) {
      if name.tag == 0x87 { ip.append(name.content) }
      else if name.tag == 0x82, let s = String(bytes: name.content, encoding: .ascii) { dns.append(s) }
    }
    return (ip, dns)
  }
}
