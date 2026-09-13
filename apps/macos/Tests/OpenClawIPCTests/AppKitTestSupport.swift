import AppKit
import ApplicationServices
import Testing
import XCTest

@MainActor
enum AppKitTestSupport {
    /// Rendered suites share one process and must initialize AppKit only once.
    static let application: NSApplication = {
        let application = NSApplication.shared
        #expect(application.setActivationPolicy(.accessory))
        application.finishLaunching()
        return application
    }()

    static func accessibilityElements(in root: AnyObject) async throws -> [AnyObject] {
        // SwiftUI materializes its virtual accessibility children after a real client request.
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
        }.value
        try #require(result == .success)
        var elements: [AnyObject] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ element: AnyObject) {
            guard visited.insert(ObjectIdentifier(element)).inserted else { return }
            elements.append(element)
            for child in element.accessibilityChildren?() ?? [] {
                visit(child as AnyObject)
            }
        }
        visit(root)
        return elements
    }

    static func pressMenu(
        _ button: AnyObject,
        file: StaticString = #filePath,
        line: UInt = #line,
        inspect: @escaping (NSMenu) throws -> Void) throws
    {
        let tracking = AppKitTestMenuTracking(inspect: inspect)
        tracking.start()
        defer { tracking.stop() }
        XCTAssertTrue(button.accessibilityPerformPress?() == true, file: file, line: line)
        XCTAssertTrue(
            tracking.observed,
            "Pressing the rendered control must open its native menu",
            file: file,
            line: line)
        XCTAssertFalse(
            tracking.timedOut,
            "The menu must finish before its tracking deadline",
            file: file,
            line: line)
        if let error = tracking.error { throw error }
    }
}

@MainActor
private final class AppKitTestMenuTracking: NSObject {
    let inspect: (NSMenu) throws -> Void
    private(set) var observed = false
    private(set) var timedOut = false
    private(set) var error: Error?
    private var menu: NSMenu?
    private var inspection: Timer?
    private var deadline: Timer?

    init(inspect: @escaping (NSMenu) throws -> Void) {
        self.inspect = inspect
    }

    func start() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.beganTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
    }

    @objc private func beganTracking(_ notification: Notification) {
        guard !self.observed, let menu = notification.object as? NSMenu else { return }
        self.observed = true
        self.menu = menu
        // AppKit tracks menus in a nested run loop. Schedule both inspection and cancellation there.
        let inspection = Timer(
            timeInterval: 0,
            target: self,
            selector: #selector(self.inspectMenu),
            userInfo: nil,
            repeats: false)
        let deadline = Timer(
            timeInterval: 3,
            target: self,
            selector: #selector(self.expire),
            userInfo: nil,
            repeats: false)
        self.inspection = inspection
        self.deadline = deadline
        for timer in [inspection, deadline] {
            RunLoop.main.add(timer, forMode: .eventTracking)
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    @objc private func inspectMenu() {
        guard let menu = self.menu else { return }
        defer { menu.cancelTrackingWithoutAnimation() }
        do { try self.inspect(menu) } catch { self.error = error }
    }

    @objc private func expire() {
        self.timedOut = true
        self.menu?.cancelTrackingWithoutAnimation()
    }

    func stop() {
        self.inspection?.invalidate()
        self.deadline?.invalidate()
        self.menu?.cancelTrackingWithoutAnimation()
        NotificationCenter.default.removeObserver(self)
    }
}
