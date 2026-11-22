import AppKit
import Darwin
import Dispatch

protocol LeasePasteboard {
  associatedtype Item
  var changeCount: Int { get }
  func snapshot(maxBytes: Int) throws -> [Item]
  func clear() -> Int
  func write(_ items: [Item]) -> Bool
  func containsReplacement(_ token: UUID) -> Bool
}

struct PasteboardLease<Board: LeasePasteboard> {
  enum Restoration: String {
    case restored, preservedNewerContents = "preserved_newer_contents", failed
  }

  private let board: Board
  private let ownedCount: Int
  private var saved: [Board.Item]
  private var result: Restoration?

  static func start(on board: Board, replacement: Board.Item, token: UUID, canReplace: () -> Bool) -> Self? {
    let originalCount = board.changeCount
    guard let saved = try? board.snapshot(maxBytes: 64 * 1_024 * 1_024),
          canReplace(), board.changeCount == originalCount else { return nil }
    let cleared = board.clear()
    guard board.changeCount == cleared else { return nil }
    let written = board.write([replacement])
    let current = board.changeCount
    // Do not adopt an unrelated generation if another writer raced our write.
    // AppKit does not expose a generation from writeObjects or a CAS operation.
    let ours = board.containsReplacement(token) && board.changeCount == current
    if written && ours { return Self(board: board, ownedCount: current, saved: saved) }
    if ours || (!written && current == cleared && board.changeCount == cleared) {
      var partial = Self(board: board, ownedCount: current, saved: saved)
      _ = partial.finish()
    }
    return nil
  }

  mutating func finish() -> Restoration {
    if let result { return result }
    let restoration: Restoration
    if board.changeCount != ownedCount {
      restoration = .preservedNewerContents
    } else {
      let cleared = board.clear()
      if board.changeCount != cleared {
        restoration = .preservedNewerContents
      } else {
        restoration = saved.isEmpty || board.write(saved) ? .restored : .failed
      }
    }
    saved.removeAll()
    result = restoration
    return restoration
  }
}

private struct NativePasteboard: LeasePasteboard {
  let board: NSPasteboard
  var changeCount: Int { board.changeCount }

  private static let replacementType = NSPasteboard.PasteboardType("com.dotobokuri.fleet-console.paste-lease")
  private enum Failure: Error { case unreadable, tooLarge }

  static func replacement(text: String, html: String?, token: UUID) -> NSPasteboardItem? {
    let item = NSPasteboardItem()
    guard item.setString(text, forType: .string),
          item.setString(token.uuidString, forType: replacementType) else { return nil }
    if let html, !item.setString("<meta charset=\"utf-8\">\(html)", forType: .html) { return nil }
    return item
  }

  func snapshot(maxBytes: Int) throws -> [NSPasteboardItem] {
    guard let items = board.pasteboardItems else { throw Failure.unreadable }
    var bytes = 0
    return try items.map { source in
      let copy = NSPasteboardItem()
      for type in source.types {
        guard let data = source.data(forType: type) else { throw Failure.unreadable }
        guard data.count <= maxBytes - bytes else { throw Failure.tooLarge }
        bytes += data.count
        guard copy.setData(data, forType: type) else { throw Failure.unreadable }
      }
      return copy
    }
  }

  func clear() -> Int { board.clearContents() }
  func write(_ items: [NSPasteboardItem]) -> Bool { board.writeObjects(items) }
  func containsReplacement(_ token: UUID) -> Bool {
    guard let items = board.pasteboardItems, items.count == 1 else { return false }
    return items[0].string(forType: Self.replacementType) == token.uuidString
  }
}

@MainActor enum PasteboardLeaseCommand {
  private struct Payload: Decodable {
    let version: Int
    let text: String
    let html: String?
  }

  static func run() -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    let termination = PlatformTermination()
    let pipe = PlatformPipe(interrupted: { termination.requested })
    let prepareBy = PlatformPipe.deadline(after: 5)
    let leaseEnds = PlatformPipe.deadline(after: 100)
    let version = PlatformPipe.version
    let token = UUID()
    guard let frame = pipe.readFrame(maxBytes: 2_000_000, until: prepareBy),
          let payload = try? JSONDecoder().decode(Payload.self, from: frame), payload.version == version,
          let replacement = NativePasteboard.replacement(text: payload.text, html: payload.html, token: token),
          !termination.requested, !pipe.hasExtraInputOrEOF(), DispatchTime.now() < prepareBy,
          var lease = PasteboardLease.start(on: NativePasteboard(board: .general), replacement: replacement, token: token, canReplace: {
            !termination.requested && !pipe.hasExtraInputOrEOF() && DispatchTime.now() < prepareBy
          }) else {
      _ = PlatformPipe.emit(["version": version, "ready": false])
      return 1
    }

    // stdin stays open only while the caller owns the temporary contents.
    // EOF, unexpected extra input, TERM, and expiry all take the same finish path.
    if !termination.requested && !pipe.hasExtraInputOrEOF() && DispatchTime.now() < prepareBy,
       PlatformPipe.emit(["version": version, "ready": true]) {
      _ = pipe.canRead(until: leaseEnds)
    }
    let restoration = lease.finish()
    _ = PlatformPipe.emit(["version": version, "restoration": restoration.rawValue])
    return restoration == .failed ? 1 : 0
  }
}
