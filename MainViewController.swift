import UIKit
import Capacitor

/// アプリ内の独自機能（NyukinNativePlugin）を登録するための画面
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NyukinNativePlugin())
    }
}
