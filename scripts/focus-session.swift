import AppKit
import Foundation

// The explicit `--foreground` lease. It activates Studio once, then observes
// app switches for its lifetime and never reasserts focus. macOS 14+
// cooperative activation may refuse a background process's request while the
// owner is using another app; that is reported as `refused` so the caller
// fails before the playtest starts instead of running at the background rate.
let workspace = NSWorkspace.shared
let previous = workspace.frontmostApplication
let studios = workspace.runningApplications.filter { $0.bundleIdentifier == "com.Roblox.RobloxStudio" }
func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
guard studios.count == 1, let studio = studios.first else {
    emit(["error": "Exactly one Studio process is required for a foreground session"]); exit(1)
}
var ownerSwitched = false
var activated = false
let token = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
       app.processIdentifier != studio.processIdentifier { ownerSwitched = true }
}
if previous?.processIdentifier != studio.processIdentifier {
    activated = studio.activate(options: [])
    if !activated { emit(["error": "Studio activation was refused", "refused": true]); exit(1) }
}
let deadline = Date().addingTimeInterval(2)
while workspace.frontmostApplication?.processIdentifier != studio.processIdentifier && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
if workspace.frontmostApplication?.processIdentifier != studio.processIdentifier {
    emit(["error": "Studio did not become the frontmost app", "refused": true]); exit(1)
}
emit(["acquired": true, "activated": activated, "studio_pid": studio.processIdentifier, "previous_pid": previous?.processIdentifier ?? 0])
DispatchQueue.global().async {
    _ = FileHandle.standardInput.availableData
    DispatchQueue.main.async {
        var restored = false
        if activated && !ownerSwitched && workspace.frontmostApplication?.processIdentifier == studio.processIdentifier,
           let previous = previous, !previous.isTerminated { restored = previous.activate(options: []) }
        workspace.notificationCenter.removeObserver(token)
        emit(["released": true, "restored": restored, "owner_switched": ownerSwitched])
        exit(0)
    }
}
RunLoop.main.run()
