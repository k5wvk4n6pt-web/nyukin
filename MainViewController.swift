import UIKit
import Capacitor

/// アプリ内の独自機能（NyukinNativePlugin）を登録するための画面
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NyukinNativePlugin())
    }

    /// 開いた瞬間の背景を、選んでいるアプリの色に合わせる（画面の読み込み前のちらつきを防ぐ）
    override func viewDidLoad() {
        super.viewDidLoad()
        let color = MainViewController.launchColor()
        view.backgroundColor = color
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        webView?.isOpaque = false
    }

    static func launchColor() -> UIColor {
        var name = "blue"
        var theme = "light"
        if let text = UserDefaults.standard.string(forKey: "nyukin.store.kakeibo.meta.v1"),
           let data = text.data(using: .utf8),
           let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if (meta["proSeen"] as? Bool) == true, let c = meta["color"] as? String { name = c }
            if let t = meta["theme"] as? String { theme = t }
        }
        let light: [String: UInt32] = ["blue": 0xE3EEFB, "pink": 0xF7CFDD, "green": 0xC9EBD9, "purple": 0xD9CEF7, "orange": 0xF8D3B8]
        let dark: [String: UInt32] = ["blue": 0x13213A, "pink": 0x3A1D2E, "green": 0x173327, "purple": 0x241E3D, "orange": 0x382315]
        let l = UIColor(rgb: light[name] ?? 0xE3EEFB)
        let d = UIColor(rgb: dark[name] ?? 0x13213A)
        switch theme {
        case "dark": return d
        case "auto": return UIColor { $0.userInterfaceStyle == .dark ? d : l }
        default: return l
        }
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
