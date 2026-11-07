# 引き落とし管理：Xcodeプロジェクトに独自のSwiftファイルとiCloudの設定を登録する
require 'xcodeproj'

path = 'ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(path)
target = project.targets.find { |t| t.name == 'App' } or abort('エラー：App ターゲットが見つかりません')

group = project.main_group.children.find { |g| g.respond_to?(:path) && (g.path == 'App' || g.name == 'App') }
if group.nil? || !group.respond_to?(:new_reference)
  # Xcode 16 形式（フォルダ同期）の場合は、App フォルダに置いたファイルが自動で含まれる
  puts '注意：App グループが見つからないため、フォルダ同期として扱います'
else
  %w[NyukinNativePlugin.swift MainViewController.swift].each do |file|
    ref = group.files.find { |f| f.path == file } || group.new_reference(file)
    unless target.source_build_phase.files_references.include?(ref)
      target.add_file_references([ref])
      puts "追加：#{file}"
    end
  end
  group.files.find { |f| f.path == 'App.entitlements' } || group.new_reference('App.entitlements')
end

target.build_configurations.each do |config|
  s = config.build_settings
  s['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  s['TARGETED_DEVICE_FAMILY'] = '1'           # iPhoneのみ
  s['MARKETING_VERSION'] = '1.0.0'
  s['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  s['INFOPLIST_KEY_CFBundleDisplayName'] = '引き落とし管理'
end

project.save
puts '保存：' + path
