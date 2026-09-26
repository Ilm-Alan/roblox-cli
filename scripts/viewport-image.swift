import AppKit
import Foundation

func emit(_ value: [String: Any]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
}
let args = CommandLine.arguments
if args.count < 3 { fatalError("usage: viewport-image locate|crop image ...") }
let data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
guard let bitmap = NSBitmapImageRep(data: data) else { fatalError("Invalid image") }
if args[1] == "locate" {
    // Convert the bitmap's embedded display profile before reading components.
    // colorAt returns calibrated NSColor values and loses this source profile.
    guard let bitmap = bitmap.converting(to: .sRGB, renderingIntent: .default) else { fatalError("Cannot convert capture color profile") }
    let colors: [(Int, Int, Int)] = [(251,3,127),(3,251,127),(127,3,251),(251,127,3)]
    var boxes = colors.map { _ in [bitmap.pixelsWide, bitmap.pixelsHigh, -1, -1, 0] }
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
            guard let color = bitmap.colorAt(x: x, y: y) else { continue }
            let r = Int((color.redComponent*255).rounded()), g = Int((color.greenComponent*255).rounded()), b = Int((color.blueComponent*255).rounded())
            for (i,c) in colors.enumerated() where abs(r-c.0)<=3 && abs(g-c.1)<=3 && abs(b-c.2)<=3 {
                boxes[i][0] = min(boxes[i][0],x); boxes[i][1] = min(boxes[i][1],y)
                boxes[i][2] = max(boxes[i][2],x); boxes[i][3] = max(boxes[i][3],y); boxes[i][4] += 1
            }
        }
    }
    guard boxes.allSatisfy({ $0[4]>=4 }) else { fatalError("Calibration markers were not all visible") }
    let tl=boxes[0], tr=boxes[1], bl=boxes[2], br=boxes[3]
    guard abs(tl[0]-bl[0])<=2 && abs(tr[2]-br[2])<=2 && abs(tl[1]-tr[1])<=2 && abs(bl[3]-br[3])<=2 else { fatalError("Calibration markers do not form a rectangle") }
    let width=tr[2]-tl[0]+1, height=bl[3]-tl[1]+1
    let expectedWidth=Double(args[3])!, expectedHeight=Double(args[4])!
    guard width>0 && height>0 && abs(Double(width)/Double(height)-expectedWidth/expectedHeight)<0.015 else { fatalError("Calibration aspect ratio disagrees with the live viewport") }
    try emit(["x":tl[0],"y":tl[1],"width":width,"height":height,"markers":boxes])
} else if args[1] == "crop" {
    let rect=CGRect(x:Int(args[4])!,y:Int(args[5])!,width:Int(args[6])!,height:Int(args[7])!)
    guard let image=bitmap.cgImage?.cropping(to:rect) else { fatalError("Crop is outside the image") }
    let cropped=NSBitmapImageRep(cgImage:image)
    try cropped.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[3]))
    try emit(["width":cropped.pixelsWide,"height":cropped.pixelsHigh])
} else { fatalError("Unknown operation") }
