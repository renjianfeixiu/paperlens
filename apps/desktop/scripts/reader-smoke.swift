import AppKit
import WebKit

// Real system WebKit, isolated storage, and an explicitly supplied local PDF.
final class Runner: NSObject, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    func start() throws {
        let bytes = CommandLine.arguments[1] == "-" ? Data() : try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "result")
        config.userContentController.addUserScript(WKUserScript(source: "window.pdfBase64 = '\(bytes.base64EncodedString())';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 900), configuration: config)
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        window.orderFrontRegardless()
        let url = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "http://127.0.0.1:1420/scripts/reader-smoke.html"
        webView.load(URLRequest(url: URL(string: url)!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { print("TIMEOUT"); exit(2) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        print(message.body)
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              result["done"] as? Bool == true else { return }
        let passed = result["ok"] as? Bool == true
        if passed && CommandLine.arguments.count > 2 {
            webView.takeSnapshot(with: nil) { image, error in
                if let tiff = image?.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    do {
                        try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
                        print("Snapshot: \(CommandLine.arguments[2])")
                    } catch { print(error); exit(2) }
                } else { print(error ?? NSError(domain: "snapshot", code: 1)); exit(2) }
                exit(0)
            }
        } else { exit(passed ? 0 : 1) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner()
try runner.start()
app.run()
