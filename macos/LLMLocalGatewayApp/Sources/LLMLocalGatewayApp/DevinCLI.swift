import Foundation

struct DevinCLI: Sendable {
    enum AuthStatus: Sendable, Equatable {
        case authenticated
        case signedOut
        case failed(String)
    }

    static let installURL = URL(string: "https://docs.devin.ai/cli/quickstart")!
    let executable: URL
    let version: String

    static func discover() -> DevinCLI? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates = [
            "\(home)/.local/bin/devin",
            "/opt/homebrew/bin/devin",
            "/usr/local/bin/devin",
        ]
        let path = ProcessInfo.processInfo.environment["PATH"]
            ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        candidates.append(contentsOf: path.split(separator: ":").map { "\($0)/devin" })

        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            let url = URL(filePath: candidate)
            guard let result = try? ProcessRunner.run(
                executable: url,
                arguments: ["--version"],
                timeout: 5
            ), result.status == 0, !result.timedOut else { continue }
            let version = (result.stdout + result.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
            if version.lowercased().hasPrefix("devin ") {
                return DevinCLI(executable: url, version: version)
            }
        }
        return nil
    }

    func authStatus() -> AuthStatus {
        let result: ProcessResult
        do {
            result = try ProcessRunner.run(
                executable: executable,
                arguments: ["auth", "status"],
                timeout: 10
            )
        } catch {
            return .failed("Could not run `devin auth status`: \(error.localizedDescription)")
        }
        let output = (result.stdout + "\n" + result.stderr)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if result.timedOut {
            return .failed("`devin auth status` timed out after 10 seconds.")
        }
        if result.status == 0, output.localizedCaseInsensitiveContains("Logged in") {
            return .authenticated
        }
        let signedOutMarkers = ["not logged in", "not authenticated", "logged out", "auth login"]
        if result.status == 0,
           signedOutMarkers.contains(where: output.localizedCaseInsensitiveContains) {
            return .signedOut
        }
        let detail = output.isEmpty ? "No output" : output
        return .failed("`devin auth status` failed (exit \(result.status)): \(detail)")
    }

    func logout() throws {
        let result = try ProcessRunner.run(
            executable: executable,
            arguments: ["auth", "logout"],
            timeout: 30
        )
        guard result.status == 0, !result.timedOut else {
            let detail = result.timedOut
                ? "`devin auth logout` timed out after 30 seconds."
                : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw NSError(
                domain: "LLMLocalGatewayApp",
                code: Int(result.status),
                userInfo: [NSLocalizedDescriptionKey: detail]
            )
        }
    }
}
