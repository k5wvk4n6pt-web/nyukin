import Foundation
import UIKit
import Capacitor
import StoreKit

/// 引落ナビのアプリ版だけの機能
/// - 端末の設定領域（UserDefaults）への二重保存
/// - iCloud キー値ストアへの自動バックアップ（全帳簿で数十KB程度。上限1MB）
/// - バックアップファイルの共有シート
/// - プレミアム（買い切りのアプリ内課金・StoreKit 2）の購入・復元・確認
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
        CAPPluginMethod(name: "shareText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "proStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "proPurchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "proRestore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "iconGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "iconSet", returnType: CAPPluginReturnPromise)
    ]
    private let iconNames: [String: String] = ["pink": "AppIconPink", "green": "AppIconGreen", "purple": "AppIconPurple", "orange": "AppIconOrange"]
    /// App Store Connect で作る「非消耗型」のアプリ内課金の製品ID
    private let proID = "com.k5wvk4n6pt.nyukinnavi.pro"
    private var updatesTask: Task<Void, Never>?

    private let defaults = UserDefaults.standard
    private let prefix = "nyukin.store."
    private let kv = NSUbiquitousKeyValueStore.default

    override public func load() {
        kv.synchronize()
        if #available(iOS 15.0, *) {
            // 別の端末での購入・返金などの知らせを受け取って完了させる
            updatesTask = Task.detached {
                for await result in Transaction.updates {
                    if case .verified(let transaction) = result { await transaction.finish() }
                }
            }
        }
    }

    // MARK: ホーム画面のアイコン（プレミアム・アプリの色とそろえる）

    @objc func iconGet(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let app = UIApplication.shared
            let current = self.iconNames.first(where: { $0.value == app.alternateIconName })?.key ?? "blue"
            call.resolve(["supported": app.supportsAlternateIcons, "name": current])
        }
    }

    @objc func iconSet(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "blue"
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.supportsAlternateIcons else {
                call.resolve(["ok": false])
                return
            }
            let target = self.iconNames[name]  // ブルーは nil（元のアイコン）
            if app.alternateIconName == target {
                call.resolve(["ok": true])
                return
            }
            app.setAlternateIconName(target) { error in
                call.resolve(["ok": error == nil])
            }
        }
    }

    // MARK: プレミアム（アプリ内課金）

    @available(iOS 15.0, *)
    private func ownsPro() async -> Bool {
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, transaction.productID == proID, transaction.revocationDate == nil {
                return true
            }
        }
        return false
    }

    @objc func proStatus(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else {
            call.resolve(["owned": false, "available": false, "price": ""])
            return
        }
        Task {
            let owned = await self.ownsPro()
            let product = try? await Product.products(for: [self.proID]).first
            call.resolve(["owned": owned, "available": product != nil, "price": product?.displayPrice ?? ""])
        }
    }

    @objc func proPurchase(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else {
            call.resolve(["owned": false, "reason": "このiPhoneのiOSでは購入できません（iOS 15以降が必要です）"])
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [self.proID]).first else {
                    call.resolve(["owned": false, "reason": "notfound"])
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    if case .verified(let transaction) = verification {
                        await transaction.finish()
                        call.resolve(["owned": true])
                    } else {
                        call.resolve(["owned": false, "reason": "購入を確認できませんでした"])
                    }
                case .userCancelled:
                    call.resolve(["owned": false, "reason": "cancelled"])
                case .pending:
                    call.resolve(["owned": false, "reason": "pending"])
                @unknown default:
                    call.resolve(["owned": false, "reason": "unknown"])
                }
            } catch {
                call.resolve(["owned": false, "reason": error.localizedDescription])
            }
        }
    }

    @objc func proRestore(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else {
            call.resolve(["owned": false])
            return
        }
        Task {
            try? await AppStore.sync()
            call.resolve(["owned": await self.ownsPro()])
        }
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
