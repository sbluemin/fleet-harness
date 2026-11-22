import Foundation
import Testing
@testable import FleetComputerUse

struct PasteboardLeaseTests {
  @Test func restoresAllRepresentationsAndFinishesOnlyOnce() throws {
    let original = [Item(types: ["text": Data([1]), "png": Data([0, 255])]), Item(types: ["custom": Data([2])])]
    let board = FakePasteboard(original)
    let token = UUID()
    var lease = try #require(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { true }))
    #expect(board.items == [Item(token: token)])
    #expect(lease.finish() == .restored)
    #expect(board.items == original)
    let newer = [Item(types: ["other": Data([7])])]
    board.copy(newer)
    #expect(lease.finish() == .restored)
    #expect(board.items == newer)
  }

  @Test func doesNotOverwriteAConcurrentCopy() throws {
    let original = [Item(types: ["text": Data([1])])]
    let newer = [Item(types: ["text": Data([2])])]
    let board = FakePasteboard(original)
    let token = UUID()
    var lease = try #require(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { true }))
    board.copy(newer)
    #expect(lease.finish() == .preservedNewerContents)
    #expect(board.items == newer)

    board.afterWrite = { board.copy(newer) }
    #expect(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { true }) == nil)
    #expect(board.items == newer)
  }

  @Test func preparationFailureDoesNotLeaveAnOwnedReplacement() {
    let original = [Item(types: ["text": Data([1])])]
    let board = FakePasteboard(original)
    let token = UUID()
    board.rejectSnapshot = true
    #expect(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { true }) == nil)
    #expect(board.changeCount == 0)

    board.rejectSnapshot = false
    #expect(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { false }) == nil)
    #expect(board.changeCount == 0)

    board.rejectNextWrite = true
    #expect(PasteboardLease.start(on: board, replacement: Item(token: token), token: token, canReplace: { true }) == nil)
    #expect(board.items == original)
  }
}

private struct Item: Equatable {
  var types: [String: Data] = [:]
  var token: UUID? = nil
}

private final class FakePasteboard: LeasePasteboard {
  private enum Failure: Error { case unavailable }
  private(set) var items: [Item]
  private(set) var changeCount = 0
  var rejectSnapshot = false
  var rejectNextWrite = false
  var afterWrite: (() -> Void)?

  init(_ items: [Item]) { self.items = items }
  func snapshot(maxBytes: Int) throws -> [Item] {
    if rejectSnapshot { throw Failure.unavailable }
    return items
  }
  func clear() -> Int {
    copy([])
    return changeCount
  }
  func write(_ items: [Item]) -> Bool {
    if rejectNextWrite { rejectNextWrite = false; return false }
    copy(items)
    let callback = afterWrite
    afterWrite = nil
    callback?()
    return true
  }
  func containsReplacement(_ token: UUID) -> Bool { items.count == 1 && items[0].token == token }
  func copy(_ items: [Item]) { self.items = items; changeCount += 1 }
}
