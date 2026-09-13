import AppKit
import ApplicationServices
import Testing

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

    static func waitForAccessibilityElement(
        in window: NSWindow,
        description: String,
        matching find: ([AnyObject]) -> AnyObject?) async throws -> AnyObject
    {
        let deadline = ContinuousClock.now + .seconds(3)
        var observedElements: [AnyObject] = []
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            let elements = try await self.accessibilityElements(in: window)
            observedElements = elements
            if let element = find(elements) {
                return element
            }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        let toolbarItems = (window.toolbar?.items ?? []).map {
            "\($0.itemIdentifier.rawValue): view=\(String(describing: $0.view))"
        }.joined(separator: "\n")
        let accessibility = observedElements.map {
            let role = String(describing: $0.accessibilityRole?())
            let title = String(describing: $0.accessibilityTitle?())
            let label = String(describing: $0.accessibilityLabel?())
            let value = String(describing: $0.accessibilityValue?())
            let identifier = String(describing: $0.accessibilityIdentifier?())
            return "role=\(role) title=\(title) label=\(label) value=\(value) identifier=\(identifier)"
        }.joined(separator: "\n")
        throw InteractionFailure(message: """
        The rendered window must expose \(description)
        appActive=\(NSApp.isActive) windowVisible=\(window.isVisible) windowKey=\(window.isKeyWindow)
        Toolbar items:
        \(toolbarItems)
        Accessibility elements:
        \(accessibility)
        """)
    }

    static func pressMenu(
        _ button: AnyObject,
        inspect: @escaping (NSMenu) throws -> Void) throws
    {
        let tracking = AppKitTestMenuTracking(inspect: inspect)
        tracking.start()
        defer { tracking.stop() }
        guard button.accessibilityPerformPress?() == true else {
            throw InteractionFailure(message: "The rendered control rejected the accessibility press")
        }
        guard tracking.observed else {
            throw InteractionFailure(message: "Pressing the rendered control must open its native menu")
        }
        guard !tracking.timedOut else {
            throw InteractionFailure(message: "The menu must finish before its tracking deadline")
        }
        if let error = tracking.error { throw error }
    }

    private struct InteractionFailure: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
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
