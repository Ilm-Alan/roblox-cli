import AppKit
import Foundation

// A lease observes app switches for its entire lifetime. It never reasserts focus.
let policy = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "auto"
let workspace = NSWorkspace.shared
let previous = workspace.frontmostApplication
let studios = workspace.runningApplications.filter { $0.bundleIdentifier == "com.Roblox.RobloxStudio" }
func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
guard studios.count == 1, let studio = studios.first else {
    emit(["error": "Exactly one Studio process is required for an input focus session"]); exit(1)
}
if policy == "never" && previous?.processIdentifier != studio.processIdentifier {
    emit(["error": "Studio is not foreground; --foreground never forbids activation", "code": "foreground_required"]); exit(1)
}
var ownerSwitched = false
var activated = false
let token = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
       app.processIdentifier != studio.processIdentifier { ownerSwitched = true }
}
if previous?.processIdentifier != studio.processIdentifier {
    activated = studio.activate(options: [])
    if !activated { emit(["error": "Studio could not be activated"]); exit(1) }
}
let deadline = Date().addingTimeInterval(2)
while workspace.frontmostApplication?.processIdentifier != studio.processIdentifier && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
if workspace.frontmostApplication?.processIdentifier != studio.processIdentifier {
    emit(["error": "Studio did not become foreground; no input session was acquired"]); exit(1)
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
