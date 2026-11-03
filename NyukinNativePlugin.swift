import Foundation
import UIKit
import Capacitor

/// 入金ナビのアプリ版だけの機能
/// - 端末の設定領域（UserDefaults）への二重保存
/// - iCloud キー値ストアへの自動バックアップ（全帳簿で数十KB程度。上限1MB）
/// - バックアップファイルの共有シート
@objc(NyukinNativePlugin)
public class NyukinNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NyukinNativePlugin"
    public let jsName = "NyukinNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "storeGetAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cloudStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cloudSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cloudGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareText", returnType: CAPPluginReturnPromise)
    ]

    private let defaults = UserDefaults.standard
    private let prefix = "nyukin.store."
    private let kv = NSUbiquitousKeyValueStore.default

    override public func load() {
        kv.synchronize()
    }

    // MARK: 端末の設定領域

    @objc func storeGetAll(_ call: CAPPluginCall) {
        var items: [String: String] = [:]
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(prefix) {
            if let text = value as? String {
                items[String(key.dropFirst(prefix.count))] = text
            }
        }
        call.resolve(["items": items])
    }

    @objc func storeSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key と value が必要です")
            return
        }
        defaults.set(value, forKey: prefix + key)
        call.resolve()
    }

    @objc func storeRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key が必要です")
            return
        }
        defaults.removeObject(forKey: prefix + key)
        call.resolve()
    }

    // MARK: iCloud

    @objc func cloudStatus(_ call: CAPPluginCall) {
        call.resolve(["available": FileManager.default.ubiquityIdentityToken != nil])
    }

    @objc func cloudSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key と value が必要です")
            return
        }
        guard FileManager.default.ubiquityIdentityToken != nil else {
            call.resolve(["ok": false, "reason": "iCloudにサインインしていません"])
            return
        }
        if value.utf8.count > 1_000_000 {
            call.resolve(["ok": false, "reason": "データが大きすぎます"])
            return
        }
        kv.set(value, forKey: key)
        kv.synchronize()
        call.resolve(["ok": true])
    }

    @objc func cloudGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key が必要です")
            return
        }
        kv.synchronize()
        if let value = kv.string(forKey: key) {
            call.resolve(["value": value])
        } else {
            call.resolve([:])
        }
    }

    // MARK: 共有シート

    @objc func shareText(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), let text = call.getString("text") else {
            call.reject("filename と text が必要です")
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            call.reject("ファイルを作れませんでした")
            return
        }
        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("画面が見つかりません")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                call.resolve(["completed": completed])
            }
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = viewController.view
                popover.sourceRect = CGRect(x: viewController.view.bounds.midX, y: viewController.view.bounds.maxY - 80, width: 1, height: 1)
            }
            viewController.present(sheet, animated: true)
        }
    }
}
