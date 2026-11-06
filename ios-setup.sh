#!/bin/bash
# 入金ナビ：iPhoneアプリのプロジェクトを組み立てる（Codemagic の Mac 上で実行）
# リポジトリはフォルダなし（iPhoneからアップロードできるように）なので、ここで並べ直す。
set -euo pipefail

echo "== 1. アプリの画面ファイルを www/ に集める"
rm -rf www && mkdir www
cp index.html app.js calc.js native.js hero.png www/

echo "== 2. iOSプロジェクトを作る"
rm -rf ios
npx cap add ios

APP=ios/App/App
echo "== 3. 独自機能（Swift）と iCloud の設定を入れる"
cp NyukinNativePlugin.swift MainViewController.swift "$APP/"
cp App.entitlements "$APP/App.entitlements"

# 起動画面を独自機能つきの画面に差し替える
STORY="$APP/Base.lproj/Main.storyboard"
sed -i '' 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="MainViewController" customModule="App" customModuleProvider="target"/' "$STORY"
if ! grep -q 'customClass="MainViewController"' "$STORY"; then
  echo "エラー：Main.storyboard を書きかえられませんでした" >&2
  grep -n "customClass" "$STORY" >&2 || true
  exit 1
fi

echo "== 4. アイコン"
ICON="$APP/Assets.xcassets/AppIcon.appiconset"
rm -f "$ICON"/*.png
cp AppIcon-1024.png "$ICON/AppIcon-1024.png"
cat > "$ICON/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "AppIcon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

echo "== 5. Info.plist"
PL="$APP/Info.plist"
PB=/usr/libexec/PlistBuddy
setp () { $PB -c "Set :$1 $3" "$PL" 2>/dev/null || $PB -c "Add :$1 $2 $3" "$PL"; }
setp CFBundleDisplayName string "入金ナビ"
setp CFBundleDevelopmentRegion string "ja"
setp ITSAppUsesNonExemptEncryption bool false
$PB -c "Delete :UISupportedInterfaceOrientations" "$PL" 2>/dev/null || true
$PB -c "Add :UISupportedInterfaceOrientations array" "$PL"
$PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PL"
$PB -c "Delete :UISupportedInterfaceOrientations~ipad" "$PL" 2>/dev/null || true

echo "== 6. Xcodeプロジェクトにファイルと設定を登録"
ruby ios-setup.rb

echo "== 7. 最終の同期"
npx cap sync ios
echo "== 完了"
