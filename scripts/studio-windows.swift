import CoreGraphics
import Foundation

// Lists the on-screen, layer-0 Roblox Studio windows as one JSON array:
//   [{ "id", "pid", "title", "bounds": { "X", "Y", "Width", "Height" }, "layer" }]
// It only reads the window server's list; it never activates or focuses
// anything, so inspection paths may call it freely.

let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []
var result: [[String: Any]] = []
for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    guard owner == "Roblox Studio" || owner == "RobloxStudio", layer == 0 else { continue }
    result.append([
        "id": window[kCGWindowNumber as String] as? Int ?? 0,
        "pid": window[kCGWindowOwnerPID as String] as? Int ?? 0,
        "title": window[kCGWindowName as String] as? String ?? "",
        "bounds": window[kCGWindowBounds as String] as? [String: Any] ?? [:],
        "layer": layer,
    ])
}
do {
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
} catch {
    FileHandle.standardError.write(Data("studio-windows: \(error)\n".utf8))
    exit(1)
}
