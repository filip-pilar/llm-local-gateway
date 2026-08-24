import Foundation

struct GrokCLI: Sendable {
    enum AuthStatus: Sendable, Equatable {
        case authenticated
        case signedOut
        case failed(String)
    }

    static let installURL = URL(string: "https://docs.x.ai/build/cli/overview")!
    let executable: URL
    let version: String

    static func discover() -> GrokCLI? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates = [
            "\(home)/.grok/bin/grok",
            "\(home)/.local/bin/grok",
            "/opt/homebrew/bin/grok",
            "/usr/local/bin/grok",
        ]
        let path = ProcessInfo.processInfo.environment["PATH"]
            ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        candidates.append(contentsOf: path.split(separator: ":").map { "\($0)/grok" })

        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            let url = URL(filePath: candidate)
            guard let result = try? ProcessRunner.run(
                executable: url,
                arguments: ["version"],
                timeout: 5
            ), result.status == 0, !result.timedOut else { continue }
            let version = (result.stdout + result.stderr)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if version.lowercased().hasPrefix("grok ") {
                return GrokCLI(executable: url, version: version)
            }
        }
        return nil
    }

    func authStatus() -> AuthStatus {
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "XAI_API_KEY")
        environment.removeValue(forKey: "GROK_API_KEY")
        let result: ProcessResult
        do {
            result = try ProcessRunner.run(
                executable: executable,
                arguments: ["--no-auto-update", "models"],
                environment: environment,
                timeout: 30
            )
        } catch {
            return .failed("Could not run credential-opaque Grok model discovery.")
        }
        if result.timedOut {
            return .failed("Grok model discovery timed out after 30 seconds.")
        }
        if result.status == 0 {
            return result.stdout.localizedCaseInsensitiveContains("grok-4.5")
                ? .authenticated
                : .failed("This xAI OAuth account does not list Grok 4.5.")
        }
        let output = (result.stdout + "\n" + result.stderr)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let signedOutMarkers = [
            "not signed in",
            "no cached credentials found",
            "you are not authenticated",
        ]
        if signedOutMarkers.contains(where: output.localizedCaseInsensitiveContains) {
            return .signedOut
        }
        return .failed("Credential-opaque Grok model discovery failed.")
    }

    func logout() throws {
        let result = try ProcessRunner.run(
            executable: executable,
            arguments: ["--no-auto-update", "logout"],
            timeout: 30
        )
        guard result.status == 0, !result.timedOut else {
            let detail = result.timedOut
                ? "`grok logout` timed out after 30 seconds."
                : "`grok logout` failed without exposing command output."
            throw NSError(
                domain: "LLMLocalGatewayApp",
                code: Int(result.status),
                userInfo: [NSLocalizedDescriptionKey: detail]
            )
        }
    }
}
