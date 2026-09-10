import AppKit
import Darwin
import Foundation
import ServiceManagement

@MainActor
final class BridgeController: ObservableObject {
    nonisolated static let supportedModels = [
        "swe-1-6-slow",
        "swe-1-7-lightning",
        "swe-2-medium",
        "swe-2-high",
        "swe-2-max",
        "grok-4.5",
    ]
    nonisolated static let publicPort: Int = {
        let environment = ProcessInfo.processInfo.environment
        let value =
            environment["LLM_LOCAL_GATEWAY_PORT"]
            ?? environment["LLM_GATEWAY_PORT"]
        #if DEBUG
        return Int(value ?? "") ?? 4717
        #else
        return Int(value ?? "") ?? 4317
        #endif
    }()
    nonisolated static let openAIEndpoint =
        "http://127.0.0.1:\(publicPort)/openai/v1"
    nonisolated static let claudeEndpoint =
        "http://127.0.0.1:\(publicPort)/claude"

    enum State: Equatable {
        case checking
        case starting
        case running
        case stopped
        case failed(String)

        var label: String {
            switch self {
            case .checking: return "Checking providers"
            case .starting: return "Starting gateway"
            case .running: return "Running"
            case .stopped: return "Stopped"
            case .failed: return "Needs attention"
            }
        }
    }

    enum Operation: Equatable {
        case starting
        case stopping
        case verifying
        case authenticating(String)
        case loggingOut(String)
        case updatingLaunchAtLogin

        var label: String {
            switch self {
            case .starting: return "Starting gateway…"
            case .stopping: return "Stopping gateway…"
            case .verifying: return "Running bounded live verification…"
            case .authenticating(let provider): return "Waiting for \(provider) login…"
            case .loggingOut(let provider): return "Logging out of \(provider)…"
            case .updatingLaunchAtLogin: return "Updating launch setting…"
            }
        }
    }

    enum GatewayOwnership: Equatable {
        case none
        case owned
        case external
    }

    struct Feedback: Equatable {
        enum Kind: Equatable { case success, failure }
        let kind: Kind
        let title: String
        let detail: String
    }

    @Published private(set) var state: State = .checking
    @Published private(set) var gatewayOwnership: GatewayOwnership = .none
    @Published private(set) var endpointVerified = false
    @Published private(set) var preferredDefaultModel: String
    @Published private(set) var observedExternalDefaultModel: String?
    @Published private(set) var operation: Operation?
    @Published private(set) var feedback: Feedback?
    @Published private(set) var devinVersion = ""
    @Published private(set) var grokVersion = ""
    @Published private(set) var devinAuthenticated = false
    @Published private(set) var grokAuthenticated = false
    @Published private(set) var devinReady = false
    @Published private(set) var grokReady = false
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled

    let paths: AppPaths
    private let readinessInspector: @Sendable () async -> BridgeReadiness.Snapshot
    private let helperInstaller: @Sendable (AppPaths) async throws -> Void
    private let modelPreferenceSaver: (String) -> Void
    private let loginTimeout: Duration
    private var devinCLI: DevinCLI?
    private var grokCLI: GrokCLI?
    private var bridgeProcess: Process?
    private var bridgeLifeline: Pipe?
    private var authProcess: Process?
    private var loginTimeoutTask: Task<Void, Never>?
    private var stoppingBridge = false
    private var monitoringTask: Task<Void, Never>?

    var isBusy: Bool { operation != nil }
    var isExternalGateway: Bool { gatewayOwnership == .external }
    var canControlGateway: Bool { gatewayOwnership != .external }
    var logExists: Bool { FileManager.default.fileExists(atPath: paths.serviceLog.path) }
    var hasAuthenticatedProvider: Bool { devinAuthenticated || grokAuthenticated }

    convenience init() {
        let saved = UserDefaults.standard.string(forKey: "defaultGatewayModel")
        self.init(
            paths: .current,
            defaultModel: Self.supportedModels.contains(saved ?? "")
                ? saved!
                : "swe-1-6-slow",
            readinessInspector: {
                await BridgeReadiness.inspect(port: BridgeController.publicPort)
            },
            helperInstaller: { paths in
                try BridgeController.installBundledHelper(paths: paths)
            },
            loginTimeout: .seconds(300)
        )
        state = .checking
        Task { await bootstrap() }
        monitoringTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self else { return }
                await self.refreshObservedStatus()
            }
        }
    }

    init(
        paths: AppPaths,
        defaultModel: String = "swe-1-6-slow",
        devinCLI: DevinCLI? = nil,
        grokCLI: GrokCLI? = nil,
        devinAuthenticated: Bool = false,
        grokAuthenticated: Bool = false,
        readinessInspector: @escaping @Sendable () async -> BridgeReadiness.Snapshot,
        helperInstaller: @escaping @Sendable (AppPaths) async throws -> Void,
        modelPreferenceSaver: @escaping (String) -> Void = {
            UserDefaults.standard.set($0, forKey: "defaultGatewayModel")
        },
        loginTimeout: Duration = .seconds(300)
    ) {
        self.paths = paths
        self.preferredDefaultModel = Self.supportedModels.contains(defaultModel)
            ? defaultModel
            : "swe-1-6-slow"
        self.devinCLI = devinCLI
        self.grokCLI = grokCLI
        self.devinAuthenticated = devinAuthenticated
        self.grokAuthenticated = grokAuthenticated
        self.devinVersion = devinCLI?.version ?? ""
        self.grokVersion = grokCLI?.version ?? ""
        self.readinessInspector = readinessInspector
        self.helperInstaller = helperInstaller
        self.modelPreferenceSaver = modelPreferenceSaver
        self.loginTimeout = loginTimeout
        self.state = .stopped
    }

    func bootstrap() async {
        state = .checking
        feedback = nil
        let discoveredDevin = await Task.detached { DevinCLI.discover() }.value
        let discoveredGrok = await Task.detached { GrokCLI.discover() }.value
        devinCLI = discoveredDevin
        grokCLI = discoveredGrok
        devinVersion = discoveredDevin?.version ?? ""
        grokVersion = discoveredGrok?.version ?? ""
        await refreshAuthentication()
        if hasAuthenticatedProvider {
            await configureAndStart(showSuccess: false)
        } else {
            state = .stopped
        }
    }

    private func refreshAuthentication() async {
        if let devinCLI {
            let status = await Task.detached { devinCLI.authStatus() }.value
            devinAuthenticated = status == .authenticated
            if case .failed(let detail) = status {
                feedback = Feedback(
                    kind: .failure,
                    title: "Could not check Devin authentication",
                    detail: detail
                )
            }
        } else {
            devinAuthenticated = false
        }
        if let grokCLI {
            let status = await Task.detached { grokCLI.authStatus() }.value
            grokAuthenticated = status == .authenticated
            if case .failed(let detail) = status {
                feedback = Feedback(
                    kind: .failure,
                    title: "Could not check Grok authentication",
                    detail: detail
                )
            }
        } else {
            grokAuthenticated = false
        }
    }

    func openInstallInstructions(_ provider: String) {
        NSWorkspace.shared.open(
            provider == "Devin" ? DevinCLI.installURL : GrokCLI.installURL
        )
    }

    func openLog() {
        guard logExists else {
            feedback = Feedback(
                kind: .failure,
                title: "No log file yet",
                detail: paths.serviceLog.path
            )
            return
        }
        NSWorkspace.shared.open(paths.serviceLog)
    }

    func readLogTail(maximumBytes: Int = 64 * 1024) -> String {
        guard let handle = try? FileHandle(forReadingFrom: paths.serviceLog) else {
            return "The gateway log could not be opened."
        }
        defer { try? handle.close() }
        do {
            let end = try handle.seekToEnd()
            let length = UInt64(maximumBytes)
            try handle.seek(toOffset: end > length ? end - length : 0)
            let data = try handle.readToEnd() ?? Data()
            let output = String(decoding: data, as: UTF8.self)
            return output.isEmpty ? "The gateway log is empty." : output
        } catch {
            return "The gateway log could not be read: \(error.localizedDescription)"
        }
    }

    func copyOpenAIEndpoint() {
        copy(Self.openAIEndpoint, title: "OpenAI URL copied")
    }

    func copyClaudeEndpoint() {
        copy(Self.claudeEndpoint, title: "Claude URL copied")
    }

    private func copy(_ value: String, title: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        feedback = Feedback(kind: .success, title: title, detail: value)
    }

    func dismissFeedback() { feedback = nil }

    func loginDevin() {
        guard operation == nil, !isExternalGateway else { return }
        guard authProcess == nil, let cli = devinCLI else {
            if devinCLI == nil { openInstallInstructions("Devin") }
            return
        }
        guard let driver = Bundle.main.url(
            forResource: "devin-auth-pty",
            withExtension: nil
        ) else {
            recordFailure(
                "Authentication helper is missing",
                detail: "Rebuild or reinstall LLM Local Gateway."
            )
            return
        }
        beginLogin(
            provider: "Devin",
            executable: driver,
            arguments: [cli.executable.path, "0"]
        )
    }

    func loginGrok() {
        guard operation == nil, !isExternalGateway else { return }
        guard authProcess == nil, let cli = grokCLI else {
            if grokCLI == nil { openInstallInstructions("Grok") }
            return
        }
        beginLogin(
            provider: "Grok",
            executable: cli.executable,
            arguments: ["--no-auto-update", "login"]
        )
    }

    private func beginLogin(
        provider: String,
        executable: URL,
        arguments: [String]
    ) {
        feedback = nil
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] completed in
            Task { @MainActor in
                guard let self, self.authProcess === completed else { return }
                self.authProcess = nil
                self.loginTimeoutTask?.cancel()
                self.loginTimeoutTask = nil
                guard completed.terminationReason == .exit,
                      completed.terminationStatus == 0 else {
                    self.operation = nil
                    self.recordFailure(
                        "\(provider) login did not complete",
                        detail: "The official \(provider) CLI exited before authentication succeeded."
                    )
                    return
                }
                await self.refreshAuthentication()
                guard self.isAuthenticated(provider) else {
                    self.operation = nil
                    self.recordFailure(
                        "\(provider) login did not complete",
                        detail: "The official \(provider) CLI did not report an authenticated session."
                    )
                    return
                }
                if self.isExternalGateway {
                    await self.refreshObservedStatus()
                    self.operation = nil
                    self.feedback = Feedback(
                        kind: .success,
                        title: "\(provider) signed in",
                        detail: "The externally managed gateway was not restarted."
                    )
                } else {
                    await self.configureAndStart(showSuccess: true)
                }
            }
        }
        do {
            try process.run()
            authProcess = process
            operation = .authenticating(provider)
            let timeout = loginTimeout
            loginTimeoutTask = Task { [weak self, weak process] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled,
                      let self,
                      let process,
                      self.authProcess === process else { return }
                self.authProcess = nil
                self.operation = nil
                process.terminate()
                self.recordFailure(
                    "\(provider) login timed out",
                    detail: "The official \(provider) CLI did not finish within five minutes."
                )
            }
        } catch {
            operation = nil
            recordFailure("Could not start \(provider) login", error: error)
        }
    }

    private func isAuthenticated(_ provider: String) -> Bool {
        provider == "Devin" ? devinAuthenticated : grokAuthenticated
    }

    func cancelLogin() {
        let process = authProcess
        authProcess = nil
        loginTimeoutTask?.cancel()
        loginTimeoutTask = nil
        process?.terminate()
        operation = nil
        feedback = Feedback(
            kind: .failure,
            title: "Login cancelled",
            detail: "No provider credentials were changed by LLM Local Gateway."
        )
    }

    private func configureAndStart(
        showSuccess: Bool,
        restartOwned: Bool = false
    ) async {
        guard hasAuthenticatedProvider else {
            operation = nil
            state = .stopped
            return
        }
        let shouldOwnGateway = restartOwned || gatewayOwnership == .owned
        operation = .starting
        state = .starting
        feedback = nil
        if !shouldOwnGateway {
            let existing = await readinessInspector()
            if existing.isGatewayIdentified {
                gatewayOwnership = .external
                apply(existing, observingExternal: true)
                state = .running
                if showSuccess {
                    feedback = Feedback(
                        kind: .success,
                        title: "External gateway detected",
                        detail: "Status is read-only because this app did not start it."
                    )
                }
                operation = nil
                return
            }
        }
        do {
            let paths = self.paths
            let requireDevin = devinAuthenticated
            let requireGrok = grokAuthenticated
            try await Task.detached {
                if requireDevin {
                    try Self.enforceCredentialPermissions(
                        paths.devinCredentials,
                        provider: "Devin"
                    )
                }
                if requireGrok {
                    try Self.ensurePrivateDirectory(paths.grokHome)
                    try Self.enforceCredentialPermissions(
                        paths.grokCredentials,
                        provider: "Grok"
                    )
                }
            }.value
            try await helperInstaller(paths)
            let snapshot: BridgeReadiness.Snapshot
            if shouldOwnGateway {
                await stopOwnedBridgeProcess()
                try await startBridgeProcess()
                snapshot = try await waitForReadiness()
            } else {
                try await startBridgeProcess()
                snapshot = try await waitForReadiness()
            }
            apply(snapshot, observingExternal: false)
            state = .running
            if showSuccess {
                feedback = Feedback(
                    kind: .success,
                    title: "Gateway is ready",
                    detail: readyProviderDescription
                )
            }
        } catch {
            await stopOwnedBridgeProcess()
            recordFailure("Could not start the gateway", error: error)
        }
        operation = nil
    }

    private var readyProviderDescription: String {
        let ready = [
            devinReady ? "Devin" : nil,
            grokReady ? "Grok" : nil,
        ].compactMap { $0 }
        return ready.isEmpty
            ? "No provider transport is ready."
            : "Ready providers: \(ready.joined(separator: ", "))."
    }

    nonisolated private static func enforceCredentialPermissions(
        _ path: URL,
        provider: String
    ) throws {
        let descriptor = open(path.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw posixError("Could not securely open \(provider) credentials")
        }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG else {
            throw NSError(
                domain: "LLMLocalGatewayApp",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "\(provider) credentials must be a regular file, not a symbolic link",
                ]
            )
        }
        guard fchmod(descriptor, 0o600) == 0 else {
            throw posixError("Could not make \(provider) credentials private")
        }
    }

    nonisolated private static func ensurePrivateDirectory(_ path: URL) throws {
        try FileManager.default.createDirectory(
            at: path,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let values = try path.resourceValues(
            forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        )
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw NSError(
                domain: "LLMLocalGatewayApp",
                code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Refusing unsafe state directory at \(path.path)",
                ]
            )
        }
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: path.path
        )
    }

    nonisolated private static func posixError(_ message: String) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(errno),
            userInfo: [
                NSLocalizedDescriptionKey:
                    "\(message): \(String(cString: strerror(errno)))",
            ]
        )
    }

    nonisolated private static func installBundledHelper(paths: AppPaths) throws {
        guard let bundled = Bundle.main.url(
            forResource: "llm-local-gateway-helper",
            withExtension: nil
        ) else {
            throw NSError(
                domain: "LLMLocalGatewayApp",
                code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey: "Bundled gateway helper is missing",
                ]
            )
        }
        let manager = FileManager.default
        let binDirectory = paths.stableHelper.deletingLastPathComponent()
        try ensurePrivateDirectory(paths.dataDirectory)
        try ensurePrivateDirectory(binDirectory)
        let temporary = binDirectory.appending(
            path: ".llm-local-gateway-helper.\(UUID().uuidString).tmp"
        )
        try manager.copyItem(at: bundled, to: temporary)
        try manager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: temporary.path
        )
        if rename(temporary.path, paths.stableHelper.path) != 0 {
            try? manager.removeItem(at: temporary)
            throw posixError("Could not install the stable gateway helper")
        }
    }

    private func startBridgeProcess() async throws {
        try Self.ensurePrivateDirectory(paths.dataDirectory)
        let logDescriptor = open(
            paths.serviceLog.path,
            O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW,
            0o600
        )
        guard logDescriptor >= 0 else {
            throw Self.posixError("Could not securely open the gateway log")
        }
        var logMetadata = stat()
        guard fstat(logDescriptor, &logMetadata) == 0,
              logMetadata.st_mode & S_IFMT == S_IFREG,
              fchmod(logDescriptor, 0o600) == 0 else {
            close(logDescriptor)
            throw Self.posixError("Gateway log must be a private regular file")
        }
        let log = FileHandle(fileDescriptor: logDescriptor, closeOnDealloc: true)

        let process = Process()
        let lifeline = Pipe()
        process.executableURL = paths.stableHelper
        process.arguments = [
            "serve",
            "--parent-lifeline",
            "--model",
            preferredDefaultModel,
            "--port",
            String(Self.publicPort),
            "--devin-port",
            String(Self.publicPort + 1),
            "--grok-port",
            String(Self.publicPort + 2),
        ]
        process.environment = {
            var environment = ProcessInfo.processInfo.environment
            environment["LLM_LOCAL_GATEWAY_DATA_DIR"] = paths.dataDirectory.path
            environment["DEVIN_CREDENTIALS_FILE"] = paths.devinCredentials.path
            environment["GROK_HOME"] = paths.grokHome.path
            if let executable = grokCLI?.executable.path {
                environment["GROK_CLI"] = executable
            }
            return environment
        }()
        process.standardInput = lifeline
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] completed in
            try? log.close()
            Task { @MainActor in
                guard let self, self.bridgeProcess === completed else { return }
                self.bridgeProcess = nil
                self.bridgeLifeline = nil
                self.gatewayOwnership = .none
                self.endpointVerified = false
                self.observedExternalDefaultModel = nil
                self.devinReady = false
                self.grokReady = false
                if !self.stoppingBridge {
                    self.recordFailure(
                        "Gateway helper stopped unexpectedly",
                        detail:
                            "Exit status \(completed.terminationStatus). Open the log for details."
                    )
                }
            }
        }
        try process.run()
        stoppingBridge = false
        bridgeProcess = process
        bridgeLifeline = lifeline
        gatewayOwnership = .owned
        observedExternalDefaultModel = nil
    }

    private func waitForReadiness() async throws -> BridgeReadiness.Snapshot {
        for _ in 0..<200 {
            let snapshot = await readinessInspector()
            if snapshot.isReady { return snapshot }
            if bridgeProcess?.isRunning != true { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        throw NSError(
            domain: "LLMLocalGatewayApp",
            code: 3,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "Gateway did not become ready. See \(paths.serviceLog.path)",
            ]
        )
    }

    private func apply(
        _ snapshot: BridgeReadiness.Snapshot,
        observingExternal: Bool
    ) {
        endpointVerified = snapshot.isReady
        devinReady = snapshot.isProviderReady("devin")
        grokReady = snapshot.isProviderReady("grok")
        observedExternalDefaultModel = observingExternal
            ? snapshot.defaultModel
            : nil
    }

    private func stopOwnedBridgeProcess() async {
        guard gatewayOwnership == .owned else { return }
        stoppingBridge = true
        guard let process = bridgeProcess else {
            bridgeLifeline = nil
            gatewayOwnership = .none
            endpointVerified = false
            observedExternalDefaultModel = nil
            devinReady = false
            grokReady = false
            stoppingBridge = false
            return
        }
        await ProcessLifecycle.stop(process, lifeline: bridgeLifeline)
        if bridgeProcess === process {
            bridgeProcess = nil
            bridgeLifeline = nil
        }
        gatewayOwnership = .none
        endpointVerified = false
        observedExternalDefaultModel = nil
        devinReady = false
        grokReady = false
        stoppingBridge = false
    }

    func stopBridge() {
        guard operation == nil, gatewayOwnership == .owned else { return }
        operation = .stopping
        feedback = nil
        Task {
            await stopOwnedBridgeProcess()
            state = .stopped
            operation = nil
            feedback = Feedback(
                kind: .success,
                title: "Gateway stopped",
                detail: "The supervised loopback endpoint is no longer running."
            )
        }
    }

    func startBridge() {
        guard operation == nil, gatewayOwnership != .external else { return }
        Task { await configureAndStart(showSuccess: true) }
    }

    func selectDefaultModel(_ model: String) {
        guard Self.supportedModels.contains(model),
              model != preferredDefaultModel,
              operation == nil,
              gatewayOwnership != .external else { return }
        preferredDefaultModel = model
        modelPreferenceSaver(model)
        if gatewayOwnership == .owned {
            Task {
                await configureAndStart(
                    showSuccess: true,
                    restartOwned: true
                )
            }
        }
    }

    func verifyDirectRequest() {
        guard operation == nil, endpointVerified,
              gatewayOwnership != .external else { return }
        operation = .verifying
        feedback = nil
        let helper = paths.stableHelper
        let models = [
            devinReady ? "swe-1-6-slow" : nil,
            grokReady ? "grok-4.5" : nil,
        ].compactMap { $0 }
        Task {
            do {
                for model in models {
                    for bridgeProtocol in ["openai", "claude"] {
                        let result = try await Task.detached {
                            try ProcessRunner.run(
                                executable: helper,
                                arguments: [
                                    "smoke",
                                    "--port",
                                    String(Self.publicPort),
                                    "--protocol",
                                    bridgeProtocol,
                                    "--model",
                                    model,
                                    "--json",
                                ],
                                timeout: 300
                            )
                        }.value
                        guard result.status == 0 else {
                            let detail = result.stderr.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            )
                            throw NSError(
                                domain: "LLMLocalGatewayApp",
                                code: Int(result.status),
                                userInfo: [
                                    NSLocalizedDescriptionKey:
                                        detail.isEmpty
                                        ? "\(bridgeProtocol) \(model) request failed"
                                        : detail,
                                ]
                            )
                        }
                    }
                }
                feedback = Feedback(
                    kind: .success,
                    title: "Live verification passed",
                    detail:
                        "OpenAI and Claude passed for \(models.joined(separator: " and "))."
                )
            } catch {
                recordFailure(
                    "Direct request failed",
                    error: error,
                    changeGatewayState: false
                )
            }
            operation = nil
        }
    }

    func logoutDevin() { logout(provider: "Devin") }
    func logoutGrok() { logout(provider: "Grok") }

    private func logoutAndVerify(provider: String) async throws {
        if provider == "Devin" {
            let cli = devinCLI!
            let status = try await Task.detached {
                try cli.logout()
                return cli.authStatus()
            }.value
            guard status == .signedOut else {
                throw logoutVerificationError(provider)
            }
            devinAuthenticated = false
        } else {
            let cli = grokCLI!
            let status = try await Task.detached {
                try cli.logout()
                return cli.authStatus()
            }.value
            guard status == .signedOut else {
                throw logoutVerificationError(provider)
            }
            grokAuthenticated = false
        }
    }

    private func logoutVerificationError(_ provider: String) -> NSError {
        NSError(
            domain: "LLMLocalGatewayApp",
            code: 4,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "The official \(provider) CLI did not confirm a signed-out session.",
            ]
        )
    }

    private func logout(provider: String) {
        guard operation == nil, gatewayOwnership != .external else { return }
        if provider == "Devin", devinCLI == nil { return }
        if provider == "Grok", grokCLI == nil { return }
        let restoreOwnedGateway = gatewayOwnership == .owned
        operation = .loggingOut(provider)
        feedback = nil
        Task {
            if restoreOwnedGateway {
                await stopOwnedBridgeProcess()
            }
            do {
                try await logoutAndVerify(provider: provider)
                operation = nil
                if restoreOwnedGateway, hasAuthenticatedProvider {
                    await configureAndStart(
                        showSuccess: false,
                        restartOwned: true
                    )
                    guard gatewayOwnership == .owned, endpointVerified else {
                        return
                    }
                } else {
                    state = .stopped
                }
                feedback = Feedback(
                    kind: .success,
                    title: "Logged out of \(provider)",
                    detail: "Provider credentials remain owned by the official CLI."
                )
            } catch {
                operation = nil
                if restoreOwnedGateway {
                    await configureAndStart(
                        showSuccess: false,
                        restartOwned: true
                    )
                    guard gatewayOwnership == .owned, endpointVerified else {
                        return
                    }
                    recordFailure(
                        "\(provider) logout failed",
                        error: error,
                        changeGatewayState: false
                    )
                } else {
                    recordFailure("\(provider) logout failed", error: error)
                }
            }
        }
    }

    func updateLaunchAtLogin(_ enabled: Bool) {
        guard operation == nil else { return }
        operation = .updatingLaunchAtLogin
        feedback = nil
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            feedback = Feedback(
                kind: .success,
                title:
                    launchAtLogin
                    ? "Launch at Login enabled"
                    : "Launch at Login disabled",
                detail:
                    launchAtLogin
                    ? "LLM Local Gateway will start after you sign in to this Mac."
                    : "You can still open LLM Local Gateway manually."
            )
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            recordFailure(
                "Could not update Launch at Login",
                error: error,
                changeGatewayState: false
            )
        }
        operation = nil
    }

    private func refreshObservedStatus() async {
        let snapshot = await readinessInspector()
        if gatewayOwnership == .owned {
            apply(snapshot, observingExternal: false)
            if !snapshot.isReady,
               bridgeProcess?.isRunning == true,
               state == .running {
                recordFailure(
                    "Gateway endpoint is unavailable",
                    detail: "The supervised helper is running but its endpoint is unavailable."
                )
            }
        } else if snapshot.isGatewayIdentified {
            gatewayOwnership = .external
            apply(snapshot, observingExternal: true)
            state = .running
        } else {
            apply(snapshot, observingExternal: false)
            if gatewayOwnership == .external {
                state = .stopped
            }
            gatewayOwnership = .none
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    private func recordFailure(
        _ title: String,
        error: Error? = nil,
        detail: String? = nil,
        changeGatewayState: Bool = true
    ) {
        let explanation =
            detail ?? error?.localizedDescription ?? "Unknown error"
        if changeGatewayState { state = .failed(explanation) }
        feedback = Feedback(
            kind: .failure,
            title: title,
            detail: explanation
        )
    }

    func quit() {
        monitoringTask?.cancel()
        let process = authProcess
        authProcess = nil
        loginTimeoutTask?.cancel()
        loginTimeoutTask = nil
        process?.terminate()
        Task {
            await stopOwnedBridgeProcess()
            NSApplication.shared.terminate(nil)
        }
    }
}
