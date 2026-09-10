import SwiftUI

@main
struct LLMLocalGatewayMenuApp: App {
    @StateObject private var controller = BridgeController()

    var body: some Scene {
        #if DEBUG
        Window("LLM Local Gateway UI Test", id: "ui-test") {
            GatewayPanel(controller: controller)
        }
        .windowResizability(.contentSize)
        #else
        MenuBarExtra(
            "LLM Local Gateway",
            systemImage: controller.endpointVerified
                ? "point.3.connected.trianglepath.dotted"
                : "point.3.filled.connected.trianglepath.dotted"
        ) {
            GatewayPanel(controller: controller)
        }
        .menuBarExtraStyle(.window)
        #endif
    }
}

private struct GatewayPanel: View {
    @ObservedObject var controller: BridgeController
    @State private var logoutProvider: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            gatewaySection
            Divider()
            providersSection
            if let feedback = controller.feedback {
                Divider()
                feedbackBanner(feedback)
            }
            Divider()
            footer
        }
        .frame(width: 430)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial)
        .confirmationDialog(
            "Log out of \(logoutProvider ?? "provider")?",
            isPresented: Binding(
                get: { logoutProvider != nil },
                set: { if !$0 { logoutProvider = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Log Out and Restart Gateway", role: .destructive) {
                let provider = logoutProvider
                logoutProvider = nil
                if provider == "Devin" { controller.logoutDevin() }
                if provider == "Grok" { controller.logoutGrok() }
            }
            Button("Cancel", role: .cancel) { logoutProvider = nil }
        } message: {
            Text(
                "The official CLI will remove its own session. "
                + "The other provider remains independent."
            )
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 11)
                    .fill(
                        LinearGradient(
                            colors: [.indigo, .blue],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text("LLM Local Gateway")
                    .font(.headline)
                Text(
                    controller.operation?.label
                        ?? (
                            controller.isExternalGateway
                                ? "External gateway · read only"
                                : controller.state.label
                        )
                )
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            providerPill("Devin", ready: controller.devinReady)
            providerPill("Grok", ready: controller.grokReady)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var gatewaySection: some View {
        VStack(spacing: 0) {
            row("Gateway", icon: "bolt.horizontal.fill") {
                statusLabel(
                    controller.isExternalGateway
                        ? "External"
                        : controller.endpointVerified ? "Running" : "Stopped",
                    positive: controller.endpointVerified
                )
                if controller.isExternalGateway {
                    Text("Read only")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Button(
                        controller.endpointVerified ? "Stop" : "Start",
                        action: controller.endpointVerified
                            ? controller.stopBridge
                            : controller.startBridge
                    )
                    .disabled(
                        controller.isBusy || !controller.hasAuthenticatedProvider
                    )
                }
            }
            sectionDivider
            row("OpenAI", icon: "arrow.trianglehead.branch") {
                endpoint(BridgeController.openAIEndpoint)
                Button("Copy", systemImage: "doc.on.doc") {
                    controller.copyOpenAIEndpoint()
                }
            }
            sectionDivider
            row("Claude", icon: "text.bubble") {
                endpoint(BridgeController.claudeEndpoint)
                Button("Copy", systemImage: "doc.on.doc") {
                    controller.copyClaudeEndpoint()
                }
            }
            sectionDivider
            row(
                controller.isExternalGateway ? "External default" : "Default",
                icon: "cpu"
            ) {
                if controller.isExternalGateway {
                    Text(controller.observedExternalDefaultModel ?? "Unknown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Picker(
                        "Default model",
                        selection: Binding(
                            get: { controller.preferredDefaultModel },
                            set: controller.selectDefaultModel
                        )
                    ) {
                        Text("SWE-1.6 Slow · Devin").tag("swe-1-6-slow")
                        Text("SWE-1.7 Lightning · Devin").tag("swe-1-7-lightning")
                        Text("SWE-2 Medium · Devin").tag("swe-2-medium")
                        Text("SWE-2 High · Devin").tag("swe-2-high")
                        Text("SWE-2 Max · Devin").tag("swe-2-max")
                        Text("Grok 4.5 · Grok").tag("grok-4.5")
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 205)
                    .disabled(controller.isBusy)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    private var providersSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PROVIDERS")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 11)
                .padding(.bottom, 4)

            providerRow(
                "Devin",
                symbol: "d.square.fill",
                version: controller.devinVersion,
                authenticated: controller.devinAuthenticated,
                ready: controller.devinReady,
                login: controller.loginDevin
            )
            sectionDivider
            providerRow(
                "Grok",
                symbol: "g.square.fill",
                version: controller.grokVersion,
                authenticated: controller.grokAuthenticated,
                ready: controller.grokReady,
                login: controller.loginGrok
            )
            sectionDivider
            row("Launch at Login", icon: "power") {
                Toggle(
                    "Launch at Login",
                    isOn: Binding(
                        get: { controller.launchAtLogin },
                        set: controller.updateLaunchAtLogin
                    )
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(controller.isBusy)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private func providerRow(
        _ name: String,
        symbol: String,
        version: String,
        authenticated: Bool,
        ready: Bool,
        login: @escaping () -> Void
    ) -> some View {
        row(name, icon: symbol) {
            VStack(alignment: .trailing, spacing: 1) {
                Text(ready ? "Ready" : authenticated ? "Authenticated" : "Signed out")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(ready ? .green : .secondary)
                Text(version.isEmpty ? "CLI not found" : version)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            if authenticated {
                Button("Log Out") { logoutProvider = name }
                    .disabled(controller.isBusy || !controller.canControlGateway)
            } else {
                Button(version.isEmpty ? "Install" : "Sign In", action: login)
                    .disabled(controller.isBusy || !controller.canControlGateway)
            }
        }
    }

    private func feedbackBanner(
        _ feedback: BridgeController.Feedback
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(
                systemName:
                    feedback.kind == .success
                    ? "checkmark.circle.fill"
                    : "exclamationmark.triangle.fill"
            )
            .foregroundStyle(
                feedback.kind == .success ? Color.green : Color.orange
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(feedback.title)
                    .font(.caption.weight(.semibold))
                Text(feedback.detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button("Dismiss", systemImage: "xmark") {
                controller.dismissFeedback()
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button(
                "Verify Providers",
                systemImage: "checkmark.seal",
                action: controller.verifyDirectRequest
            )
            .disabled(
                !controller.endpointVerified
                    || controller.isBusy
                    || !controller.canControlGateway
            )
            .help("Makes bounded live OpenAI and Claude requests")
            Button("Log", systemImage: "doc.text.magnifyingglass") {
                controller.openLog()
            }
            .disabled(!controller.logExists)
            Spacer()
            Button("Quit", action: controller.quit)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }

    private func row<Content: View>(
        _ title: String,
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .frame(width: 18)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.callout)
            Spacer(minLength: 8)
            content()
        }
        .frame(minHeight: 39)
    }

    private var sectionDivider: some View {
        Divider().padding(.leading, 28)
    }

    private func endpoint(_ value: String) -> some View {
        Text(value)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: 205, alignment: .trailing)
    }

    private func providerPill(_ name: String, ready: Bool) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(ready ? Color.green : Color.secondary.opacity(0.45))
                .frame(width: 6, height: 6)
            Text(name)
                .font(.caption2.weight(.medium))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())
    }

    private func statusLabel(_ value: String, positive: Bool) -> some View {
        Text(value)
            .font(.caption.weight(.medium))
            .foregroundStyle(positive ? .green : .secondary)
    }
}
