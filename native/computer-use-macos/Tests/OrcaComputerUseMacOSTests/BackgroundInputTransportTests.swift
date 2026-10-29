import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class BackgroundInputTransportTests: XCTestCase {
    private let target = BackgroundInputTransport.Target(
        pid: 4242,
        windowID: 9001,
        windowFrame: CGRect(x: 300, y: 200, width: 520, height: 560)
    )

    func testMouseEventsNameTheWindowAndCarryAWindowLocalLocation() throws {
        try XCTSkipUnless(BackgroundInputTransport.isAvailable, "private symbols missing: \(BackgroundInputTransport.missingSymbols)")
        let point = CGPoint(x: 340, y: 275)
        for type in [CGEventType.leftMouseDown, .rightMouseUp, .otherMouseDown, .leftMouseDragged] {
            let event = try BackgroundInputTransport.mouseEvent(type, target: target, at: point, button: .left, clickState: 2, flags: .maskCommand)
            XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 51)!), 9001, "\(type)")
            XCTAssertEqual(try windowLocation(of: event), CGPoint(x: 40, y: 75), "\(type)")
            XCTAssertEqual(event.location, point)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 2)
            XCTAssertTrue(event.flags.contains(.maskCommand))
        }
    }

    func testChordKeysCarryOnlyKeyCodesAndFlags() throws {
        let events = try BackgroundInputTransport.chordEvents(keyCode: 0, modifiers: [(keyCode: 55, flag: .maskCommand)])
        XCTAssertEqual(events.map { $0.getIntegerValueField(.keyboardEventKeycode) }, [55, 0, 0, 55])
        XCTAssertEqual(events.map { $0.flags.contains(.maskCommand) }, [true, true, true, false])
    }

    func testTypedTextRidesTheKeyDownOnly() throws {
        let events = try BackgroundInputTransport.textEvents("hé")
        XCTAssertEqual(events.map { $0.type }, [.keyDown, .keyUp, .keyDown, .keyUp])
        XCTAssertEqual([events[0], events[2]].map(unicodeString), ["h", "é"])
        // Why: an unset string reads back as the layout's translation of key code 0, never the typed character.
        XCTAssertNotEqual(unicodeString(events[1]), "h")
        XCTAssertNotEqual(unicodeString(events[3]), "é")
    }

    private func windowLocation(of event: CGEvent) throws -> CGPoint {
        let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        let symbol = try XCTUnwrap(dlsym(skyLight, "CGEventGetWindowLocation"))
        typealias GetWindowLocation = @convention(c) (CGEvent) -> CGPoint
        // SAFETY: CGEventGetWindowLocation takes a CGEventRef and returns a CGPoint.
        return unsafeBitCast(symbol, to: GetWindowLocation.self)(event)
    }

    private func unicodeString(_ event: CGEvent) -> String {
        var length = 0
        var buffer = [UniChar](repeating: 0, count: 8)
        event.keyboardGetUnicodeString(maxStringLength: buffer.count, actualStringLength: &length, unicodeString: &buffer)
        return String(utf16CodeUnits: buffer, count: length)
    }
}
