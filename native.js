/* 引落ナビ — iPhoneアプリ版だけで動く部分（ウェブ版では何もしない）
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
  let LN = null; // 端末の通知（@capacitor/local-notifications）
  if (isNative) { try { LN = typeof Cap.registerPlugin === 'function' ? Cap.registerPlugin('LocalNotifications') : (Cap.Plugins && Cap.Plugins.LocalNotifications); } catch (e) { LN = null; } }
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
    /** 通知の許可。ask=true なら許可を求める。'granted' / 'denied' / 'prompt' / 'unavailable' */
    async notifyPermission(ask) {
      if (!LN) return 'unavailable';
      try { let p = await LN.checkPermissions(); if (p.display !== 'granted' && ask) p = await LN.requestPermissions(); return p.display; } catch (e) { return 'unavailable'; }
    },
    /** 予約中のお知らせを入れ替える。list: [{ at: ミリ秒, title, body }] */
    async notifySchedule(list) {
      if (!LN) return false;
      const pend = await LN.getPending();
      if (pend && pend.notifications && pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
      if (list.length) await LN.schedule({ notifications: list.map((n, i) => ({ id: i + 1, title: n.title, body: n.body, schedule: { at: new Date(n.at), allowWhileIdle: true } })) });
      return true;
    },
    /** プレミアム（買い切り）の状態 { owned, available, price } */
    async proStatus() { if (!plugin) return { owned: false, available: false, price: '' }; try { return await plugin.proStatus(); } catch (e) { return { owned: false, available: false, price: '' }; } },
    /** プレミアムを購入 { owned, reason } */
    async proPurchase() { if (!plugin) return { owned: false, reason: 'unavailable' }; try { return await plugin.proPurchase(); } catch (e) { return { owned: false, reason: String(e && e.message || e) }; } },
    /** 購入の復元 { owned } */
    async proRestore() { if (!plugin) return { owned: false }; try { return await plugin.proRestore(); } catch (e) { return { owned: false }; } },
    /** ファイルを共有シートで保存。true=保存した / false=やめた */
    async shareFile(filename, text) {
      const r = await plugin.shareText({ filename, text });
      return !!(r && r.completed);
    }
  };
  window.NyukinNative = api;
})();
