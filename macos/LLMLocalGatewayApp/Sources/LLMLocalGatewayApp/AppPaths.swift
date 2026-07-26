import Foundation

struct AppPaths: Sendable {
    let home: URL
    let dataDirectory: URL
    let devinCredentials: URL
    let grokHome: URL
    let grokCredentials: URL
    let stableHelper: URL
    let serviceLog: URL

    static let current: AppPaths = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let currentData = home.appending(
            path: ".local/share/llm-local-gateway",
            directoryHint: .isDirectory
        )
        let legacyData = home.appending(
            path: ".local/share/llm-gateway",
            directoryHint: .isDirectory
        )
        let manager = FileManager.default
        let data =
            manager.fileExists(atPath: currentData.path)
            || !manager.fileExists(atPath: legacyData.path)
            ? currentData
            : legacyData
        let grokHome = home.appending(
            path: ".grok",
            directoryHint: .isDirectory
        )
        return AppPaths(
            home: home,
            dataDirectory: data,
            devinCredentials: home.appending(path: ".local/share/devin/credentials.toml"),
            grokHome: grokHome,
            grokCredentials: grokHome.appending(path: "auth.json"),
            stableHelper: data.appending(path: "bin/llm-local-gateway-helper"),
            serviceLog: data.appending(path: "gateway.log")
        )
    }()
}
