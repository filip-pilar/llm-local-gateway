import Foundation
import Testing
@testable import LLMLocalGatewayApp

private struct ControllerFixture: Sendable {
    let root: URL
    let paths: AppPaths
    let starts: URL
    let grokAuthMarker: URL

    init() throws {
        let manager = FileManager.default
        root = manager.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let data = root.appending(path: "data", directoryHint: .isDirectory)
        let bin = data.appending(path: "bin", directoryHint: .isDirectory)
        let devinDirectory = root.appending(
            path: "devin",
            directoryHint: .isDirectory
        )
        let grokHome = root.appending(
            path: "grok",
            directoryHint: .isDirectory
        )
        try manager.createDirectory(at: bin, withIntermediateDirectories: true)
        try manager.createDirectory(
            at: devinDirectory,
            withIntermediateDirectories: true
        )
        try manager.createDirectory(
            at: grokHome,
            withIntermediateDirectories: true
        )

        let helper = bin.appending(path: "llm-local-gateway-helper")
        starts = bin.appending(path: "starts")
        grokAuthMarker = root.appending(path: "grok-authenticated")
        try """
        #!/bin/sh
        script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        printf '%s\n' "$*" >> "$script_dir/starts"
        while IFS= read -r line; do :; done
        """.write(to: helper, atomically: true, encoding: .utf8)
        try manager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: helper.path
        )

        let devinCredentials = devinDirectory.appending(path: "credentials.toml")
        let grokCredentials = grokHome.appending(path: "auth.json")
        try "windsurf_api_key = \"placeholder\"\n".write(
            to: devinCredentials,
            atomically: true,
            encoding: .utf8
        )
        try "{\"access_token\":\"placeholder\"}\n".write(
            to: grokCredentials,
            atomically: true,
            encoding: .utf8
        )
        try manager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: devinCredentials.path
        )
        try manager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: grokCredentials.path
        )

        paths = AppPaths(
            home: root,
            dataDirectory: data,
            devinCredentials: devinCredentials,
            grokHome: grokHome,
            grokCredentials: grokCredentials,
            stableHelper: helper,
            serviceLog: data.appending(path: "gateway.log")
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    func startCount() -> Int {
        guard let contents = try? String(contentsOf: starts, encoding: .utf8) else {
            return 0
        }
        return contents.split(whereSeparator: \.isNewline).count
    }

    func ownedSnapshot() async -> BridgeReadiness.Snapshot {
        let ready = startCount() > 0
        return BridgeReadiness.Snapshot(
            isGatewayIdentified: ready,
            isReady: ready,
            models: BridgeController.supportedModels,
            defaultModel: nil,
            providers: ready ? ["devin": true, "grok": true] : [:]
        )
    }

    func externalSnapshot(isReady: Bool = true) async -> BridgeReadiness.Snapshot {
        BridgeReadiness.Snapshot(
            isGatewayIdentified: true,
            isReady: isReady,
            models: BridgeController.supportedModels,
            defaultModel: "grok-4.5",
            providers: ["devin": isReady, "grok": false]
        )
    }

    func fakeCLI(named name: String, source: String) throws -> URL {
        let directory = root.appending(
            path: "fake-clis",
            directoryHint: .isDirectory
        )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let executable = directory.appending(path: name)
        try source.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )
        return executable
    }
}

@MainActor
private func waitUntil(
    _ description: String,
    condition: @MainActor () -> Bool
) async throws {
    for _ in 0..<200 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(20))
    }
    throw NSError(
        domain: "BridgeControllerTests",
        code: 1,
        userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for \(description)",
        ]
    )
}

private func authenticatedDevin(in fixture: ControllerFixture) throws -> DevinCLI {
    let executable = try fixture.fakeCLI(
        named: "devin",
        source: """
        #!/bin/sh
        if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
          printf 'Logged in\n'
          exit 0
        fi
        if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then
          exit 0
        fi
        exit 8
        """
    )
    return DevinCLI(executable: executable, version: "devin test")
}

@MainActor
private func controller(
    fixture: ControllerFixture,
    devinCLI: DevinCLI? = nil,
    grokCLI: GrokCLI? = nil,
    devinAuthenticated: Bool = true,
    grokAuthenticated: Bool = false,
    external: Bool = false,
    externalReady: Bool = true,
    defaultModel: String = "swe-1-6-slow"
) -> BridgeController {
    BridgeController(
        paths: fixture.paths,
        defaultModel: defaultModel,
        devinCLI: devinCLI,
        grokCLI: grokCLI,
        devinAuthenticated: devinAuthenticated,
        grokAuthenticated: grokAuthenticated,
        readinessInspector: {
            external
                ? await fixture.externalSnapshot(isReady: externalReady)
                : await fixture.ownedSnapshot()
        },
        helperInstaller: { _ in },
        modelPreferenceSaver: { _ in }
    )
}

@MainActor
private func startOwned(
    _ controller: BridgeController,
    fixture: ControllerFixture
) async throws {
    controller.startBridge()
    try await waitUntil("owned gateway startup") {
        controller.operation == nil
            && controller.gatewayOwnership == .owned
            && controller.endpointVerified
            && fixture.startCount() == 1
    }
}

@MainActor
private func stopOwned(_ controller: BridgeController) async throws {
    controller.stopBridge()
    try await waitUntil("owned gateway shutdown") {
        controller.operation == nil
            && controller.gatewayOwnership == .none
            && !controller.endpointVerified
    }
}

@Suite("Bridge controller", .serialized)
@MainActor
struct BridgeControllerTests {
    @Test func restartsOwnedGatewayForDefaultModelChange() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let controller = controller(fixture: fixture)
        try await startOwned(controller, fixture: fixture)

        controller.selectDefaultModel("grok-4.5")
        try await waitUntil("owned gateway reconfiguration") {
            controller.operation == nil
                && controller.gatewayOwnership == .owned
                && controller.preferredDefaultModel == "grok-4.5"
                && fixture.startCount() == 2
        }

        #expect(controller.state == .running)
        try await stopOwned(controller)
    }

    @Test func successfulLoginRestartsOwnedGatewayAndVerifiesTarget() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let devin = try authenticatedDevin(in: fixture)
        let marker = fixture.grokAuthMarker.path
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "login" ]; then
              : > "\(marker)"
              exit 0
            fi
            if [ "$2" = "models" ] && [ -f "\(marker)" ]; then
              printf 'grok-4.5\n'
              exit 0
            fi
            exit 1
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            devinCLI: devin,
            grokCLI: grok
        )
        try await startOwned(controller, fixture: fixture)

        controller.loginGrok()
        try await waitUntil("successful Grok login") {
            controller.operation == nil
                && controller.grokAuthenticated
                && controller.gatewayOwnership == .owned
                && fixture.startCount() == 2
        }

        #expect(controller.feedback?.kind == .success)
        try await stopOwned(controller)
    }

    @Test func zeroExitLoginMustAuthenticateRequestedProvider() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let devin = try authenticatedDevin(in: fixture)
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "login" ]; then exit 0; fi
            if [ "$2" = "models" ]; then exit 1; fi
            exit 8
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            devinCLI: devin,
            grokCLI: grok
        )
        try await startOwned(controller, fixture: fixture)

        controller.loginGrok()
        try await waitUntil("target-specific login rejection") {
            controller.operation == nil
                && controller.feedback?.title == "Grok login did not complete"
        }

        #expect(!controller.grokAuthenticated)
        #expect(controller.gatewayOwnership == .owned)
        #expect(fixture.startCount() == 1)
        try await stopOwned(controller)
    }

    @Test func failedLoginClearsOperationWithoutRestarting() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "login" ]; then exit 7; fi
            exit 1
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(fixture: fixture, grokCLI: grok)
        try await startOwned(controller, fixture: fixture)

        controller.loginGrok()
        try await waitUntil("failed Grok login") {
            controller.operation == nil
                && controller.feedback?.title == "Grok login did not complete"
        }

        #expect(controller.gatewayOwnership == .owned)
        #expect(fixture.startCount() == 1)
        try await stopOwned(controller)
    }

    @Test func failedLogoutRestoresPreviouslyOwnedGateway() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "models" ]; then
              printf 'grok-4.5\n'
              exit 0
            fi
            if [ "$2" = "logout" ]; then exit 9; fi
            exit 8
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            grokCLI: grok,
            grokAuthenticated: true
        )
        try await startOwned(controller, fixture: fixture)

        controller.logoutGrok()
        try await waitUntil("gateway restoration after failed logout") {
            controller.operation == nil
                && controller.gatewayOwnership == .owned
                && controller.endpointVerified
                && controller.feedback?.title == "Grok logout failed"
                && fixture.startCount() == 2
        }

        #expect(controller.state == .running)
        try await stopOwned(controller)
    }

    @Test func zeroExitLogoutMustConfirmRequestedProviderSignedOut() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "models" ]; then
              printf 'grok-4.5\n'
              exit 0
            fi
            if [ "$2" = "logout" ]; then exit 0; fi
            exit 8
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            grokCLI: grok,
            grokAuthenticated: true
        )
        try await startOwned(controller, fixture: fixture)

        controller.logoutGrok()
        try await waitUntil("target-specific logout rejection") {
            controller.operation == nil
                && controller.gatewayOwnership == .owned
                && controller.endpointVerified
                && controller.feedback?.title == "Grok logout failed"
                && fixture.startCount() == 2
        }

        #expect(controller.grokAuthenticated)
        #expect(controller.state == .running)
        try await stopOwned(controller)
    }

    @Test func zeroExitLogoutRejectsFailedStatusVerification() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "models" ]; then
              printf 'temporary provider failure\n' >&2
              exit 3
            fi
            if [ "$2" = "logout" ]; then exit 0; fi
            exit 8
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            grokCLI: grok,
            grokAuthenticated: true
        )
        try await startOwned(controller, fixture: fixture)

        controller.logoutGrok()
        try await waitUntil("failed logout status verification") {
            controller.operation == nil
                && controller.gatewayOwnership == .owned
                && controller.feedback?.title == "Grok logout failed"
                && fixture.startCount() == 2
        }

        #expect(controller.grokAuthenticated)
        #expect(controller.feedback?.detail.contains("temporary provider failure") == false)
        try await stopOwned(controller)
    }

    @Test func confirmedLogoutStopsOwnedGatewayWithoutProviders() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let marker = fixture.root.appending(path: "grok-logged-out")
        let grokExecutable = try fixture.fakeCLI(
            named: "grok",
            source: """
            #!/bin/sh
            if [ "$2" = "logout" ]; then
              : > "\(marker.path)"
              exit 0
            fi
            if [ "$2" = "models" ] && [ -f "\(marker.path)" ]; then
              printf 'Not signed in. Run `grok login` to authenticate.\n' >&2
              exit 1
            fi
            exit 8
            """
        )
        let grok = GrokCLI(executable: grokExecutable, version: "grok test")
        let controller = controller(
            fixture: fixture,
            grokCLI: grok,
            devinAuthenticated: false,
            grokAuthenticated: true
        )
        try await startOwned(controller, fixture: fixture)

        controller.logoutGrok()
        try await waitUntil("confirmed Grok logout") {
            controller.operation == nil
                && controller.gatewayOwnership == .none
                && controller.feedback?.title == "Logged out of Grok"
        }

        #expect(!controller.grokAuthenticated)
        #expect(controller.state == .stopped)
        #expect(fixture.startCount() == 1)
    }

    @Test func externalGatewayRemainsReadOnlyAndUnowned() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let marker = fixture.root.appending(path: "external-auth-command")
        let devinExecutable = try fixture.fakeCLI(
            named: "devin",
            source: """
            #!/bin/sh
            : > "\(marker.path)"
            exit 0
            """
        )
        let devin = DevinCLI(
            executable: devinExecutable,
            version: "devin test"
        )
        let controller = controller(
            fixture: fixture,
            devinCLI: devin,
            external: true
        )
        let desiredModel = controller.preferredDefaultModel

        controller.startBridge()
        try await waitUntil("external gateway discovery") {
            controller.operation == nil
                && controller.gatewayOwnership == .external
                && controller.endpointVerified
        }

        controller.selectDefaultModel("grok-4.5")
        controller.stopBridge()
        controller.loginDevin()
        controller.logoutDevin()
        try await Task.sleep(for: .milliseconds(50))

        #expect(controller.isExternalGateway)
        #expect(!controller.canControlGateway)
        #expect(controller.preferredDefaultModel == desiredModel)
        #expect(controller.observedExternalDefaultModel == "grok-4.5")
        #expect(controller.endpointVerified)
        #expect(fixture.startCount() == 0)
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }

    @Test func unavailableExternalGatewayBlocksStartAndPreservesPreference() async throws {
        let fixture = try ControllerFixture()
        defer { fixture.remove() }
        let controller = controller(
            fixture: fixture,
            external: true,
            externalReady: false,
            defaultModel: "swe-1-7-lightning"
        )

        controller.startBridge()
        try await waitUntil("unavailable external gateway discovery") {
            controller.operation == nil
                && controller.gatewayOwnership == .external
        }

        #expect(!controller.endpointVerified)
        #expect(!controller.canControlGateway)
        #expect(controller.preferredDefaultModel == "swe-1-7-lightning")
        #expect(controller.observedExternalDefaultModel == "grok-4.5")
        #expect(fixture.startCount() == 0)

        controller.startBridge()
        try await Task.sleep(for: .milliseconds(50))
        #expect(fixture.startCount() == 0)
    }
}

@Suite("Bridge readiness")
struct BridgeReadinessTests {
    @Test func identityBearing503RemainsIdentifiedAndRetainsStatus() async throws {
        let snapshot = await BridgeReadiness.inspect(port: 4317) { url in
            if url.path.hasSuffix("/readiness") {
                let data = Data("""
                {
                  "ready": false,
                  "default_model": "grok-4.5",
                  "providers": {
                    "devin": { "ready": false },
                    "grok": { "ready": false }
                  }
                }
                """.utf8)
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: 503,
                    httpVersion: nil,
                    headerFields: ["x-llm-local-gateway": "1"]
                )!
                return (data, response)
            }
            throw URLError(.cannotConnectToHost)
        }

        #expect(snapshot.isGatewayIdentified)
        #expect(!snapshot.isReady)
        #expect(snapshot.models.isEmpty)
        #expect(snapshot.defaultModel == "grok-4.5")
        #expect(!snapshot.isProviderReady("devin"))
        #expect(!snapshot.isProviderReady("grok"))
    }
}
