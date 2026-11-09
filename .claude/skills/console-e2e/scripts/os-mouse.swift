import CoreGraphics
import Foundation

// One left-button down/up at a global point, for os-mouse.mjs click only.
// post(tap:) returns Void, so exiting 0 means the calls returned, not that
// the event was delivered or that any control reacted. This file does not
// check the screen lock, Accessibility, or the window under the point.

guard CommandLine.arguments.count == 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]),
      x.isFinite, y.isFinite else {
    fputs("os-mouse: expected two finite coordinates\n", stderr)
    exit(1)
}

let point = CGPoint(x: x, y: y)
guard let down = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
      ),
      let up = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
      ) else {
    fputs("os-mouse: could not create the mouse events\n", stderr)
    exit(1)
}

down.post(tap: .cghidEventTap)
up.post(tap: .cghidEventTap)
