import AppKit
import Foundation
import OpenClawChatUI
import SwiftUI
import XCTest
@testable import OpenClaw

@MainActor
final class WebChatProfilePreferencesTests: XCTestCase {
    func testThreadMenuUpdatesOnlyItsProfilePreferences() async throws {
        let reasoningKey = OpenClawChatWindowShell.assistantReasoningDefaultsKey
        let toolActivityKey = OpenClawChatWindowShell.assistantToolActivityDefaultsKey
        for (title, key, otherTitle, otherKey) in [
            ("Show Reasoning", reasoningKey, "Show Tool Activity", toolActivityKey),
            ("Show Tool Activity", toolActivityKey, "Show Reasoning", reasoningKey),
        ] {
            try await TestIsolation.withIsolatedState {
                let profile = AppProfile(environment: [
                    "OPENCLAW_PROFILE": "chat-preferences-\(UUID().uuidString.lowercased())",
                ])
                let suiteName = try XCTUnwrap(profile.defaultsSuiteName)
                let ownerDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
                defer { ownerDefaults.removePersistentDomain(forName: suiteName) }

                let defaultDefaults = UserDefaults.standard
                let originalValues = [reasoningKey, toolActivityKey].map {
                    ($0, defaultDefaults.object(forKey: $0))
                }
                defer {
                    for (key, value) in originalValues {
                        if let value {
                            defaultDefaults.set(value, forKey: key)
                        } else {
                            defaultDefaults.removeObject(forKey: key)
                        }
                    }
                }
                defaultDefaults.set(true, forKey: reasoningKey)
                defaultDefaults.set(true, forKey: toolActivityKey)
                ownerDefaults.set(true, forKey: key)
                ownerDefaults.set(false, forKey: otherKey)

                _ = AppKitTestSupport.application
                let viewModel = OpenClawChatViewModel(
                    sessionKey: "agent:fixture:main",
                    transport: ProfilePreferencesTransport())
                let controller = NSHostingController(rootView: ProfilePreferencesOwner(
                    viewModel: viewModel,
                    defaults: ownerDefaults))
                let window = NSWindow(
                    contentRect: NSRect(x: 0, y: 0, width: 960, height: 700),
                    styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                    backing: .buffered,
                    defer: false)
                window.isReleasedWhenClosed = false
                window.title = "Profile chat preferences fixture"
                window.contentViewController = controller
                controller.sceneBridgingOptions = [.toolbars]
                defer {
                    viewModel.detachTransport()
                    window.orderOut(nil)
                    window.contentViewController = nil
                    window.contentView = nil
                    window.close()
                }
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                controller.view.layoutSubtreeIfNeeded()

                let button = try await self.threadMenuButton(in: window)
                try AppKitTestSupport.pressMenu(button) { menu in
                    let index = try XCTUnwrap(menu.items.firstIndex { $0.title == title })
                    let other = try XCTUnwrap(menu.items.first { $0.title == otherTitle })
                    XCTAssertTrue(menu.items[index].isEnabled)
                    XCTAssertEqual(menu.items[index].state, .on)
                    XCTAssertEqual(other.state, .off)
                    menu.performActionForItem(at: index)
                }
                await Task.yield()
                XCTAssertEqual(
                    ownerDefaults.object(forKey: key) as? Bool,
                    false,
                    "\(title) must update the profile that owns this chat")
                XCTAssertEqual(ownerDefaults.object(forKey: otherKey) as? Bool, false)
                XCTAssertEqual(defaultDefaults.object(forKey: reasoningKey) as? Bool, true)
                XCTAssertEqual(defaultDefaults.object(forKey: toolActivityKey) as? Bool, true)

                let reopenedButton = try await self.threadMenuButton(in: window)
                try AppKitTestSupport.pressMenu(reopenedButton) { menu in
                    let selected = try XCTUnwrap(menu.items.first { $0.title == title })
                    let other = try XCTUnwrap(menu.items.first { $0.title == otherTitle })
                    XCTAssertEqual(selected.state, .off, "Reopening must show the profile's changed preference")
                    XCTAssertEqual(other.state, .off)
                }
            }
        }
    }

    private func threadMenuButton(in window: NSWindow) async throws -> AnyObject {
        let deadline = ContinuousClock.now + .seconds(3)
        var observedElements: [AnyObject] = []
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            let elements = try await AppKitTestSupport.accessibilityElements(in: window)
            observedElements = elements
            if let button = elements.first(where: {
                let role = $0.accessibilityRole?()
                return (role == .button || role == .popUpButton) &&
                    [$0.accessibilityLabel?(), $0.accessibilityTitle?()].contains("Thread")
            }) {
                return button
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
            return "role=\(role) title=\(title) label=\(label)"
        }.joined(separator: "\n")
        return try XCTUnwrap(nil as AnyObject?, """
        The rendered chat toolbar must expose its Thread menu
        appActive=\(NSApp.isActive) windowVisible=\(window.isVisible) windowKey=\(window.isKeyWindow)
        Toolbar items:
        \(toolbarItems)
        Accessibility elements:
        \(accessibility)
        """)
    }
}

@MainActor
private struct ProfilePreferencesOwner: View {
    let viewModel: OpenClawChatViewModel
    @AppStorage(OpenClawChatWindowShell.assistantReasoningDefaultsKey)
    private var showsReasoning = true
    @AppStorage(OpenClawChatWindowShell.assistantToolActivityDefaultsKey)
    private var showsToolActivity = true

    init(viewModel: OpenClawChatViewModel, defaults: UserDefaults) {
        self.viewModel = viewModel
        self._showsReasoning = AppStorage(
            wrappedValue: true,
            OpenClawChatWindowShell.assistantReasoningDefaultsKey,
            store: defaults)
        self._showsToolActivity = AppStorage(
            wrappedValue: true,
            OpenClawChatWindowShell.assistantToolActivityDefaultsKey,
            store: defaults)
    }

    var body: some View {
        OpenClawChatWindowShell(
            viewModel: self.viewModel,
            displayOptions: self.displayOptions)
    }

    private var displayOptions: OpenClawChatDisplayOptions {
        var options: OpenClawChatDisplayOptions = []
        if self.showsReasoning { options.insert(.reasoning) }
        if self.showsToolActivity { options.insert(.toolActivity) }
        return options
    }
}

private struct ProfilePreferencesTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data("""
        {"sessionKey":"\(sessionKey)","messages":[],"thinkingLevel":"off"}
        """.utf8))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}
