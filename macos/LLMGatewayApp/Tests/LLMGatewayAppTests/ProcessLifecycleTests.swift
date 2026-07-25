import Darwin
import Foundation
import Testing
@testable import LLMGatewayApp

@Test func waitsForGracefulLifelineShutdown() async throws {
    let process = Process()
    let lifeline = Pipe()
    process.executableURL = URL(filePath: "/bin/sh")
    process.arguments = ["-c", "read value || exit 0"]
    process.standardInput = lifeline
    try process.run()

    await ProcessLifecycle.stop(
        process,
        lifeline: lifeline,
        gracefulTimeout: .seconds(1),
        terminateTimeout: .milliseconds(100)
    )

    #expect(!process.isRunning)
    #expect(process.terminationReason == .exit)
    #expect(process.terminationStatus == 0)
}

@Test func forceKillsAProcessThatIgnoresTermination() async throws {
    let process = Process()
    let readiness = Pipe()
    let ready = DispatchSemaphore(value: 0)
    process.executableURL = URL(filePath: "/bin/sh")
    process.arguments = ["-c", "trap '' TERM; printf 'ready\\n'; while :; do :; done"]
    process.standardOutput = readiness
    readiness.fileHandleForReading.readabilityHandler = { handle in
        if String(decoding: handle.availableData, as: UTF8.self).contains("ready") {
            ready.signal()
        }
    }
    try process.run()
    defer {
        readiness.fileHandleForReading.readabilityHandler = nil
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    let readinessResult = await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(returning: ready.wait(timeout: .now() + 2))
        }
    }
    try #require(readinessResult == .success)
    readiness.fileHandleForReading.readabilityHandler = nil

    await ProcessLifecycle.stop(
        process,
        lifeline: nil,
        gracefulTimeout: .milliseconds(50),
        terminateTimeout: .milliseconds(50)
    )

    #expect(!process.isRunning)
    #expect(process.terminationReason == .uncaughtSignal)
    #expect(process.terminationStatus == SIGKILL)
}
