import Darwin
import Foundation

enum ProcessLifecycle {
    static func stop(
        _ process: Process,
        lifeline: Pipe?,
        gracefulTimeout: Duration = .seconds(2),
        terminateTimeout: Duration = .seconds(2)
    ) async {
        try? lifeline?.fileHandleForWriting.close()
        if await waitForExit(process, timeout: gracefulTimeout) { return }

        if process.isRunning { process.terminate() }
        if await waitForExit(process, timeout: terminateTimeout) { return }

        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            _ = await waitForExit(process, timeout: .seconds(2))
        }
    }

    private static func waitForExit(_ process: Process, timeout: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while process.isRunning, clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        return !process.isRunning
    }
}
