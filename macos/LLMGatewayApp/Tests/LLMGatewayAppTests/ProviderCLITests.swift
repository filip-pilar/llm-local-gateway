import Darwin
import Foundation
import Testing
@testable import LLMGatewayApp

private func fakeCLI(_ source: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appending(path: "grok")
    try source.write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: executable.path
    )
    return executable
}

@Test func recognizesDevinAuthenticationStatus() throws {
    let executable = try fakeCLI("""
    #!/bin/sh
    test "$1" = "auth" || exit 8
    test "$2" = "status" || exit 8
    printf 'Logged in\n'
    """)
    defer { try? FileManager.default.removeItem(at: executable.deletingLastPathComponent()) }
    let cli = DevinCLI(executable: executable, version: "devin 3000.2.17")

    #expect(cli.authStatus() == .authenticated)
}

@Test func checksOAuthEntitlementWithoutShellAPIKeys() throws {
    let executable = try fakeCLI("""
    #!/bin/sh
    test -z "$XAI_API_KEY" || exit 9
    test -z "$GROK_API_KEY" || exit 9
    test "$1" = "--no-auto-update" || exit 8
    test "$2" = "models" || exit 8
    printf 'grok-4.5\n'
    """)
    defer { try? FileManager.default.removeItem(at: executable.deletingLastPathComponent()) }
    setenv("XAI_API_KEY", "must-not-reach-child", 1)
    setenv("GROK_API_KEY", "must-not-reach-child", 1)
    defer {
        unsetenv("XAI_API_KEY")
        unsetenv("GROK_API_KEY")
    }

    let cli = GrokCLI(executable: executable, version: "grok 0.2.111")
    #expect(cli.authStatus() == .authenticated)
}

@Test func redactsLogoutCommandFailures() throws {
    let secret = "credential-output-must-not-escape"
    let executable = try fakeCLI("""
    #!/bin/sh
    printf '\(secret)\n' >&2
    exit 1
    """)
    defer { try? FileManager.default.removeItem(at: executable.deletingLastPathComponent()) }
    let cli = GrokCLI(executable: executable, version: "grok 0.2.111")

    do {
        try cli.logout()
        Issue.record("logout unexpectedly succeeded")
    } catch {
        #expect(!error.localizedDescription.contains(secret))
    }
}
