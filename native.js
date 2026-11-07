/* 引き落とし管理 — iPhoneアプリ版だけで動く部分（ウェブ版では何もしない）
 *  1. 入力データを端末の設定領域（UserDefaults）にも二重に保存する
 *  2. iCloud（キー値ストア）に全帳簿を自動バックアップする
 *  3. バックアップファイルを共有シートで保存する
 */
(function () {
  'use strict';
  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  let plugin = null;
  if (isNative) {
    try { plugin = typeof Cap.registerPlugin === 'function' ? Cap.registerPlugin('NyukinNative') : (Cap.Plugins && Cap.Plugins.NyukinNative); } catch (e) { plugin = null; }
  }
  const MIRROR = k => typeof k === 'string' && k.indexOf('kakeibo.') === 0 && k !== 'kakeibo.history.v1';
  const CLOUD_KEY = 'nyukin.books.v1';

  /** 起動前：端末の設定領域にあるデータを localStorage に戻す（WebKitのデータが消えた場合の備え） */
  async function hydrate() {
    if (!plugin) return;
    try {
      const res = await plugin.storeGetAll();
      const items = (res && res.items) || {};
      const ls = window.localStorage;
      for (const k of Object.keys(items)) if (MIRROR(k) && ls.getItem(k) == null) ls.setItem(k, items[k]);
      // 逆方向（以前の版で localStorage にだけあるもの）
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (MIRROR(k) && !(k in items)) plugin.storeSet({ key: k, value: ls.getItem(k) }).catch(() => {}); }
    } catch (e) { /* 失敗しても localStorage だけで動く */ }
    // 以後の書き込みを二重に保存
    const proto = Storage.prototype, set = proto.setItem, rem = proto.removeItem;
    proto.setItem = function (k, v) { set.call(this, k, v); if (this === window.localStorage && MIRROR(k)) plugin.storeSet({ key: k, value: String(v) }).catch(() => {}); };
    proto.removeItem = function (k) { rem.call(this, k); if (this === window.localStorage && MIRROR(k)) plugin.storeRemove({ key: k }).catch(() => {}); };
  }

  const api = {
    VERSION: '2026.11.07b',
    API: 1, // 画面側から使う機能の版。機能を変えたときだけ上げる
    isNative,
    ready: hydrate(),
    /** iCloudが使えるか */
    async cloudAvailable() { if (!plugin) return false; try { const r = await plugin.cloudStatus(); return !!(r && r.available); } catch (e) { return false; } },
    /** 全帳簿をiCloudへ（JSON文字列） */
    async cloudSave(obj) {
      if (!plugin) return false;
      try { const r = await plugin.cloudSet({ key: CLOUD_KEY, value: JSON.stringify(obj) }); return !!(r && r.ok); } catch (e) { return false; }
    },
    async cloudLoad() {
      if (!plugin) return null;
      try { const r = await plugin.cloudGet({ key: CLOUD_KEY }); return r && r.value ? JSON.parse(r.value) : null; } catch (e) { return null; }
    },
    /** ファイルを共有シートで保存。true=保存した / false=やめた */
    async shareFile(filename, text) {
      const r = await plugin.shareText({ filename, text });
      return !!(r && r.completed);
    }
  };
  window.NyukinNative = api;
})();
