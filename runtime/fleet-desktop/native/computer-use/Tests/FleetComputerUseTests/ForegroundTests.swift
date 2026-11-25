import Carbon
import CoreGraphics
import Testing
@testable import FleetComputerUse

struct ForegroundTests {
  private let own = ForegroundRoute(pid: 100, window: 4778, frame: CGRect(x: 0, y: 0, width: 500, height: 400))

  @Test func routesToTheRemotePanelServiceOnlyWhenAnotherProcessOwnsTheWindow() {
    let panel = CGRect(x: 10, y: 20, width: 300, height: 200)
    #expect(Foreground.remote(own, owner: 200, window: 4780, frame: panel) == ForegroundRoute(pid: 200, window: 4780, frame: panel))
    #expect(Foreground.remote(own, owner: 100, window: 4790, frame: panel) == own)
    #expect(Foreground.remote(own, owner: 0, window: 4780, frame: panel) == own)
    #expect(Foreground.remote(own, owner: 200, window: 4780, frame: .zero) == own)
  }

  @Test func mapsDeleteToTheMacBackspaceKey() throws {
    #expect(try KeyStroke("cmd+delete").code == CGKeyCode(kVK_Delete))
    #expect(try KeyStroke("forwarddelete").code == CGKeyCode(kVK_ForwardDelete))
  }

  @Test func typesUSLayoutASCIIAndRefusesEverythingElse() throws {
    let keys = try #require(Foreground.asciiKeys("aZ!\n"))
    #expect(keys.map(\.code) == [kVK_ANSI_A, kVK_ANSI_Z, kVK_ANSI_1, kVK_Return].map { CGKeyCode($0) })
    #expect(keys.map(\.flags) == [[], .maskShift, .maskShift, []])
    #expect(Foreground.asciiKeys("한") == nil)
    #expect(Foreground.asciiKeys("é") == nil)
  }
}
