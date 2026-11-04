/* 入金ナビ — 画面・保存・バックアップ（データはこの端末の中だけに保存し、外部へは送信しません） */
(function () {
  'use strict';
  const C = window.KCalc;
  const APP_VERSION = '2026.11.04c';
  /** ファイルの一部だけが新しい（アップロード漏れ・古いキャッシュ）と計算が合わなくなるので知らせる */
  /** 古いままのファイル名（なければ空）。native.js は中身が変わったときだけ気にする */
  function staleFiles() {
    const out = [];
    if (!C || C.VERSION !== APP_VERSION) out.push('calc.js');
    if (!window.NyukinNative || (window.NyukinNative.API || 1) < 1) out.push('native.js');
    return out;
  }
  function versionMismatch() { return staleFiles().length > 0; }
  const N = window.NyukinNative || { isNative: false, ready: Promise.resolve() };
  let cloud = { available: false, data: null }; // iCloud（アプリ版のみ）
  const KEY = 'kakeibo.data.v1';
  const META = 'kakeibo.meta.v1';
  const HISTORY = 'kakeibo.history.v1';
  const HISTORY_DAYS = 7;
  function backupEvery() { return [0, 7, 14, 30].includes(meta.backupEvery) ? meta.backupEvery : 30; }

  let state = null;
  let meta = {};
  let lastSavedAt = null;
  let todayKey = '';

  const $ = (s, r = document) => r.querySelector(s);
  const main = $('#main');
  const nf = new Intl.NumberFormat('ja-JP');

  /* ---------- 共通 ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function yen(n) { return n == null ? '未入力' : nf.format(n) + '<span class="yen">円</span>'; }
  function yenTxt(n) { return n == null ? '' : nf.format(n); }
  function md(dt) { return dt.m + '/' + dt.d; }
  function mdw(dt) { const w = C.weekday(dt); return md(dt) + '(' + C.WD[w] + ')'; }
  function isWeekend(dt) { return !C.isBusinessDay(dt); } // 土日・祝日・年末年始
  const SHIFT_LABEL = { after: '休日なら後ろ（翌営業日）', before: '休日なら前（前営業日）', none: 'ずらさない' };
  function shiftSelect(id, mode, aria) {
    return '<select id="' + id + '" data-f="shift" aria-label="' + (aria || '休日の場合') + '">' + ['after', 'before', 'none'].map(k => '<option value="' + k + '"' + (k === mode ? ' selected' : '') + '>' + SHIFT_LABEL[k] + '</option>').join('') + '</select>';
  }
  function validShift(v, def) { return ['after', 'before', 'none'].includes(v) ? v : def; }
  /** 休日でずれた日付の注記 */
  function shiftNote(dt) { if (!dt || !dt.orig) return ''; const n = C.holidayName(dt.orig); return '<span class="shifted">（' + md(dt.orig) + 'が' + (n || '休日') + '）</span>'; }
  function today() { return C.fromDate(new Date()); }
  function keyOf(dt) { return dt.y + '-' + dt.m + '-' + dt.d; }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function dayLabel(d) { return d === 'end' ? '月末' : d + '日'; }

  /** 金額入力の読み取り（全角数字・カンマ・円を許容。空欄は「未入力」= null） */
  function parseAmount(s) {
    const t = String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，円¥￥\s]/g, '');
    if (t === '') return null;
    if (!/^\d+$/.test(t)) return NaN;
    return Number(t);
  }

  /** 更新日時の表示（日付だけの値は取り込んだデータの日付） */
  function stampText(v) {
    if (!v) return '更新：—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return '更新：' + m + '/' + d + '（取り込み）'; }
    const t = new Date(v); if (isNaN(t)) return '更新：—';
    const y = t.getFullYear() !== new Date().getFullYear() ? t.getFullYear() + '/' : '';
    return '更新：' + y + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }
  function timeText(t) { return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); }

  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ---------- 保存 ---------- */
  /* 帳簿：人ごとに別のデータ。最初の帳簿（id: main）は以前からの保存場所をそのまま使う */
  const BOOKS = 'kakeibo.books.v1';
  let books = null; // { current, list: [{ id, name }] }
  function dataKey(id) { return id === 'main' ? KEY : KEY + ':' + id; }
  function readBook(id) { try { const s = localStorage.getItem(dataKey(id)); return s ? normalize(JSON.parse(s)) : null; } catch (e) { return null; } }
  function allBooksData(now) {
    return { app: 'kakeibo', kind: 'books', version: 2, exportedAt: now.toISOString(), current: books.current,
      books: books.list.map(b => ({ id: b.id, name: b.name, data: b.id === books.current ? state : (readBook(b.id) || emptyState()) })) };
  }
  /** 1日1回、全帳簿の内容を端末内の履歴に残す（7日分） */
  function snapshot() {
    try {
      const now = new Date(); const day = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
      let h = JSON.parse(localStorage.getItem(HISTORY) || '[]'); if (!Array.isArray(h)) h = [];
      const label = (now.getMonth() + 1) + '/' + now.getDate() + '(' + C.WD[now.getDay()] + ') ' + timeText(now) + ' 時点';
      const entry = { day, label, at: now.toISOString(), books: books.list.map(b => ({ name: b.name })), data: allBooksData(now) };
      if (h[0] && h[0].day === day) h[0] = entry; else h.unshift(entry);
      localStorage.setItem(HISTORY, JSON.stringify(h.slice(0, HISTORY_DAYS)));
    } catch (e) { /* 容量不足などのときは履歴だけあきらめる */ }
    if (N.isNative && cloud.available && books) {
      const now = new Date();
      N.cloudSave(allBooksData(now)).then(ok => { if (ok) { meta.cloudAt = now.toISOString(); saveMeta(); const el = $('#cloudAt'); if (el) el.textContent = stampText(meta.cloudAt).replace('更新：', ''); } });
    }
  }
  function saveBooks() { try { localStorage.setItem(BOOKS, JSON.stringify(books)); } catch (e) { /* 次の保存で再試行 */ } }
  function ensureBooks() { if (!books) { books = { current: 'main', list: [{ id: 'main', name: 'メイン' }] }; saveBooks(); } }
  function curBook() { return books && books.list.find(b => b.id === books.current); }
  function load() {
    try { meta = JSON.parse(localStorage.getItem(META) || '{}') || {}; } catch (e) { meta = {}; }
    try { books = JSON.parse(localStorage.getItem(BOOKS) || 'null'); } catch (e) { books = null; }
    if (books && (!Array.isArray(books.list) || !books.list.length)) books = null;
    if (!books && localStorage.getItem(KEY)) ensureBooks(); // 以前の版のデータ
    if (books && !curBook()) books.current = books.list[0].id;
    state = books ? (readBook(books.current) || emptyState()) : null;
  }
  function switchBook(id) {
    if (!books || id === books.current) return;
    books.current = id; saveBooks();
    state = readBook(id) || emptyState();
    meta.page = 'prep'; meta.reorder = null; saveMeta();
    renderAll(); window.scrollTo(0, 0); toast('「' + curBook().name + '」の帳簿を開きました');
  }
  function save() {
    try {
      ensureBooks();
      localStorage.setItem(dataKey(books.current), JSON.stringify(state));
      clearTimeout(save._h); save._h = setTimeout(snapshot, 1500);
      lastSavedAt = new Date();
      $('#saved').textContent = '自動保存 ' + timeText(lastSavedAt);
    } catch (e) {
      $('#saved').textContent = '保存できませんでした';
      toast('保存できませんでした。バックアップを保存してください');
    }
  }
  function saveMeta() { try { localStorage.setItem(META, JSON.stringify(meta)); } catch (e) { /* 表示だけの情報 */ } }

  function validDay(d) { return d === 'end' || (Number.isInteger(d) && d >= 1 && d <= 31); }
  function validAmt(a) { return a === null || (typeof a === 'number' && isFinite(a) && a >= 0); }

  /** 読み込んだデータの形をそろえる。おかしな値があれば例外 */
  function normalize(d) {
    if (!d || d.app !== 'kakeibo' || !Array.isArray(d.accounts) || !Array.isArray(d.variable) || !Array.isArray(d.fixed)) throw new Error('入金準備帳のデータではありません');
    const item = (x, fixed) => {
      const o = { id: x.id || uid(fixed ? 'f' : 'v'), name: String(x.name || '').trim() || '（名称なし）', day: x.day, account: x.account || '', amount: x.amount == null ? null : Number(x.amount), memo: x.memo || '', updatedAt: x.updatedAt || null, hidden: !!x.hidden, shift: validShift(x.shift, 'after') };
      if (fixed === 'once') {
        o.date = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? String(x.date) : null; delete o.day;
        if (!o.date) throw new Error('日付が読み取れない項目があります：' + o.name);
        if (!validAmt(o.amount)) throw new Error('金額が読み取れない項目があります：' + o.name);
        return o;
      }
      if (fixed) o.end = x.end || null;
      if (!validDay(o.day)) throw new Error('引落日が読み取れない項目があります：' + o.name);
      if (!validAmt(o.amount)) throw new Error('金額が読み取れない項目があります：' + o.name);
      return o;
    };
    const out = {
      app: 'kakeibo', version: 1, source: d.source || '', sample: !!d.sample,
      accounts: d.accounts.map(String),
      variable: d.variable.map(x => item(x, false)),
      fixed: d.fixed.map(x => item(x, true)),
      once: Array.isArray(d.once) ? d.once.map(x => item(x, 'once')) : [],
      balances: {},
      settings: (() => { const cs = C.closeSettings(d); return { closeDay: cs.d1.day, closeShift: cs.d1.shift, close2Day: cs.d2.day, close2Shift: cs.d2.shift }; })(),
      excludeSurplus: Array.isArray(d.excludeSurplus) ? d.excludeSurplus.map(String).filter(a => d.accounts.map(String).includes(a)) : [],
      hiddenAccounts: Array.isArray(d.hiddenAccounts) ? d.hiddenAccounts.map(String).filter(a => d.accounts.map(String).includes(a)) : [],
      income: Array.isArray(d.income) && d.income.length ? d.income.map(i => ({ id: i.id || uid('i'), name: String(i.name), day: i.day, amount: i.amount == null ? null : Number(i.amount), hidden: !!i.hidden, shift: validShift(i.shift, 'before') }))
        : [],
      transfers: Array.isArray(d.transfers) ? d.transfers.filter(t => t && t.from && t.to && Number(t.amount) > 0).map(t => ({ id: t.id || uid('t'), at: t.at || null, fromBook: t.fromBook || null, from: String(t.from), toBook: t.toBook || null, to: String(t.to), amount: Number(t.amount), fee: Number(t.fee) || 0, feeFrom: t.feeFrom === 'amount' ? 'amount' : 'source', undone: !!t.undone })).slice(0, 30) : []
    };
    for (const a of out.accounts) {
      const b = (d.balances || {})[a] || {};
      out.balances[a] = { amount: b.amount == null ? null : Number(b.amount), updatedAt: b.updatedAt || null };
    }
    return out;
  }

  /* ---------- 画面 ---------- */
  function renderAll() {
    const T = today(); todayKey = keyOf(T);
    $('#nav').hidden = !state;
    const bk = $('#books');
    bk.hidden = !state;
    if (state && books) {
      bk.innerHTML = books.list.map((b, i) => '<button class="book b' + (i % 5) + (b.id === books.current ? ' on' : '') + '" data-book="' + esc(b.id) + '"' + (b.id === books.current ? ' aria-current="true"' : '') + '>' + esc(b.name) + '</button>').join('') +
        '<button class="book add" data-act="book-add" aria-label="帳簿を追加">＋ 帳簿</button>';
    }
    $('#today').textContent = T.y + '年' + T.m + '月' + T.d + '日(' + C.WD[C.weekday(T)] + ')';
    if (!state) { main.innerHTML = welcomeHTML(); bindWelcome(); return; }
    if (versionMismatch()) {
      main.innerHTML = '<div class="notice"><div><b>アプリのファイルが一部だけ古いままです。</b><br>古いファイル：<b>' + staleFiles().join('、') + '</b><br>このファイルをアップロードし直してください。アップロード済みなら、アプリを閉じて数分後に開き直してください。（app.js：' + APP_VERSION + '／calc.js：' + (C && C.VERSION || '古い版') + '）</div></div>';
      return;
    }
    const r = C.compute(state, T);
    const page = PAGES.includes(meta.page) ? meta.page : 'prep';
    main.innerHTML = page === 'variable' ? listHTML('variable', '変動費', '毎月の金額をここで入力します。') + listHTML('once', '1回のみの引落', '日付を決めて1回だけ引き落とされるもの（年払い・臨時の支払いなど）。過ぎたものは「済み」にまとまります。')
      : page === 'fixed' ? listHTML('fixed', '固定費', '金額・引落日・口座が変わった時だけ変更します。')
      : page === 'settings' ? settingsHTML()
      : sampleBannerHTML() + (needsSetup() ? setupGuideHTML() : backupNoticeHTML()) + summaryHTML(r) + banksHTML(r) +
        '<p class="note">表示される金額と日付は、登録した内容から計算した目安です。実際の引落日・金額は金融機関やカード会社の案内で確認してください。</p>';
    if (typeof syncFab === 'function') setTimeout(syncFab, 0);
    document.body.className = document.body.className.replace(/\bpg-\S+/g, '').trim() + ' pg-' + page;
    $('#nav').querySelectorAll('[data-page]').forEach(b => { const on = b.dataset.page === page; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    bindAll();
    if (typeof syncTyping === 'function') syncTyping();
  }

  /** 入力中は入力欄を作り直さず、数字だけ書き換える */
  function refreshNumbers() {
    const r = C.compute(state, today());
    main.querySelectorAll('[data-sum]').forEach(el => { el.innerHTML = yen(r.totals[el.dataset.sum]); });
    const sb = $('#shortbox'); if (sb) { sb.outerHTML = shortboxHTML(r); const bb = main.querySelector('#shortbox [data-act="bulk"]'); if (bb) bb.addEventListener('click', openBulk); }
    const cyc = $('#cycleSec'); if (cyc) { cyc.outerHTML = cycleHTML(); bindCycle(); }
    if (!$('#banksSec')) return;
    const shown = [...main.querySelectorAll('.bank:not(.idlebank)')].map(c => c.dataset.bank).join('|');
    if (shown !== r.banks.filter(b => b.active).map(b => b.name).join('|')) {
      const sec = $('#banksSec'); sec.outerHTML = banksHTML(r); bindBalances(); return;
    }
    for (const b of r.banks) {
      const card = main.querySelector('.bank[data-bank="' + CSS.escape(b.name) + '"]');
      if (!card) continue;
      card.querySelectorAll('[data-bsum]').forEach(el => { el.innerHTML = yen(b.sums[el.dataset.bsum]); });
      const st = card.querySelector('[data-status]'); if (st) st.outerHTML = statusHTML(b, r);
      const af = card.querySelector('[data-after]'); if (af) af.outerHTML = afterHTML(b, r);
      const xb = card.querySelector('.cardacts [data-act^="xfer"]');
      if (xb && !card.classList.contains('idlebank') && xb.dataset.act !== (b.shortfall > 0 ? 'xfer-to' : 'xfer-from')) {
        xb.outerHTML = xferBtn(b);
        const nb = card.querySelector('.cardacts [data-act^="xfer"]');
        nb.addEventListener('click', () => { if (nb.dataset.act === 'xfer-from') openTransfer('', nb.dataset.acc); else openTransfer(nb.dataset.acc); });
      }
      card.classList.toggle('is-short', b.shortfall > 0);
      const ln = card.querySelector('.line-list'); if (ln) ln.innerHTML = linesInner(b, r.windows);
      const nx = card.querySelector('.next'); if (nx) nx.innerHTML = nextHTML(b);
    }
  }

  function welcomeHTML() {
    return '<section class="welcome">' +
      '<h2>はじめに</h2>' +
      '<p>口座ごとに「次の締め日（初期設定は毎月10日。変更できます）までに、いくら入れておけばよいか」を計算するアプリです。給料日や引落日が休日に当たる場合のずれも計算します。</p>' +
      '<p class="sub" style="margin:0">入力した内容はこの端末の中だけに保存され、外部には送信しません。ログインも不要です。</p>' +
      '<div class="btnrow col"><button class="primary" data-act="start-empty">空の状態ではじめる</button>' +
      '<button data-act="start-sample">サンプルデータで試してみる</button>' +
      (cloud.data ? '<button data-act="cloud-restore">iCloudのバックアップから復元（' + esc(cloudWhen()) + '）</button>' : '') +
      '<label class="fileBtn">バックアップファイルから復元<input type="file" id="restoreFile" accept=".json,application/json"></label></div>' +
      (N.isNative ? '' : '<p class="note">iPhoneでは、Safariの共有ボタンから「ホーム画面に追加」して、ホーム画面のアイコンから使うのがおすすめです（Safariとホーム画面のアプリは、データの保存場所が別になります）。</p>') +
      '<button class="ghost small" data-act="help">使い方を見る</button></section>';
  }

  function cloudWhen() { return cloud.data && cloud.data.exportedAt ? stampText(cloud.data.exportedAt).replace('更新：', '') : ''; }

  function emptyState() { return { app: 'kakeibo', version: 1, source: '', settings: { closeDay: 10, closeShift: 'after', close2Day: 'end', close2Shift: 'none' }, once: [], accounts: [], variable: [], fixed: [], balances: {}, hiddenAccounts: [], income: [] }; }

  /** 架空のサンプル（人名・実在の口座名は使わない） */
  function sampleState() {
    const now = new Date().toISOString();
    const v = (name, day, account, amount) => ({ id: uid('v'), name, day, account, amount, memo: '', updatedAt: now, hidden: false, shift: 'after' });
    const f = (name, day, account, amount, end) => ({ id: uid('f'), name, day, account, amount, end: end || null, memo: '', updatedAt: now, hidden: false, shift: 'after' });
    const A = '生活費口座', B = 'カード引落口座', L = 'ローン口座', M = '現金';
    const d = { app: 'kakeibo', version: 1, source: 'サンプル', sample: true, accounts: [A, B, L, M], hiddenAccounts: [],
      variable: [v('クレジットカードA', 27, B, 48000), v('クレジットカードB', 10, B, 23500), v('電気代', 26, A, 9800), v('ガス代', 26, A, 5200), v('水道代', 'end', A, 0)],
      fixed: [f('家族のこづかい', 25, M, 30000), f('住宅ローン', 27, L, 85000, '2045-03'), f('携帯電話', 26, A, 6800), f('生命保険', 27, A, 12000), f('習い事', 5, A, 8000), f('家電の分割払い', 1, B, 4500, '2027-06')],
      balances: {}, income: [{ id: uid('i'), name: '給料', day: 25, amount: 280000, hidden: false, shift: 'before' }, { id: uid('i'), name: '児童手当', day: 10, amount: null, hidden: false, shift: 'before' }] };
    d.balances[A] = { amount: 40000, updatedAt: now }; d.balances[B] = { amount: 60000, updatedAt: now }; d.balances[L] = { amount: 90000, updatedAt: now }; d.balances[M] = { amount: null, updatedAt: null };
    return d;
  }
  function sampleBannerHTML() {
    if (!state.sample) return '';
    return '<div class="notice"><div><b>サンプルデータを表示しています。</b><br>口座名や金額はすべて架空です。自由に触って試してみてください。</div>' +
      '<div class="btnrow"><button class="primary" data-act="sample-clear">サンプルを消して自分のデータではじめる</button>' +
      '<label class="fileBtn">バックアップから復元<input type="file" id="restoreFile" accept=".json,application/json"></label></div></div>';
  }
  function allItems() { return state.variable.concat(state.fixed, state.once || []); }
  function needsSetup() { return !state.sample && (state.accounts.length === 0 || allItems().length === 0); }
  function setupGuideHTML() {
    const hasAcc = state.accounts.length > 0, hasItem = allItems().length > 0;
    const step = (done, n, title, sub, btn, act) => '<li class="' + (done ? 'done' : '') + '"><span class="stepn">' + (done ? '✓' : n) + '</span><span class="stept"><b>' + title + '</b><small>' + sub + '</small></span>' + (btn ? '<button class="small' + (done ? '' : ' primary') + '" data-act="' + act + '">' + btn + '</button>' : '') + '</li>';
    return '<section class="guide"><h2>はじめの設定</h2><ol>' +
      step(hasAcc, 1, '口座を登録', '引落に使う銀行口座など', '登録する', 'go-acc') +
      step(hasItem, 2, '支出を登録', '毎月の引落（カード・ローン・公共料金など）', '登録する', 'go-out') +
      step(state.income.length > 0, 3, '収入を登録（任意）', '給料日などの予定を表示します', '登録する', 'go-in') +
      step(false, 4, '口座の残高を入力', 'このページの各口座に入力すると、不足と余りが出ます', '', '') +
      '</ol>' +
      '<div class="restore-line"><span class="sub">以前のデータがある場合は</span><label class="fileBtn">バックアップから復元<input type="file" id="restoreFile" accept=".json,application/json"></label></div>' +
      '</section>';
  }

  function helpHTML() {
    return '<div class="help">' +
      '<h3>できること</h3><p>登録した毎月の引落をもとに、口座ごとに「締め日までに必要な金額」を計算します。残高を入力すると、不足している口座と余っている口座がわかります。</p>' +
      '<h3>期限と期間</h3><p>「いつまでに必要か」の期限を2つ設定できます（初期設定は10日と月末）。期限1が締め日で、確認日から次の締め日までの引落で不足と余りを判定します。期限2の分は参考として表示します。「設定 → 帳簿」で、それぞれ1〜28日または月末と、休日に当たったときの扱い（後ろ・前・ずらさない）に変えられます。確認日（今日）から次の締め日までの引落で、不足と余りを判定します。</p>' +
      '<h3>休日のずれ</h3><p>土日・祝日・年末年始（12/31〜1/3）に当たる日は、項目ごとに「後ろにずらす／前にずらす／ずらさない」を選べます。初期値は、支出が後ろ（翌営業日）、収入が前（前営業日）です。</p>' +
      '<h3>締め期間の収支</h3><p>準備ページの「締め期間の収支」に、締め日の翌日から次の締め日までの収入の合計・支出の合計・差し引きが出ます。‹ › で前後の期間も見られます。</p>' +
      '<h3>移動と追加</h3><p>下のタブで今のページをもう一度押すか、右下の「↑」で一番上に戻れます。変動費・固定費のページでは、右下の「＋」や見出しの「＋ 追加」から、ページを移らずに追加できます。「追加して続ける」で何件も続けて入れられます。</p>' +
      '<h3>帳簿</h3><p>家族のお金なども、人ごとに別の帳簿で管理できます。画面上の名前をタップすると切り替わり、「＋ 帳簿」で追加できます。バックアップは全部の帳簿をまとめて保存します。</p>' +
      '<h3>口座間の移動</h3><p>不足している口座の「ほかの口座から移す」は、その口座へ入れる移動です。それ以外の口座の「ほかの口座へ移す」は、その口座から出す移動です。ほかの帳簿の口座（自分 → 母など）や、非表示の口座とも移動できます。「不足をまとめて解消する」を押すと、余りのある口座から不足している口座へ移す案をまとめて作ります。準備ページの「ほかの口座から移す」「口座間で移す」で、実際に移したお金を記録すると、両方の残高が書きかわります。不足している口座から開くと、不足額が最初から入ります。手数料は「移動元から別に引く」か「移す金額から引く」を選べ、口座の組み合わせごとに前回の手数料を覚えます。間違えたときは「最近の移動」から取り消せます。</p>' +
      '<h3>1回のみの引落</h3><p>年払いの保険や税金など、決まった日に1回だけ引き落とされるものは、「設定 → 支出 → 1回のみ」で日付を指定して追加します。変動費ページの下に並び、日付が過ぎると「済み」にまとまります。</p>' +
      '<h3>非表示</h3><p>使わなくなった項目・口座・収入は非表示にできます。非表示にしたものは計算に含みません。</p>' +
      '<h3>データの保存</h3><p>入力した内容は変更するたびに自動で、この端末の中だけに保存され、外部には送信しません（アプリ版でiCloudがオンの場合は、あなたのiCloudにも自動でバックアップします）。入力を間違えたときは「設定 → 保存」の自動の履歴から、前の日の状態に戻せます。機種変更やブラウザのデータ削除に備えて、ときどき「ファイル」アプリ（iCloud Driveなど）にバックアップを保存してください。お知らせの間隔は変えられます。</p>' +
      '<h3>ご注意</h3><p>計算結果は目安です。実際の引落日・金額は、金融機関やカード会社の案内で確認してください。</p>' +
      '<p style="margin-top:14px"><a href="https://k5wvk4n6pt-web.github.io/nyukin/privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a>　<a href="https://k5wvk4n6pt-web.github.io/nyukin/support.html" target="_blank" rel="noopener">サポート</a></p></div>';
  }
  function showHelp() { confirmSheet('使い方', helpHTML(), null, null); }

  function backupNoticeHTML() {
    const every = backupEvery();
    if (!every || (N.isNative && cloud.available)) return '';
    if (meta.snoozeUntil && Date.now() < new Date(meta.snoozeUntil)) return '';
    const last = meta.lastBackupAt ? new Date(meta.lastBackupAt) : null;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    if (last && days < every) return '';
    const msg = last ? '最後のバックアップから' + days + '日たちました。' : 'まだバックアップがありません。';
    return '<div class="notice"><div><b>' + msg + '</b><br>機種変更やデータの削除に備えて、「ファイル」アプリにバックアップを保存しておくと安心です。</div>' +
      '<div class="btnrow"><button class="primary" data-act="backup">今すぐバックアップ</button><button data-act="snooze">あとで</button></div></div>';
  }


  function shortboxHTML(r) {
    if (!r.banks.some(b => b.balance != null)) {
      return '<div id="shortbox"><div class="shortbox none"><span>残高を入力すると、不足と余りの合計が出ます<small>' + md(r.closing) + '締め</small></span></div></div>';
    }
    const box = (cls, title, count, amount, sub) => '<div class="tot ' + cls + '"><span class="tl">' + title + '</span>' +
      '<span class="big num">' + nf.format(amount) + '<span class="yen">円</span></span><small>' + sub + '</small></div>';
    const cl = md(r.closing);
    const short = box(r.shortfallTotal > 0 ? 'short' : 'zero', cl + 'までに不足', r.shortCount, r.shortfallTotal,
      r.shortCount ? r.shortCount + '口座・入金が必要' : '不足の口座はありません');
    const plus = box(r.surplusTotal > 0 ? 'plus' : 'zero', cl + 'までの引落後の余り', r.surplusCount, r.surplusTotal,
      r.surplusCount ? r.surplusCount + '口座' : '余りの口座はありません');
    const showAll = serial2(r.endAll) > serial2(r.closing);
    const allLine = showAll ? '<div class="allline"><span>' + md(r.endAll) + 'まで見ると</span><span class="num">不足 <b>' + nf.format(r.shortTotalAll) + '円</b></span><span class="num">余り <b>' + nf.format(r.surplusTotalAll) + '円</b></span></div>' : '';
    const miss = r.balanceMissing > 0 ? '<div class="flag">残高未入力：' + r.balanceMissing + '口座（どちらの合計にも含みません）</div>' : '';
    const bulk = r.shortfallTotal > 0 ? '<button class="primary bulkbtn" data-act="bulk">不足をまとめて解消する</button>' : '';
    return '<div id="shortbox"><div class="tots">' + short + plus + '</div>' + bulk + allLine +
      '<p class="note" style="margin:6px 0 0">' + md(r.closing) + '締めまでの引落を差し引いた、口座ごとの過不足の合計です。余りには、締めまで引落のない口座の残高も入ります（設定で「余りに含めない」にした口座を除く）。口座間でお金を移すときの目安にしてください。</p>' + miss + '</div>';
  }

  function summaryHTML(r) {
    const per = r.windows.map((w, i) => '<div class="period' + (w.inClose ? '' : ' after') + '"><span class="lab">' + w.label + 'に必要' + (w.inClose ? '' : '<span class="tag">参考</span>') + (i === 0 ? '<button class="linkish" data-act="go-close" aria-label="期限を変更">変更</button>' : '') + '</span><span class="rng">' + md(w.from) + '〜' + md(w.to) + (w.nominal ? '<br>' + md(w.nominal) + 'が休日のため' + md(w.to) + 'まで' : '') + '</span><span class="val num" data-sum="' + w.key + '">' + yen(r.totals[w.key]) + '</span></div>').join('');
    const inc = r.income.map(i => '<div class="income-row"><span class="who">' + esc(i.name) + '</span><span class="when">' + (i.next ? '<span class="' + (isWeekend(i.next) ? 'wkend' : '') + '">' + mdw(i.next) + '</span> 予定' + shiftNote(i.next) : '') + '</span>' +
      '<input class="amount' + (i.amount == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="inc-' + esc(i.id) + '" data-inc="' + esc(i.id) + '" value="' + yenTxt(i.amount) + '" placeholder="金額（任意）" aria-label="' + esc(i.name) + 'の収入予定額"></div>').join('');
    return '<section class="summary" id="sec-top" aria-label="要約">' +
      '<div class="periods">' + per + '</div>' + shortboxHTML(r) +
      '<div class="income"><div class="sub">収入予定（未入金の収入は残高に足しません）</div>' + inc + '</div></section>' + cycleHTML();
  }

  let cycleOffset = 0; // 0=今のサイクル（画面を開き直すと今に戻る）
  function cycleHTML() {
    const cy = C.cycle(state, today(), cycleOffset);
    const label = cycleOffset === 0 ? '今回' : cycleOffset === -1 ? '前回' : cycleOffset === 1 ? '次回' : (cycleOffset > 0 ? cycleOffset + '回あと' : -cycleOffset + '回前');
    const kinds = Object.keys(cy.byKind).filter(k => cy.byKind[k] || k !== '1回のみ').map(k => '<span>' + k + ' <b class="num">' + nf.format(cy.byKind[k]) + '円</b></span>').join('');
    const neg = cy.diff < 0;
    return '<section class="cycle" id="cycleSec" aria-label="締め日から締め日の収支">' +
      '<div class="cyc-head"><button class="small" data-cyc="-1" aria-label="前のサイクル">‹</button>' +
      '<div class="cyc-title"><b>' + label + 'の締め期間の収支</b><span class="sub">' + md(cy.from) + '〜' + md(cy.to) + '（締め日の翌日〜締め日）</span>' +
      (cy.startShift || cy.endShift ? '<span class="shiftinfo">' + [cy.startShift ? '前の締め日 ' + md(cy.startShift.nominal) + '→' + md(cy.startShift.actual) : '', cy.endShift ? '締め日 ' + md(cy.endShift.nominal) + '→' + md(cy.endShift.actual) : ''].filter(Boolean).join('・') + '（休日のため）</span>' : '') + '</div>' +
      '<button class="small" data-cyc="1" aria-label="次のサイクル">›</button></div>' +
      '<div class="cyc-grid">' +
      '<div><span class="k">収入の合計</span><span class="v num">' + nf.format(cy.income) + '<span class="yen">円</span></span>' + (cy.incomeMissing ? '<span class="flag">金額未入力 ' + cy.incomeMissing + '件</span>' : '<span class="sub">' + cy.incomeItems.length + '件</span>') + '</div>' +
      '<div><span class="k">支出の合計</span><span class="v num">' + nf.format(cy.expense) + '<span class="yen">円</span></span>' + (cy.unentered ? '<span class="flag">金額未入力 ' + cy.unentered + '件</span>' : '<span class="sub">引落の合計</span>') + '</div>' +
      '<div class="diff ' + (neg ? 'neg' : 'pos') + '"><span class="k">差し引き</span><span class="v num">' + (neg ? '−' : '＋') + nf.format(Math.abs(cy.diff)) + '<span class="yen">円</span></span><span class="sub">' + (neg ? '支出が多い' : '収入が多い') + '</span></div>' +
      '</div><div class="cyc-kinds">' + kinds + '</div>' +
      '<p class="note" style="margin:0">すでに引き落とされた分も含めた、期間全体の合計です。収入は「収入予定」に入れた金額、支出は休日のずらしを反映した日付で数えています（非表示の項目・口座は除く）。</p></section>';
  }

  function nextHTML(b) { return b.next ? '次の引落 <span class="' + (isWeekend(b.next) ? 'wkend' : '') + '">' + mdw(b.next) + '</span>' : '予定なし'; }

  /** 不足している口座は「入れる」、それ以外は「出す」ボタン */
  function xferBtn(b) {
    return b.shortfall > 0 ? '<button class="small primary" data-act="xfer-to" data-acc="' + esc(b.name) + '">ほかの口座から移す</button>'
      : '<button class="small" data-act="xfer-from" data-acc="' + esc(b.name) + '">ほかの口座へ移す</button>';
  }
  function serial2(d) { return Date.UTC(d.y, d.m - 1, d.d); }
  function statusHTML(b, r) {
    const ex = b.excluded ? '（合計外）' : '';
    const cl = r ? md(r.closing) + 'まで' : '';
    if (b.balance == null) return '<span class="pill none" data-status>' + (b.dueActive ? '残高未入力' : '残高未入力（締めまで引落なし）') + '</span>';
    if (b.shortfall > 0) return '<span class="pill short num" data-status>' + cl + 'に不足 ' + nf.format(b.shortfall) + '円</span>';
    return '<span class="pill ' + (b.excluded ? 'none' : 'ok') + ' num" data-status>' + cl + 'の余り ' + nf.format(b.surplus) + '円' + ex + '</span>';
  }
  /** 参考の期間まで見たときの過不足（締め日だけで見た場合と違うときだけ表示） */
  function afterHTML(b, r) {
    if (!r || b.balance == null || b.total === b.due || serial2(r.endAll) <= serial2(r.closing)) return '<div class="afternote" data-after hidden></div>';
    const t = md(r.endAll) + 'まで見ると';
    return '<div class="afternote ' + (b.shortAll > 0 ? 'neg' : '') + '" data-after>' + t + '：' + (b.shortAll > 0 ? '不足 ' + nf.format(b.shortAll) + '円' : '余り ' + nf.format(b.surplusAll) + '円') + '</div>';
  }

  function linesInner(b, W) {
    return W.map(w => {
      const ls = b.lines[w.key];
      if (!ls.length) return '<div class="wh">' + w.label + '：なし</div>';
      return '<div class="wh">' + w.label + '（' + md(w.from) + '〜' + md(w.to) + '）</div>' + ls.map(l =>
        '<div class="li"><span class="' + (isWeekend(l.date) ? 'wkend' : '') + '">' + mdw(l.date) + '</span><span>' + esc(l.name) + ' <span class="kchip k-' + ({ '変動費': 'v', '固定費': 'f', '1回のみ': 'o' }[l.kind] || 'v') + '">' + l.kind + '</span>' + (l.orig ? '<br>' + shiftNote(l) : '') + '</span><span class="num">' + (l.amount == null ? '<span class="flag">未入力</span>' : nf.format(l.amount) + '円') + '</span></div>').join('');
    }).join('');
  }

  function banksHTML(r) {
    const active = r.banks.filter(b => b.active), idle = r.banks.filter(b => !b.active);
    const cards = active.map(b => '<article class="bank' + (b.shortfall > 0 ? ' is-short' : '') + '" data-bank="' + esc(b.name) + '">' +
      '<div class="bank-head"><span class="bank-name">' + esc(b.name) + '</span><span class="next">' + nextHTML(b) + '</span></div>' +
      '<div class="bank-amts">' + r.windows.map(w => '<div class="' + (w.inClose ? '' : 'after') + '"><span class="k">' + w.label + (w.inClose ? '' : '（参考）') + '</span><span class="v num" data-bsum="' + w.key + '">' + yen(b.sums[w.key]) + '</span></div>').join('') + '</div>' +
      (b.unentered ? '<div class="flag">金額未入力の引落が' + b.unentered + '件あります（0円として数えていません）</div>' : '') +
      '<div class="bank-foot"><label for="bal-' + esc(b.name) + '">現在残高</label><input class="amount' + (b.balance == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="bal-' + esc(b.name) + '" data-bal="' + esc(b.name) + '" value="' + yenTxt(b.balance) + '" placeholder="未入力">' + statusHTML(b, r) + '</div>' + afterHTML(b, r) +
      '<div class="cardacts"><details class="lines"><summary>引落の内訳</summary><div class="line-list">' + linesInner(b, r.windows) + '</div></details>' +
      xferBtn(b) + '</div>' +
      '</article>').join('');
    const idleTxt = idle.length ? '<div class="idle-head">この期間に引落のない口座<span class="sub">残高を入れると余りに入ります</span></div>' + idle.map(b => '<article class="bank idlebank" data-bank="' + esc(b.name) + '">' +
      '<div class="bank-head"><span class="bank-name">' + esc(b.name) + '</span><span class="next">' + nextHTML(b) + '</span></div>' +
      '<div class="bank-foot"><label for="bal-' + esc(b.name) + '">現在残高</label><input class="amount' + (b.balance == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="bal-' + esc(b.name) + '" data-bal="' + esc(b.name) + '" value="' + yenTxt(b.balance) + '" placeholder="未入力">' + statusHTML(b, r) + '</div>' + afterHTML(b, r) + '<div class="cardacts end"><button class="small" data-act="xfer-from" data-acc="' + esc(b.name) + '">ほかの口座へ移す</button></div></article>').join('') : '';
    return '<section id="banksSec" aria-label="銀行別の入金準備表"><div class="section-head"><h2>銀行別の入金準備</h2><span class="head-right"><span class="sub">' + r.activeCount + '口座</span><button class="small" data-act="xfer-to" data-acc="">口座間で移す</button></span></div>' +
      '<div class="banks">' + (cards || '<div class="idle">この期間の引落はありません</div>') + idleTxt + '</div>' + transfersHTML() +
      '<p class="note">集計は確認日以降の引落だけです。土日・祝日・年末年始（12/31〜1/3）に当たる日は、項目ごとの設定（初期値は支出が後ろ、収入が前）でずらしています。締め日が休日の場合は、設定に合わせて締め日もずらします。</p></section>';
  }

  function daySelect(id, d) {
    let h = '<select id="' + id + '" aria-label="引落日">';
    for (let i = 1; i <= 31; i++) h += '<option value="' + i + '"' + (d === i ? ' selected' : '') + '>' + i + '日</option>';
    return h + '<option value="end"' + (d === 'end' ? ' selected' : '') + '>月末</option></select>';
  }
  function acctSelect(id, a) {
    const opts = state.accounts.slice(); if (a && !opts.includes(a)) opts.push(a);
    return '<select id="' + id + '" aria-label="引落口座">' + (a ? '' : '<option value="" selected>口座を選ぶ</option>') + opts.map(o => '<option' + (o === a ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  }

  function isoOf(dt) { return dt.y + '-' + String(dt.m).padStart(2, '0') + '-' + String(dt.d).padStart(2, '0'); }
  function dateLabel(iso) { const [y, m, d] = iso.split('-').map(Number); const t = { y, m, d }; return (y !== today().y ? y + '/' : '') + mdw(t); }
  function itemWhen(it) { return it.date ? dateLabel(it.date) : dayLabel(it.day); }
  function listHTML(kind, title, lead) {
    const T = today();
    if (kind === 'once') state.once = (state.once || []).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const isPast = it => kind === 'once' && it.date < isoOf(T);
    const visible = state[kind].filter(x => !x.hidden && !isPast(x)), hiddenItems = state[kind].filter(x => x.hidden && !isPast(x));
    const pastItems = state[kind].filter(isPast);
    if (meta.reorder === kind) {
      return '<section id="sec-' + kind + '" aria-label="' + title + '">' + headHTML(title, '表示 ' + visible.length + '件', kind) +
        '<p class="sub" style="margin:-4px 0 10px">↑↓で順番を変えます。終わったら「完了」を押してください。</p>' +
        '<div class="list">' + orderRows(kind, visible.map(it => ({ key: it.id, label: it.name, sub: itemWhen(it) + '・' + (it.account || '口座なし') + '・' + (it.amount == null ? '未入力' : nf.format(it.amount) + '円') }))) + '</div></section>';
    }
    const rows = visible.map(it => {
      const ended = kind === 'fixed' && it.end && !C.activeIn(it, T.y, T.m);
      return '<div class="row' + (ended ? ' ended' : '') + '" data-kind="' + kind + '" data-id="' + esc(it.id) + '">' +
        '<div class="row-main"><span class="row-name">' + esc(it.name) + '</span>' +
        '<input class="amount' + (it.amount == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="amt-' + esc(it.id) + '" data-f="amount" value="' + yenTxt(it.amount) + '" placeholder="未入力" aria-label="' + esc(it.name) + 'の金額"></div>' +
        '<div class="row-sub">' + (kind === 'once' ? '<input class="text datein" type="date" id="date-' + esc(it.id) + '" data-f="date" value="' + esc(it.date) + '" aria-label="引落日">' : daySelect('day-' + esc(it.id), it.day)) + acctSelect('acc-' + esc(it.id), it.account) +
        '<span class="stamp" data-stamp>' + stampText(it.updatedAt) + '</span></div>' +
        ((it.memo || it.end) ? '<div class="memo">' + (it.end ? (ended ? '終了しました（' : '終了予定 ') + it.end.replace('-', '/') + (ended ? '）' : '') + (it.memo ? '　' : '') : '') + esc(it.memo) + '</div>' : '') +
        '<div class="row-acts"><button class="ghost small" data-act="edit">詳細（名前・休日・削除）</button><button class="ghost small" data-act="hide">非表示にする</button></div>' +
        '<div class="edit" hidden data-editor>' +
        '<label>項目名<input class="text" id="nm-' + esc(it.id) + '" data-f="name" value="' + esc(it.name) + '"></label>' +
        (kind === 'fixed' ? '<label>終了月（空欄なら毎月）<input class="text" type="month" id="end-' + esc(it.id) + '" data-f="end" value="' + esc(it.end || '') + '"></label>' : '') +
        '<label>引落日が休日のとき' + shiftSelect('shift-' + esc(it.id), it.shift || 'after') + '</label>' +
        '<label>メモ<input class="text" id="memo-' + esc(it.id) + '" data-f="memo" value="' + esc(it.memo) + '"></label>' +
        '<div class="btns"><button class="danger small" data-act="del">この項目を削除</button><button class="small" data-act="close">閉じる</button></div></div>' +
        '</div>';
    }).join('');
    const hid = hiddenItems.length ? '<details class="hiddenbox"' + (meta['open-' + kind] ? ' open' : '') + ' data-kind="' + kind + '"><summary>非表示の項目 ' + hiddenItems.length + '件（計算に含みません）</summary>' +
      hiddenItems.map(it => '<div class="hrow" data-kind="' + kind + '" data-id="' + esc(it.id) + '"><span class="row-name">' + esc(it.name) + '<span class="sub">' + itemWhen(it) + '・' + esc(it.account || '口座なし') + '・' + (it.amount == null ? '未入力' : nf.format(it.amount) + '円') + '</span></span><button class="small" data-act="unhide">表示する</button></div>').join('') +
      '</details>' : '';
    const past = pastItems.length ? '<details class="hiddenbox"' + (meta['open-past'] ? ' open' : '') + ' data-kind="past"><summary>済み ' + pastItems.length + '件（日付が過ぎたもの）</summary>' +
      pastItems.slice().reverse().map(it => '<div class="hrow" data-kind="once" data-id="' + esc(it.id) + '"><span class="row-name">' + esc(it.name) + '<span class="sub">' + dateLabel(it.date) + '・' + esc(it.account || '口座なし') + '・' + (it.amount == null ? '未入力' : nf.format(it.amount) + '円') + '</span></span><button class="small danger" data-act="pastdel">削除</button></div>').join('') + '</details>' : '';
    if (kind === 'once') {
      const rowsOnce = visible.length ? rows : '<div class="emptyrow sub">予定はありません</div>';
      return '<section id="sec-once" aria-label="' + title + '" style="margin-top:28px">' + headHTML(title, visible.length + '件', null, 'once') +
        '<p class="sub" style="margin:-4px 0 10px">' + lead + '</p>' +
        '<div class="list">' + rowsOnce + '<div class="add"><button class="ghost" data-act="add" data-kind="once">＋ 1回のみの引落を追加</button></div></div>' + hid + past + '</section>';
    }
    return '<section id="sec-' + kind + '" aria-label="' + title + '">' + headHTML(title, '表示 ' + visible.length + '件', kind, kind) +
      '<p class="sub" style="margin:-4px 0 10px">' + lead + '</p>' +
      '<div class="list">' + rows + '<div class="add"><button class="ghost" data-act="add" data-kind="' + kind + '">＋ ' + title + 'を追加</button></div></div>' + hid + '</section>';
  }

  function hiddenAcc() { return state.hiddenAccounts || (state.hiddenAccounts = []); }
  function exclSurplus() { return state.excludeSurplus || (state.excludeSurplus = []); }
  function hideBtn(isHidden, act) { return '<button class="small' + (isHidden ? ' primary' : '') + '" data-act="' + act + '">' + (isHidden ? '表示する' : '非表示') + '</button>'; }

  /* 見出し＋並び替えボタン */
  function headHTML(title, note, group, addKind) {
    const on = meta.reorder === group;
    return '<div class="section-head"><h2>' + title + '</h2><span class="head-right"><span class="sub">' + note + '</span>' +
      (addKind && !on ? '<button class="small primary" data-act="add" data-kind="' + addKind + '">＋ 追加</button>' : '') +
      (group ? '<button class="small' + (on ? ' primary' : '') + '" data-reorder="' + group + '">' + (on ? '完了' : '並び替え') + '</button>' : '') + '</span></div>';
  }
  function orderRows(group, list) {
    return list.map((x, i) => '<div class="orow" data-group="' + group + '" data-key="' + esc(x.key) + '">' +
      '<span class="oname">' + esc(x.label) + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</span>' +
      '<button class="small mv" data-mv="-1" aria-label="' + esc(x.label) + 'を上へ"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="small mv" data-mv="1" aria-label="' + esc(x.label) + 'を下へ"' + (i === list.length - 1 ? ' disabled' : '') + '>↓</button></div>').join('');
  }
  /** 隣の（表示されている）項目と入れ替える */
  function moveItem(group, key, dir) {
    let arr, keyOf, vis;
    if (group === 'accounts') { arr = state.accounts; keyOf = x => x; vis = arr.slice(); }
    else if (group === 'income') { arr = state.income; keyOf = x => x.id; vis = arr.slice(); }
    else { arr = state[group]; keyOf = x => x.id; vis = arr.filter(x => !x.hidden); }
    const i = vis.findIndex(x => keyOf(x) === key), j = i + dir;
    if (i < 0 || j < 0 || j >= vis.length) return;
    const ai = arr.indexOf(vis[i]), bi = arr.indexOf(vis[j]);
    [arr[ai], arr[bi]] = [arr[bi], arr[ai]];
    save();
    renderKeep();
    const row = main.querySelector('.orow[data-group="' + group + '"][data-key="' + CSS.escape(key) + '"]');
    if (row) { row.scrollIntoView({ block: 'nearest' }); const btn = row.querySelector('[data-mv="' + dir + '"]'); if (btn && !btn.disabled) btn.focus({ preventScroll: true }); }
  }

  const STABS = [['out', '支出'], ['in', '収入'], ['acc', '口座'], ['books', '帳簿'], ['backup', '保存']];
  function settingsHTML() {
    const st = STABS.some(t => t[0] === meta.stab) ? meta.stab : 'out';
    const seg = '<div class="seg" role="tablist">' + STABS.map(t => '<button role="tab" aria-selected="' + (t[0] === st) + '" class="' + (t[0] === st ? 'on' : '') + '" data-stab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
    let body = '';
    if (st === 'out') body = outHTML();
    else if (st === 'in') body = inHTML();
    else if (st === 'acc') body = accHTML();
    else if (st === 'books') body = booksHTML();
    else body = backupHTML();
    const cs = C.closeSettings(state);
    const dayOpts = sel => { let o = ''; for (let i = 1; i <= 28; i++) o += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>毎月' + i + '日</option>'; return o + '<option value="end"' + (sel === 'end' ? ' selected' : '') + '>毎月 月末</option>'; };
    const sh = (id, v) => shiftSelect(id, v, '休日のとき').replace(SHIFT_LABEL.after, '後ろ（翌営業日）').replace(SHIFT_LABEL.before, '前（前営業日）');
    const closeCard = '<div class="card form closecard" id="closecard"><div class="shead">いつまでに必要か（期限）<span class="sub">帳簿「' + esc(curBook() ? curBook().name : '') + '」の設定です。準備ページの2つの期間になり、期限1は締め日として不足と余りの判定に使います</span></div>' +
      '<div class="dl"><b>期限1（締め日）</b><div class="two"><label>日付<select id="close-day">' + dayOpts(cs.d1.day) + '</select></label><label>休日のとき' + sh('close-shift', cs.d1.shift) + '</label></div></div>' +
      '<div class="dl"><b>期限2（参考）</b><div class="two"><label>日付<select id="close2-day">' + dayOpts(cs.d2.day) + '</select></label><label>休日のとき' + sh('close2-shift', cs.d2.shift) + '</label></div></div></div>';
    if (st === 'books') body = body + closeCard;
    return '<section id="sec-settings" aria-label="設定"><div class="section-head"><h2>設定</h2></div>' + seg + '<div class="stab-body">' + body + '</div></section>';
  }

  function visibleAccounts() { return state.accounts.filter(a => !hiddenAcc().includes(a)); }

  function outHTML() {
    const kind = ['fixed', 'once'].includes(meta.qkind) ? meta.qkind : 'variable';
    const kname = { variable: '変動費', fixed: '固定費', once: '1回のみ' }[kind];
    const accs = visibleAccounts();
    const acc = accs.includes(meta.qacc) ? meta.qacc : '';
    const day = meta.qday === 'end' || (Number(meta.qday) >= 1 && Number(meta.qday) <= 31) ? (meta.qday === 'end' ? 'end' : Number(meta.qday)) : 27;
    return '<div class="card form">' +
      '<div class="shead">支出を追加<span class="sub">追加した項目は「' + (kind === 'fixed' ? '固定費' : '変動費') + '」ページに表示され、すぐ計算に入ります' + (kind === 'once' ? '（1回のみは変動費ページの下）' : '') + '</span></div>' +
      '<div class="seg small-seg">' + [['variable', '変動費'], ['fixed', '固定費'], ['once', '1回のみ']].map(k => '<button class="' + (k[0] === kind ? 'on' : '') + '" data-qkind="' + k[0] + '">' + k[1] + '</button>').join('') + '</div>' +
      '<label>項目名<input class="text" id="qa-name" autocomplete="off" placeholder="例：クレジットカード"></label>' +
      '<label>金額（わからなければ空欄）<input class="amount wide" id="qa-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" placeholder="未入力"></label>' +
      '<div class="two"><label>引落日' + (kind === 'once' ? '<input class="text" type="date" id="qa-date" value="' + (meta.qdate || isoOf(today())) + '">' : daySelect('qa-day', day)) + '</label>' +
      '<label>引落口座<select id="qa-acc" aria-label="引落口座">' + (acc ? '' : '<option value="" selected>選ぶ</option>') + accs.map(a => '<option' + (a === acc ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label></div>' +
      '<label>引落日が休日のとき' + shiftSelect('qa-shift', validShift(meta.qshift, 'after')) + '</label>' +
      (kind === 'fixed' ? '<label>終了月（ローンなど。なければ空欄）<input class="text" type="month" id="qa-end"></label>' : '') +
      '<button class="primary" data-act="qadd">' + (kind === 'once' ? '1回のみの引落として追加' : kname + 'に追加') + '</button>' +
      (meta.qlast ? '<p class="note" id="qa-last">追加しました：' + esc(meta.qlast) + '</p>' : '') +
      '</div>';
  }

  function inHTML() {
    const on = meta.reorder === 'income';
    const list = on ? orderRows('income', state.income.map(i => ({ key: i.id, label: i.name, sub: dayLabel(i.day) + (i.hidden ? '・非表示' : '') }))) :
      state.income.map(i => '<div class="irow' + (i.hidden ? ' is-hidden' : '') + '" data-inc-id="' + esc(i.id) + '">' +
        '<div class="irow-top"><input class="text" id="incname-' + esc(i.id) + '" value="' + esc(i.name) + '" aria-label="収入の名前">' +
        '<input class="amount" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="incamt-' + esc(i.id) + '" data-inc="' + esc(i.id) + '" value="' + yenTxt(i.amount) + '" placeholder="金額" aria-label="' + esc(i.name) + 'の金額"></div>' +
        '<div class="irow-bot">' + daySelect('incday-' + esc(i.id), i.day) + shiftSelect('incshift-' + esc(i.id), i.shift || 'before', '入金日が休日のとき') + '</div>' +
        '<div class="irow-bot"><span class="grow"></span>' + hideBtn(!!i.hidden, 'inchide') + '<button class="danger small" data-act="incdel">削除</button></div></div>').join('');
    return '<div class="card">' + '<div class="pad">' + headHTML('収入', state.income.length + '件', 'income') + '<p class="sub" style="margin:0">未入金の収入は口座残高に足しません。非表示にすると準備ページに出ません。</p></div>' +
      list + (on ? '' :
      '<div class="form addform"><div class="shead">収入を追加</div>' +
      '<label>名前<input class="text" id="inc-new-name" autocomplete="off" placeholder="例：児童手当"></label>' +
      '<label>入金日が休日のとき' + shiftSelect('inc-new-shift', 'before') + '</label>' +
      '<div class="two"><label>入金日' + daySelect('inc-new-day', 25) + '</label><label>金額（任意）<input class="amount wide" id="inc-new-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" placeholder="未入力"></label></div>' +
      '<button class="primary" data-act="incadd">収入に追加</button></div>') + '</div>';
  }

  function accHTML() {
    const on = meta.reorder === 'accounts';
    const used = name => allItems().filter(x => x.account === name).length;
    const list = on ? orderRows('accounts', state.accounts.map(a => ({ key: a, label: a, sub: used(a) + '件' + (hiddenAcc().includes(a) ? '・非表示' : '') }))) :
      state.accounts.map((a, i) => '<div class="srow' + (hiddenAcc().includes(a) ? ' is-hidden' : '') + '" data-acc-i="' + i + '">' +
        '<input class="text" id="accname-' + i + '" value="' + esc(a) + '" aria-label="口座名">' +
        '<span class="sub nowrap">' + used(a) + '件</span></div>' +
        '<div class="srow sub-row' + (hiddenAcc().includes(a) ? ' is-hidden' : '') + '" data-acc-j="' + i + '">' +
        '<label class="check"><input type="checkbox" data-act="accsurplus"' + (exclSurplus().includes(a) ? '' : ' checked') + '>余りの合計に含める</label>' +
        hideBtn(hiddenAcc().includes(a), 'acchide') +
        '<button class="danger small" data-act="accdel">削除</button></div>').join('');
    return '<div class="card">' + '<div class="pad">' + headHTML('口座', state.accounts.length + '口座', 'accounts') +
      '<p class="sub" style="margin:0">準備ページは引落の近い口座から並びます。同じ日の口座は、ここでの並び順になります。名前を変えると、その口座の引落もまとめて変わります。</p></div>' +
      list + (on ? '' : '<div class="srow add-row"><input class="text" id="accnew" placeholder="新しい口座名" aria-label="新しい口座名"><button class="small" data-act="accadd">追加</button></div>') + '</div>';
  }

  function booksHTML() {
    const rows = books.list.map(b => '<div class="srow" data-book-id="' + esc(b.id) + '">' +
      '<input class="text" id="bookname-' + esc(b.id) + '" value="' + esc(b.name) + '" aria-label="帳簿の名前">' +
      (b.id === books.current ? '<span class="pill ok">表示中</span>' : '<button class="small" data-act="book-open">開く</button>') +
      (books.list.length > 1 ? '<button class="danger small" data-act="book-del">削除</button>' : '') + '</div>').join('');
    return '<div class="card"><div class="pad"><div class="section-head"><h2>帳簿</h2><span class="sub">' + books.list.length + '冊</span></div>' +
      '<p class="sub" style="margin:0">人ごとに別の帳簿で管理できます。口座・支出・収入・残高・期限は帳簿ごとに別々です。画面上の名前をタップすると切り替わります。</p></div>' +
      rows +
      '<div class="srow add-row"><input class="text" id="booknew" placeholder="新しい帳簿の名前（例：母）" aria-label="新しい帳簿の名前"><button class="small" data-act="book-add-do">追加</button></div></div>';
  }
  function addBook(name) {
    ensureBooks();
    if (books.list.some(b => b.name === name)) { toast('同じ名前の帳簿があります'); return false; }
    save(); // 今の帳簿を確実に保存
    const id = uid('b');
    books.list.push({ id, name });
    try { localStorage.setItem(dataKey(id), JSON.stringify(emptyState())); } catch (e) { /* 開いた時に空で作る */ }
    saveBooks(); switchBook(id); return true;
  }

  function bindSettings() {
    main.querySelectorAll('[data-book-id]').forEach(row => {
      const id = row.dataset.bookId; const bk = books.list.find(b => b.id === id);
      row.querySelector('input').addEventListener('change', e => {
        const n = e.target.value.trim();
        if (!n) { e.target.value = bk.name; toast('帳簿の名前を入力してください'); return; }
        if (books.list.some(b => b.id !== id && b.name === n)) { e.target.value = bk.name; toast('同じ名前の帳簿があります'); return; }
        bk.name = n; saveBooks(); renderKeep(); toast('「' + n + '」に変更しました');
      });
      const op = row.querySelector('[data-act="book-open"]'); if (op) op.addEventListener('click', () => switchBook(id));
      const del = row.querySelector('[data-act="book-del"]');
      if (del) del.addEventListener('click', () => confirmSheet('帳簿「' + bk.name + '」を削除しますか？', '<p class="flag" style="margin:0">この帳簿の口座・支出・収入・残高がすべて消え、元に戻せません。必要なら先にバックアップを保存してください。</p>', '削除する', () => {
        try { localStorage.removeItem(dataKey(id)); } catch (e) { /* 一覧からは外す */ }
        books.list = books.list.filter(b => b.id !== id);
        if (books.current === id) { books.current = books.list[0].id; state = readBook(books.current) || emptyState(); }
        saveBooks(); renderKeep(); toast('削除しました');
      }, true));
    });
    const ba = main.querySelector('[data-act="book-add-do"]');
    if (ba) ba.addEventListener('click', () => { const n = $('#booknew').value.trim(); if (!n) { toast('帳簿の名前を入力してください'); return; } addBook(n); });
    const cd = $('#close-day');
    if (cd) {
      const dv = v => v === 'end' ? 'end' : Number(v);
      const lab = d => d === 'end' ? '月末' : d + '日';
      const upd = () => {
        state.settings = { closeDay: dv(cd.value), closeShift: validShift($('#close-shift').value, 'after'), close2Day: dv($('#close2-day').value), close2Shift: validShift($('#close2-shift').value, 'none') };
        save(); renderKeep(); toast('期限1：' + lab(state.settings.closeDay) + '／期限2：' + lab(state.settings.close2Day));
      };
      ['#close-day', '#close-shift', '#close2-day', '#close2-shift'].forEach(id => $(id).addEventListener('change', upd));
    }
    main.querySelectorAll('[data-stab]').forEach(b => b.addEventListener('click', () => { meta.stab = b.dataset.stab; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); }));
    // 支出の追加
    main.querySelectorAll('[data-qkind]').forEach(b => b.addEventListener('click', () => { meta.qkind = b.dataset.qkind; saveMeta(); keepForm(() => renderKeep()); }));
    const qadd = main.querySelector('[data-act="qadd"]');
    if (qadd) {
      const amt = $('#qa-amt');
      amt.addEventListener('blur', () => { const v = parseAmount(amt.value); if (!Number.isNaN(v)) amt.value = yenTxt(v); });
      if ($('#qa-day')) $('#qa-day').addEventListener('change', e => { meta.qday = e.target.value === 'end' ? 'end' : Number(e.target.value); saveMeta(); });
      $('#qa-acc').addEventListener('change', e => { meta.qacc = e.target.value; saveMeta(); });
      qadd.addEventListener('click', () => {
        const kind = ['fixed', 'once'].includes(meta.qkind) ? meta.qkind : 'variable';
        const name = $('#qa-name').value.trim();
        const v = parseAmount(amt.value);
        const acc = $('#qa-acc').value;
        const qd = $('#qa-date');
        if (qd && !/^\d{4}-\d{2}-\d{2}$/.test(qd.value)) { toast('引落日を選んでください'); return; }
        const dv = qd ? null : $('#qa-day').value; const day = qd ? null : (dv === 'end' ? 'end' : Number(dv));
        if (!name) { toast('項目名を入力してください'); $('#qa-name').focus(); return; }
        if (Number.isNaN(v)) { toast('金額は数字で入力してください'); amt.focus(); return; }
        if (!acc) { toast('引落口座を選んでください'); return; }
        const shift = validShift($('#qa-shift').value, 'after'); meta.qshift = shift;
        const it = { id: uid(kind === 'fixed' ? 'f' : 'v'), name, day, account: acc, amount: v, memo: '', updatedAt: new Date().toISOString(), hidden: false, shift };
        if (kind === 'fixed') { const e = $('#qa-end'); it.end = e && e.value ? e.value : null; }
        if (kind === 'once') { delete it.day; it.date = qd.value; meta.qdate = qd.value; }
        state.once = state.once || [];
        state[kind].push(it); save();
        meta.qacc = acc; if (day != null) meta.qday = day;
        meta.qlast = name + '（' + { variable: '変動費', fixed: '固定費', once: '1回のみ' }[kind] + '・' + itemWhen(it) + '・' + acc + '・' + (v == null ? '金額未入力' : nf.format(v) + '円') + '）';
        saveMeta(); renderKeep(); toast('「' + name + '」を追加しました');
      });
    }
    // 収入
    main.querySelectorAll('[data-inc-id]').forEach(row => {
      const inc = state.income.find(x => x.id === row.dataset.incId);
      row.querySelector('input.text').addEventListener('change', e => { const n = e.target.value.trim(); if (!n) { e.target.value = inc.name; return; } inc.name = n; save(); renderKeep(); });
      row.querySelector('select[id^="incday-"]').addEventListener('change', e => { inc.day = e.target.value === 'end' ? 'end' : Number(e.target.value); save(); renderKeep(); });
      row.querySelector('select[id^="incshift-"]').addEventListener('change', e => { inc.shift = validShift(e.target.value, 'before'); save(); renderKeep(); toast('「' + inc.name + '」：' + SHIFT_LABEL[inc.shift]); });
      row.querySelector('[data-act="inchide"]').addEventListener('click', () => { inc.hidden = !inc.hidden; save(); renderKeep(); toast(inc.hidden ? '「' + inc.name + '」を非表示にしました' : '「' + inc.name + '」を表示しました'); });
      row.querySelector('[data-act="incdel"]').addEventListener('click', () => confirmSheet('収入「' + inc.name + '」を削除しますか？', '', '削除する', () => {
        state.income = state.income.filter(x => x.id !== inc.id); save(); renderKeep(); toast('削除しました');
      }, true));
    });
    const incadd = main.querySelector('[data-act="incadd"]');
    if (incadd) {
      const amt = $('#inc-new-amt');
      amt.addEventListener('blur', () => { const v = parseAmount(amt.value); if (!Number.isNaN(v)) amt.value = yenTxt(v); });
      incadd.addEventListener('click', () => {
        const n = $('#inc-new-name').value.trim(); const v = parseAmount(amt.value);
        const dv = $('#inc-new-day').value;
        if (!n) { toast('収入の名前を入力してください'); return; }
        if (Number.isNaN(v)) { toast('金額は数字で入力してください'); return; }
        state.income.push({ id: uid('i'), name: n, day: dv === 'end' ? 'end' : Number(dv), amount: v, hidden: false, shift: validShift($('#inc-new-shift').value, 'before') });
        save(); renderKeep(); toast('「' + n + '」を追加しました');
      });
    }
    // 口座
    main.querySelectorAll('[data-acc-i]').forEach(row0 => {
      const i = Number(row0.dataset.accI); const old = state.accounts[i];
      const row = { querySelector: q => row0.querySelector(q) || main.querySelector('[data-acc-j="' + i + '"] ' + q) };
      row.querySelector('[data-act="accsurplus"]').addEventListener('change', e => {
        const ex = exclSurplus();
        state.excludeSurplus = e.target.checked ? ex.filter(a => a !== old) : ex.concat(old);
        save(); toast(e.target.checked ? '「' + old + '」を余りの合計に含めます' : '「' + old + '」を余りの合計に含めません');
      });
      row.querySelector('input').addEventListener('change', e => {
        const n = e.target.value.trim();
        if (n === old) return;
        if (!n) { e.target.value = old; toast('口座名を入力してください'); return; }
        if (state.accounts.includes(n)) { e.target.value = old; toast('同じ名前の口座があります'); return; }
        state.accounts[i] = n;
        let cnt = 0;
        for (const it of allItems()) if (it.account === old) { it.account = n; cnt++; }
        state.balances[n] = state.balances[old] || { amount: null, updatedAt: null }; delete state.balances[old];
        state.hiddenAccounts = hiddenAcc().map(a => a === old ? n : a);
        state.excludeSurplus = exclSurplus().map(a => a === old ? n : a);
        (state.transfers || []).forEach(t => { if (t.from === old) t.from = n; if (t.to === old) t.to = n; });
        if (meta.qacc === old) { meta.qacc = n; saveMeta(); }
        save(); renderKeep(); toast('「' + n + '」に変更しました（引落' + cnt + '件）');
      });
      row.querySelector('[data-act="acchide"]').addEventListener('click', () => {
        const h = hiddenAcc(); const on = h.includes(old);
        state.hiddenAccounts = on ? h.filter(a => a !== old) : h.concat(old);
        save(); renderKeep(); toast(on ? '「' + old + '」を表示しました' : '「' + old + '」を非表示にしました（計算に含みません）');
      });
      row.querySelector('[data-act="accdel"]').addEventListener('click', () => {
        const uses = allItems().filter(x => x.account === old);
        if (uses.length) {
          confirmSheet('「' + old + '」は削除できません', '<p class="sub" style="margin:0">この口座を使っている引落が' + uses.length + '件あります（' + uses.slice(0, 5).map(x => esc(x.name)).join('、') + (uses.length > 5 ? ' ほか' : '') + '）。先に変動費・固定費で別の口座に変えてください。</p>', null, null);
          return;
        }
        confirmSheet('「' + old + '」を削除しますか？', '<p class="sub" style="margin:0">入力した残高も消えます。</p>', '削除する', () => {
          state.accounts = state.accounts.filter(a => a !== old); delete state.balances[old]; state.hiddenAccounts = hiddenAcc().filter(a => a !== old); state.excludeSurplus = exclSurplus().filter(a => a !== old); save(); renderKeep(); toast('削除しました');
        }, true);
      });
    });
    const accadd = main.querySelector('[data-act="accadd"]');
    if (accadd) accadd.addEventListener('click', () => {
      const n = $('#accnew').value.trim();
      if (!n) { toast('口座名を入力してください'); return; }
      if (state.accounts.includes(n)) { toast('同じ名前の口座があります'); return; }
      state.accounts.push(n); state.balances[n] = { amount: null, updatedAt: null }; save(); renderKeep(); toast('「' + n + '」を追加しました');
    });
  }

  /** 追加フォームの入力途中の内容を残したまま描き直す */
  function keepForm(fn) {
    const keep = {}; ['qa-name', 'qa-amt', 'qa-date'].forEach(id => { const el = $('#' + id); if (el) keep[id] = el.value; });
    fn();
    Object.keys(keep).forEach(id => { const el = $('#' + id); if (el) el.value = keep[id]; });
  }

  function readHistory() { try { const h = JSON.parse(localStorage.getItem(HISTORY) || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; } }
  function backupHTML() {
    const last = meta.lastBackupAt ? stampText(meta.lastBackupAt).replace('更新：', '') : 'まだありません';
    const every = backupEvery();
    const opts = [[30, '1か月ごと'], [14, '2週間ごと'], [7, '1週間ごと'], [0, '知らせない']].map(o => '<option value="' + o[0] + '"' + (o[0] === every ? ' selected' : '') + '>' + o[1] + '</option>').join('');
    const hist = readHistory();
    const histRows = hist.length ? hist.map((h, i) => '<div class="srow" data-hist="' + i + '"><span class="grow">' + esc(h.label) + '<br><span class="sub">' + h.books.map(b => esc(b.name)).join('・') + '</span></span><button class="small" data-act="hist-restore">この時点に戻す</button></div>').join('')
      : '<p class="sub" style="margin:0">まだありません（入力した日の内容が、1日1回ここに残ります）</p>';
    const cloudBox = !N.isNative ? '' : cloud.available
      ? '<div class="cloudbox ok"><b>iCloudに自動でバックアップしています</b><span class="sub">最後のバックアップ：<span id="cloudAt">' + (meta.cloudAt ? stampText(meta.cloudAt).replace('更新：', '') : 'まだありません（次の入力のあとに保存します）') + '</span></span><span class="sub">機種変更しても、同じApple IDでこのアプリを入れれば戻せます。</span>' +
        (cloud.data ? '<button class="small" data-act="cloud-restore">iCloudのバックアップから復元（' + esc(cloudWhen()) + '）</button>' : '') + '</div>'
      : '<div class="cloudbox"><b>iCloudのバックアップは使えません</b><span class="sub">iPhoneの「設定」でApple IDにサインインし、iCloud Driveをオンにすると、自動でバックアップされます。それまでは下のボタンで「ファイル」に保存してください。</span></div>';
    return '<section class="backup" id="sec-backup" aria-label="バックアップ"><h2>バックアップ</h2>' +
      cloudBox +
      '<p class="sub" style="margin:0">入力した内容は、変更するたびに自動でこの端末に保存されています。' + (N.isNative ? '' : 'アプリの更新（ファイルの入れ替え）でも消えません。') + 'ファイルへのバックアップは、機種変更や、データの削除に備えるためのものです。</p>' +
      '<div class="sub">最後のバックアップ：' + last + '</div>' +
      '<div class="btnrow"><button class="primary" data-act="backup">バックアップを保存</button>' +
      '<label class="fileBtn">バックアップから復元<input type="file" id="restoreFile" accept=".json,application/json"></label></div>' +
      '<p class="note">保存先で「“ファイル”に保存」を選んでください。iCloud Driveに保存すると、iPhoneをなくしても残ります。</p>' +
      ((N.isNative && cloud.available) ? '' : '<label class="inline-field">バックアップのお知らせ<select id="backup-every">' + opts + '</select></label>') +
      '<div class="hist"><b>自動の履歴（この端末の中・' + HISTORY_DAYS + '日分）</b><p class="sub" style="margin:0">入力を間違えたときに、前の日の状態に戻せます。端末の中にあるので、機種変更の備えにはなりません。</p>' + histRows + '</div>' +
      '<div class="danger-zone"><b>すべてのデータを消す</b><p class="sub" style="margin:0">すべての帳簿の口座・支出・収入・残高を消して、最初の画面に戻ります。元に戻せないので、先にバックアップを保存してください。</p><button class="danger" data-act="wipe">すべてのデータを消す</button></div></section>';
  }

  /* ---------- 操作 ---------- */
  function findItem(row) { return state[row.dataset.kind].find(x => x.id === row.dataset.id); }
  function touch(it, row) { it.updatedAt = new Date().toISOString(); const s = row.querySelector('[data-stamp]'); if (s) { s.textContent = stampText(it.updatedAt); s.classList.add('fresh'); } }

  function onAmountInput(el, get, set, after) {
    const v = parseAmount(el.value);
    if (Number.isNaN(v)) { el.setCustomValidity('数字で入力してください'); return; }
    el.setCustomValidity('');
    if (v === get()) return;
    set(v); el.classList.toggle('empty', v == null);
    if (after) after();
    save(); refreshNumbers();
  }

  function bindAll() {
    main.querySelectorAll('.row').forEach(row => {
      const it = findItem(row);
      const amt = row.querySelector('[data-f="amount"]');
      amt.addEventListener('input', () => onAmountInput(amt, () => it.amount, v => { it.amount = v; }, () => touch(it, row)));
      amt.addEventListener('blur', () => { const v = parseAmount(amt.value); if (!Number.isNaN(v)) amt.value = yenTxt(v); });
      const ds = row.querySelector('select[id^="day-"]');
      if (ds) ds.addEventListener('change', e => { it.day = e.target.value === 'end' ? 'end' : Number(e.target.value); touch(it, row); save(); renderKeep(); });
      const di = row.querySelector('[data-f="date"]');
      if (di) di.addEventListener('change', e => { if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { e.target.value = it.date; return; } it.date = e.target.value; touch(it, row); save(); renderKeep(); });
      row.querySelector('select[id^="acc-"]').addEventListener('change', e => { it.account = e.target.value; touch(it, row); save(); renderKeep(); });
      const ed = row.querySelector('[data-editor]');
      row.querySelector('[data-act="edit"]').addEventListener('click', () => { ed.hidden = !ed.hidden; });
      row.querySelector('[data-act="close"]').addEventListener('click', () => { ed.hidden = true; });
      row.querySelector('[data-f="name"]').addEventListener('change', e => { const n = e.target.value.trim(); if (!n || n === it.name) return; it.name = n; touch(it, row); save(); renderKeep(); });
      row.querySelector('[data-f="memo"]').addEventListener('change', e => { it.memo = e.target.value; save(); renderKeep(); });
      row.querySelector('[data-f="shift"]').addEventListener('change', e => { it.shift = validShift(e.target.value, 'after'); touch(it, row); save(); renderKeep(); toast('「' + it.name + '」：' + SHIFT_LABEL[it.shift]); });
      const end = row.querySelector('[data-f="end"]');
      if (end) end.addEventListener('change', e => { it.end = e.target.value || null; touch(it, row); save(); renderKeep(); });
      row.querySelector('[data-act="del"]').addEventListener('click', () => confirmSheet('「' + it.name + '」を削除しますか？', '<p class="sub" style="margin:0">' + itemWhen(it) + '・' + esc(it.account) + '・' + (it.amount == null ? '未入力' : nf.format(it.amount) + '円') + '</p>', '削除する', () => {
        state[row.dataset.kind] = state[row.dataset.kind].filter(x => x.id !== it.id); save(); renderKeep(); toast('削除しました');
      }, true));
    });
    main.querySelectorAll('.row [data-act="hide"]').forEach(btn => btn.addEventListener('click', () => {
      const row = btn.closest('.row'); const it = findItem(row);
      it.hidden = true; save(); renderKeep(); toast('「' + it.name + '」を非表示にしました（計算に含みません）');
    }));
    main.querySelectorAll('.hrow [data-act="unhide"]').forEach(btn => btn.addEventListener('click', () => {
      const row = btn.closest('.hrow'); const it = findItem(row);
      it.hidden = false; save(); renderKeep(); toast('「' + it.name + '」を表示しました');
    }));
    main.querySelectorAll('.hrow [data-act="pastdel"]').forEach(btn => btn.addEventListener('click', () => {
      const it = findItem(btn.closest('.hrow'));
      state.once = state.once.filter(x => x.id !== it.id); save(); renderKeep(); toast('「' + it.name + '」を削除しました');
    }));
    main.querySelectorAll('details.hiddenbox').forEach(d => d.addEventListener('toggle', () => { meta['open-' + d.dataset.kind] = d.open; saveMeta(); }));
    bindBalances();
    main.querySelectorAll('[data-inc]').forEach(el => {
      const inc = state.income.find(i => i.id === el.dataset.inc);
      el.addEventListener('input', () => onAmountInput(el, () => inc.amount, v => { inc.amount = v; }));
      el.addEventListener('blur', () => { const v = parseAmount(el.value); if (!Number.isNaN(v)) el.value = yenTxt(v); });
    });
    main.querySelectorAll('[data-act="add"]').forEach(btn => btn.addEventListener('click', () => openAddSheet(btn.dataset.kind)));
    main.querySelectorAll('[data-act="backup"]').forEach(b => b.addEventListener('click', doBackup));
    bindCloud();
    main.querySelectorAll('[data-act="xfer-to"], [data-act="xfer-from"]').forEach(b => b.addEventListener('click', () => {
      if (accountCatalog().length < 2) { toast('口座が2つ以上必要です'); return; }
      if (b.dataset.act === 'xfer-from') openTransfer('', b.dataset.acc); else openTransfer(b.dataset.acc);
    }));
    bindCycle();
    main.querySelectorAll('[data-act="bulk"]').forEach(b => b.addEventListener('click', openBulk));
    main.querySelectorAll('[data-act="xfer-undo"]').forEach(b => b.addEventListener('click', () => {
      const t = (state.transfers || []).find(x => x.id === b.closest('[data-xid]').dataset.xid); if (!t) return;
      confirmSheet('この移動を取り消しますか？', '<p class="sub" style="margin:0">' + esc(tLabel(t, 'from')) + ' → ' + esc(tLabel(t, 'to')) + '　' + nf.format(t.amount) + '円' + (t.fee ? '（手数料 ' + nf.format(t.fee) + '円）' : '') + '<br>両方の口座の残高を、移動する前に戻します。</p>', '取り消す', () => {
        applyTransfer(t, -1); renderKeep(); toast('取り消しました');
      });
    }));
    main.querySelectorAll('[data-act="snooze"]').forEach(b => b.addEventListener('click', () => { meta.snoozeUntil = new Date(Date.now() + 7 * 86400000).toISOString(); saveMeta(); renderKeep(); toast('1週間後にまたお知らせします'); }));
    const be = $('#backup-every'); if (be) be.addEventListener('change', () => { meta.backupEvery = Number(be.value); meta.snoozeUntil = null; saveMeta(); toast(meta.backupEvery ? 'お知らせ：' + be.options[be.selectedIndex].text : 'バックアップのお知らせを止めました'); });
    main.querySelectorAll('[data-act="hist-restore"]').forEach(b => b.addEventListener('click', () => {
      const h = readHistory()[Number(b.closest('[data-hist]').dataset.hist)]; if (!h) return;
      restoreBooksData(h.data, h.label);
    }));
    main.querySelectorAll('[data-reorder]').forEach(b => b.addEventListener('click', () => {
      meta.reorder = meta.reorder === b.dataset.reorder ? null : b.dataset.reorder; saveMeta(); renderKeep();
    }));
    main.querySelectorAll('.orow [data-mv]').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.orow'); moveItem(row.dataset.group, row.dataset.key, Number(b.dataset.mv));
    }));
    const go = (stab, kind) => { meta.page = 'settings'; meta.stab = stab; if (kind) meta.qkind = kind; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); };
    main.querySelectorAll('[data-act="go-acc"]').forEach(b => b.addEventListener('click', () => go('acc')));
    main.querySelectorAll('[data-act="go-out"]').forEach(b => b.addEventListener('click', () => go('out')));
    main.querySelectorAll('[data-act="go-in"]').forEach(b => b.addEventListener('click', () => go('in')));
    main.querySelectorAll('[data-act="go-close"]').forEach(b => b.addEventListener('click', () => { go('books'); const c = $('#closecard'); if (c) c.scrollIntoView({ block: 'start' }); }));
    main.querySelectorAll('[data-act="sample-clear"]').forEach(b => b.addEventListener('click', () => confirmSheet('サンプルを消しますか？', '<p class="sub" style="margin:0">サンプルの口座・支出・収入をすべて消して、空の状態からはじめます。</p>', '消してはじめる', () => {
      state = emptyState(); meta.page = 'prep'; saveMeta(); save(); renderAll(); window.scrollTo(0, 0); toast('空の状態になりました');
    }, true)));
    main.querySelectorAll('[data-act="wipe"]').forEach(b => b.addEventListener('click', () => confirmSheet('すべてのデータを消しますか？', '<p class="flag" style="margin:0">口座・支出・収入・残高がすべて消え、元に戻せません。</p>', 'すべて消す', () => {
      try { (books ? books.list : [{ id: 'main' }]).forEach(b => localStorage.removeItem(dataKey(b.id))); localStorage.removeItem(BOOKS); } catch (e) { /* 消せなくても画面は初期化する */ }
      books = null;
      try { localStorage.removeItem(HISTORY); } catch (e) { /* 履歴も消す */ }
      state = null; meta = { lastBackupAt: meta.lastBackupAt, backupEvery: meta.backupEvery }; saveMeta(); renderAll(); window.scrollTo(0, 0); $('#saved').textContent = ''; toast('すべてのデータを消しました');
    }, true)));
    bindSettings();
    bindRestore();
  }
  function bindBalances() {
    main.querySelectorAll('[data-bal]').forEach(el => {
      const name = el.dataset.bal; const b = state.balances[name] || (state.balances[name] = { amount: null, updatedAt: null });
      el.addEventListener('input', () => onAmountInput(el, () => b.amount, v => { b.amount = v; b.updatedAt = new Date().toISOString(); }));
      el.addEventListener('blur', () => { const v = parseAmount(el.value); if (!Number.isNaN(v)) el.value = yenTxt(v); });
    });
  }
  function bindCloud() {
    main.querySelectorAll('[data-act="cloud-restore"]').forEach(b => b.addEventListener('click', async () => {
      const d = await N.cloudLoad() || cloud.data;
      if (!d) { toast('iCloudのバックアップが見つかりません'); return; }
      restoreBooksData(d, 'iCloudのバックアップ（' + (d.exportedAt ? stampText(d.exportedAt).replace('更新：', '') : '') + '）');
    }));
  }
  function bindWelcome() {
    bindCloud();
    bindRestore();
    const se = main.querySelector('[data-act="start-empty"]'); if (se) se.addEventListener('click', () => { ensureBooks(); state = emptyState(); meta.page = 'prep'; saveMeta(); save(); renderAll(); });
    const ss = main.querySelector('[data-act="start-sample"]'); if (ss) ss.addEventListener('click', () => { ensureBooks(); state = sampleState(); meta.page = 'prep'; saveMeta(); save(); renderAll(); toast('サンプルデータを表示しました'); });
    main.querySelectorAll('[data-act="help"]').forEach(b => b.addEventListener('click', showHelp));
  }
  function bindRestore() { const f = $('#restoreFile'); if (f) f.addEventListener('change', onRestoreFile); }

  /** 開いている編集欄とスクロール位置を保ったまま描き直す */
  function renderKeep() {
    const y = window.scrollY;
    const open = [...main.querySelectorAll('[data-editor]:not([hidden])')].map(e => e.closest('.row').dataset.id);
    renderAll();
    open.forEach(id => { const r = main.querySelector('.row[data-id="' + id + '"] [data-editor]'); if (r) r.hidden = false; });
    window.scrollTo(0, y);
  }

  /* ---------- 確認シート（ブラウザ標準の確認ダイアログは使わない） ---------- */
  function confirmSheet(title, bodyHTML, okLabel, onOk, danger) {
    const m = $('#modal');
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">' + esc(title) + '</h2>' + bodyHTML +
      '<div class="btnrow"><button id="mCancel">' + (okLabel ? 'やめる' : '閉じる') + '</button>' + (okLabel ? '<button id="mOk" class="' + (danger ? 'danger' : 'primary') + '">' + esc(okLabel) + '</button>' : '') + '</div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    if (okLabel) $('#mOk').onclick = () => { close(); onOk(); };
    $('#mCancel').focus();
  }

  /* ---------- 口座間の移動（帳簿をまたいでも・非表示の口座も） ---------- */
  const SEP = '\u0001';
  function bookName(id) { const b = books && books.list.find(x => x.id === id); return b ? b.name : ''; }
  function getBookData(id) { return id === books.current ? state : (readBook(id) || emptyState()); }
  function putBookData(id, d) {
    if (id === books.current) { state = d; save(); return; }
    try { localStorage.setItem(dataKey(id), JSON.stringify(d)); } catch (e) { toast('保存できませんでした'); }
  }
  /** 全帳簿の口座の一覧（残高・締めまでの必要額・余り） */
  function accountCatalog() {
    ensureBooks();
    const T = today(); const out = [];
    for (const bk of books.list) {
      const d = getBookData(bk.id); let r = null;
      try { r = C.compute(d, T); } catch (e) { r = null; }
      for (const name of d.accounts) {
        const bank = r && r.banks.find(x => x.name === name);
        const bal = (d.balances[name] || {}).amount; const balance = bal == null ? null : Number(bal);
        const due = bank ? bank.due : 0;
        out.push({ key: bk.id + SEP + name, book: bk.id, bookName: bk.name, name, balance, due,
          surplus: balance == null ? 0 : Math.max(0, balance - due), shortfall: balance == null ? 0 : Math.max(0, due - balance),
          hidden: (d.hiddenAccounts || []).includes(name), excluded: (d.excludeSurplus || []).includes(name),
          firstNeed: bank ? bank.firstNeed : null, closing: r ? r.closing : null });
      }
    }
    return out;
  }
  function accLabel(c, many) { return (many && c.book !== books.current ? c.bookName + '・' : '') + c.name; }
  function tLabel(t, side) {
    const bk = side === 'from' ? (t.fromBook || books.current) : (t.toBook || books.current);
    const nm = side === 'from' ? t.from : t.to;
    return (bk !== books.current ? bookName(bk) + '・' : '') + nm;
  }
  function transfersHTML() {
    const list = (state.transfers || []).filter(t => !t.undone).slice(0, 5);
    if (!list.length) return '';
    return '<div class="xferlog"><b>最近の移動</b>' + list.map(t => '<div class="xrow" data-xid="' + esc(t.id) + '"><span class="grow"><span class="sub">' + (t.at ? stampText(t.at).replace('更新：', '') : '') + '</span><br>' +
      esc(tLabel(t, 'from')) + ' → ' + esc(tLabel(t, 'to')) + '　<b class="num">' + nf.format(t.amount) + '円</b>' + (t.fee ? '<span class="sub">（手数料 ' + nf.format(t.fee) + '円' + (t.feeFrom === 'amount' ? '・移動額から' : '') + '）</span>' : '') + '</span>' +
      '<button class="small" data-act="xfer-undo">取り消す</button></div>').join('') + '</div>';
  }
  /** 移動を反映（sign=1 記録 / -1 取り消し）。関係する帳簿の残高と記録をまとめて更新 */
  function applyTransfer(t, sign) {
    const fb = t.fromBook || books.current, tb = t.toBook || books.current;
    const ids = Array.from(new Set([fb, tb]));
    const data = {}; ids.forEach(id => { data[id] = getBookData(id); });
    const now = new Date().toISOString();
    const bal = (d, a) => d.balances[a] || (d.balances[a] = { amount: null, updatedAt: null });
    const outAmt = t.amount + (t.feeFrom === 'source' ? t.fee : 0), inAmt = t.amount - (t.feeFrom === 'amount' ? t.fee : 0);
    const A = bal(data[fb], t.from), B = bal(data[tb], t.to);
    A.amount = (A.amount || 0) - sign * outAmt; A.updatedAt = now;
    B.amount = (B.amount || 0) + sign * inAmt; B.updatedAt = now;
    ids.forEach(id => {
      const d = data[id]; d.transfers = d.transfers || [];
      if (sign > 0) d.transfers = [Object.assign({}, t)].concat(d.transfers).slice(0, 30);
      else d.transfers.forEach(x => { if (x.id === t.id) x.undone = true; });
    });
    ids.filter(id => id !== books.current).forEach(id => putBookData(id, data[id]));
    if (ids.includes(books.current)) save();
  }
  function feeKey(f, t) { return f + '→' + t; }
  function openTransfer(toName, fromName) {
    const cat = accountCatalog(); const many = books.list.length > 1;
    const by = k => cat.find(c => c.key === k);
    const fromKey0 = fromName ? books.current + SEP + fromName : '';
    let toKey = toName ? books.current + SEP + toName : '';
    if (!toKey && fromKey0) {
      // この口座から移すとき：この帳簿でいちばん引落の近い不足口座を移動先の候補にする
      const cand = cat.filter(c => c.book === books.current && !c.hidden && c.shortfall > 0 && c.key !== fromKey0)
        .sort((a, b) => (a.firstNeed ? C.serial(a.firstNeed) : Infinity) - (b.firstNeed ? C.serial(b.firstNeed) : Infinity))[0];
      if (cand) toKey = cand.key;
    }
    const to = by(toKey);
    const srcs = cat.filter(c => c.key !== toKey).sort((x, y) => (x.book === books.current ? 0 : 1) - (y.book === books.current ? 0 : 1) || y.surplus - x.surplus);
    const from = fromKey0 ? by(fromKey0) : srcs.find(c => c.book === books.current && c.surplus > 0 && !c.hidden);
    // 金額の初期値：移動先の不足（この口座から移すときは、余りを超えない範囲）
    let need = to ? to.shortfall : 0;
    if (fromKey0 && from && need) need = Math.min(need, Math.max(0, from.surplus));
    const lbl = c => esc(c.name) + (c.hidden ? '（非表示）' : '') + (c.balance != null ? '（残高 ' + nf.format(c.balance) + '円' + (c.surplus > 0 ? '・余り ' + nf.format(c.surplus) + '円' : '') + '）' : '（残高未入力）');
    const opts = (list, sel) => {
      let h = '<option value="">選ぶ</option>';
      for (const bk of books.list) {
        const items = list.filter(c => c.book === bk.id); if (!items.length) continue;
        if (many) h += '<optgroup label="' + esc(bk.name) + '">';
        h += items.map(c => '<option value="' + esc(c.key) + '"' + (c.key === sel ? ' selected' : '') + '>' + lbl(c) + '</option>').join('');
        if (many) h += '</optgroup>';
      }
      return h;
    };
    const fees = meta.fees || {};
    const fee0 = from && toKey ? (fees[feeKey(from.key, toKey)] || 0) : 0;
    const m = $('#modal');
    m.innerHTML = '<div class="sheet form xsheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">口座間で移す</h2>' +
      (fromKey0 ? '<p class="sub" style="margin:0"><b>' + esc(fromName) + '</b> からほかの口座へ移します。' + (to ? 'いちばん引落の近い不足口座を移動先にしています。' : '') + '</p>' : '') +
      '<p class="sub" style="margin:0">実際に振り込んだ・移した後に記録すると、両方の口座の残高が書きかわります。' + (many ? 'ほかの帳簿の口座や、非表示の口座も選べます。' : '非表示の口座も選べます。') + '</p>' +
      '<label>移動元<select id="x-from">' + opts(srcs, from ? from.key : '') + '</select></label>' +
      '<label>移動先<select id="x-to">' + opts(cat, toKey) + '</select></label>' +
      '<label>移す金額' + (need ? '<span class="sub">（締めまでの不足 ' + nf.format(need) + '円）</span>' : '') + '<input class="amount wide" id="x-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" value="' + (need ? yenTxt(need) : '') + '" placeholder="0"></label>' +
      '<div class="two"><label>手数料<input class="amount wide" id="x-fee" inputmode="numeric" enterkeyhint="done" autocomplete="off" value="' + (fee0 ? yenTxt(fee0) : '') + '" placeholder="0"></label>' +
      '<label>手数料の引かれ方<select id="x-feefrom"><option value="source"' + (meta.feeFrom !== 'amount' ? ' selected' : '') + '>移動元から引く</option><option value="amount"' + (meta.feeFrom === 'amount' ? ' selected' : '') + '>移す額から引く</option></select></label></div>' +
      '<div class="xprev" id="x-prev"></div>' +
      '<div class="btnrow"><button id="mCancel">やめる</button><button id="mOk" class="primary">移した残高を記録</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    const read = () => ({ from: $('#x-from').value, to: $('#x-to').value, amount: parseAmount($('#x-amt').value), fee: (v => v == null ? 0 : v)(parseAmount($('#x-fee').value)), feeFrom: $('#x-feefrom').value === 'amount' ? 'amount' : 'source' });
    const judge = (bal, due) => bal == null ? '' : bal - due >= 0 ? '<span class="okc">締めまで 余り ' + nf.format(bal - due) + '円</span>' : '<span class="ngc">締めまで 不足 ' + nf.format(due - bal) + '円</span>';
    const prev = () => {
      const x = read(); const el = $('#x-prev');
      const f = by(x.from), t = by(x.to);
      if (!f || !t || x.from === x.to || !(x.amount > 0) || Number.isNaN(x.fee)) { el.innerHTML = '<span class="sub">移動元・移動先・金額を入れると、移動後の残高が出ます</span>'; return x; }
      const outAmt = x.amount + (x.feeFrom === 'source' ? x.fee : 0), inAmt = x.amount - (x.feeFrom === 'amount' ? x.fee : 0);
      const after = f.balance == null ? null : f.balance - outAmt, tb = t.balance == null ? 0 : t.balance;
      el.innerHTML = '<div><b>' + esc(accLabel(f, true)) + '</b>：' + (f.balance == null ? '残高未入力' : nf.format(f.balance) + ' → <b class="num">' + nf.format(after) + '円</b>') + '（−' + nf.format(outAmt) + '）<br>' + judge(after, f.due) + '</div>' +
        '<div><b>' + esc(accLabel(t, true)) + '</b>：' + nf.format(tb) + ' → <b class="num">' + nf.format(tb + inAmt) + '円</b>（＋' + nf.format(inAmt) + '）<br>' + judge(tb + inAmt, t.due) + '</div>' +
        (f.book !== t.book ? '<p class="sub" style="margin:0">帳簿「' + esc(f.bookName) + '」から帳簿「' + esc(t.bookName) + '」への移動です。両方の帳簿に記録が残ります。</p>' : '') +
        (f.balance == null ? '<p class="flag" style="margin:0">移動元の残高が未入力です。先に残高を入力してください。</p>' : '') + (after != null && after < 0 ? '<p class="flag" style="margin:0">移動元の残高がマイナスになります。</p>' : '');
      return x;
    };
    ['#x-from', '#x-to', '#x-feefrom'].forEach(id => $(id).addEventListener('change', () => {
      if (id !== '#x-feefrom') { const fv = (meta.fees || {})[feeKey($('#x-from').value, $('#x-to').value)]; if (fv != null) $('#x-fee').value = yenTxt(fv); }
      prev();
    }));
    ['#x-amt', '#x-fee'].forEach(id => $(id).addEventListener('input', prev));
    prev();
    $('#mOk').onclick = () => {
      const x = prev(); const f = by(x.from), t = by(x.to);
      if (!f || !t) { toast('移動元と移動先を選んでください'); return; }
      if (x.from === x.to) { toast('移動元と移動先が同じです'); return; }
      if (Number.isNaN(x.amount) || !(x.amount > 0)) { toast('移す金額を数字で入力してください'); return; }
      if (Number.isNaN(x.fee)) { toast('手数料は数字で入力してください'); return; }
      if (x.feeFrom === 'amount' && x.fee >= x.amount) { toast('手数料が移す金額以上です'); return; }
      if (f.balance == null) { toast('移動元の残高を先に入力してください'); return; }
      const tr = { id: uid('t'), at: new Date().toISOString(), undone: false, fromBook: f.book, from: f.name, toBook: t.book, to: t.name, amount: x.amount, fee: x.fee, feeFrom: x.feeFrom };
      applyTransfer(tr, 1);
      meta.fees = Object.assign({}, meta.fees, { [feeKey(x.from, x.to)]: x.fee }); meta.feeFrom = x.feeFrom; saveMeta();
      close(); renderKeep(); toast(accLabel(f, true) + ' → ' + accLabel(t, true) + '：' + nf.format(x.amount) + '円を記録しました');
    };
    (toKey ? $('#x-amt') : $('#x-to')).focus();
    if (fromKey0 && !toKey) toast('「' + fromName + '」から移します。移動先を選んでください');
  }

  /** 不足をまとめて解消：余りのある口座から、不足している口座へ移す案を作る */
  function openBulk() {
    const cat = accountCatalog(); const many = books.list.length > 1;
    const useOthers = !!meta.bulkOthers;
    const short = cat.filter(c => c.book === books.current && !c.hidden && c.shortfall > 0)
      .sort((a, b) => (a.firstNeed ? C.serial(a.firstNeed) : Infinity) - (b.firstNeed ? C.serial(b.firstNeed) : Infinity));
    const srcs = cat.filter(c => c.surplus > 0 && !c.hidden && !c.excluded && (useOthers || c.book === books.current))
      .map(c => Object.assign({ left: c.surplus }, c)).sort((a, b) => b.surplus - a.surplus);
    const fees = meta.fees || {}, feeFrom = meta.feeFrom === 'amount' ? 'amount' : 'source';
    const plan = []; let uncovered = 0;
    for (const d of short) {
      let need = d.shortfall;
      for (const s of srcs) {
        if (need <= 0) break;
        if (s.key === d.key || s.left <= 0) continue;
        const fee = fees[feeKey(s.key, d.key)] || 0;
        // 手数料込みで移せる額
        const send = feeFrom === 'source' ? Math.min(need, s.left - fee) : Math.min(need + fee, s.left);
        if (send <= (feeFrom === 'amount' ? fee : 0)) continue;
        s.left -= send + (feeFrom === 'source' ? fee : 0);
        need -= send - (feeFrom === 'amount' ? fee : 0);
        plan.push({ from: s, to: d, amount: send, fee });
      }
      if (need > 0) uncovered += need;
    }
    const rows = plan.map((p, i) => '<div class="brow" data-i="' + i + '"><label class="check"><input type="checkbox" checked data-use></label>' +
      '<div class="grow"><div><b>' + esc(accLabel(p.from, many)) + '</b> → <b>' + esc(accLabel(p.to, many)) + '</b></div>' +
      '<div class="two"><label>金額<input class="amount wide" inputmode="numeric" data-amt value="' + yenTxt(p.amount) + '"></label><label>手数料<input class="amount wide" inputmode="numeric" data-fee value="' + (p.fee ? yenTxt(p.fee) : '') + '" placeholder="0"></label></div></div></div>').join('');
    const m = $('#modal');
    m.innerHTML = '<div class="sheet form xsheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">不足をまとめて解消</h2>' +
      '<p class="sub" style="margin:0">余りの多い口座から、引落の近い口座の順に移す案です。実際に振り込んだあとで「記録」を押すと、残高が書きかわります。手数料は口座の組み合わせごとに前回の金額が入ります（' + (feeFrom === 'source' ? '移動元から引く' : '移す額から引く') + '）。</p>' +
      (many ? '<label class="check"><input type="checkbox" id="b-others"' + (useOthers ? ' checked' : '') + '>ほかの帳簿の余りも使う</label>' : '') +
      (plan.length ? '<div class="blist">' + rows + '</div>' : '<p class="sub" style="margin:0">' + (short.length ? '移せる余りがありません。' : '不足している口座はありません。') + '</p>') +
      (uncovered > 0 ? '<p class="flag" style="margin:0">余りでまかなえない不足が ' + nf.format(uncovered) + '円 あります。</p>' : '') +
      '<div class="btnrow"><button id="mCancel">やめる</button>' + (plan.length ? '<button id="mOk" class="primary">チェックした移動を記録</button>' : '') + '</div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    const bo = $('#b-others'); if (bo) bo.addEventListener('change', () => { meta.bulkOthers = bo.checked; saveMeta(); openBulk(); });
    if (!plan.length) return;
    $('#mOk').onclick = () => {
      const picks = [];
      for (const row of m.querySelectorAll('.brow')) {
        if (!row.querySelector('[data-use]').checked) continue;
        const p = plan[Number(row.dataset.i)];
        const amt = parseAmount(row.querySelector('[data-amt]').value), fee = (v => v == null ? 0 : v)(parseAmount(row.querySelector('[data-fee]').value));
        if (Number.isNaN(amt) || !(amt > 0) || Number.isNaN(fee)) { toast('金額・手数料は数字で入力してください'); return; }
        if (feeFrom === 'amount' && fee >= amt) { toast('手数料が移す金額以上の行があります'); return; }
        picks.push({ p, amt, fee });
      }
      if (!picks.length) { toast('記録する移動を選んでください'); return; }
      const at = new Date().toISOString();
      for (const k of picks) {
        applyTransfer({ id: uid('t'), at, undone: false, fromBook: k.p.from.book, from: k.p.from.name, toBook: k.p.to.book, to: k.p.to.name, amount: k.amt, fee: k.fee, feeFrom }, 1);
        meta.fees = Object.assign({}, meta.fees, { [feeKey(k.p.from.key, k.p.to.key)]: k.fee });
      }
      saveMeta(); close(); renderKeep(); toast(picks.length + '件の移動を記録しました');
    };
  }

  function bindCycle() {
    main.querySelectorAll('[data-cyc]').forEach(b => b.addEventListener('click', () => {
      cycleOffset = Math.max(-12, Math.min(12, cycleOffset + Number(b.dataset.cyc)));
      const el = $('#cycleSec'); if (el) { el.outerHTML = cycleHTML(); bindCycle(); }
    }));
  }

  /* ---------- その場で追加するシート ---------- */
  function openAddSheet(kind) {
    kind = ['fixed', 'once'].includes(kind) ? kind : 'variable';
    const kname = { variable: '変動費', fixed: '固定費', once: '1回のみの引落' }[kind];
    const accs = visibleAccounts();
    if (!accs.length) { toast('先に「設定 → 口座」で口座を登録してください'); return; }
    const acc = accs.includes(meta.qacc) ? meta.qacc : '';
    const day = meta.qday === 'end' || (Number(meta.qday) >= 1 && Number(meta.qday) <= 31) ? (meta.qday === 'end' ? 'end' : Number(meta.qday)) : 27;
    const m = $('#modal');
    m.innerHTML = '<div class="sheet form xsheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">' + kname + 'を追加</h2>' +
      '<label>項目名<input class="text" id="as-name" autocomplete="off" placeholder="例：クレジットカード"></label>' +
      '<label>金額（わからなければ空欄）<input class="amount wide" id="as-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" placeholder="未入力"></label>' +
      '<div class="two"><label>引落日' + (kind === 'once' ? '<input class="text" type="date" id="as-date" value="' + (meta.qdate || isoOf(today())) + '">' : daySelect('as-day', day)) + '</label>' +
      '<label>引落口座<select id="as-acc">' + (acc ? '' : '<option value="" selected>選ぶ</option>') + accs.map(a => '<option' + (a === acc ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label></div>' +
      '<label>引落日が休日のとき' + shiftSelect('as-shift', validShift(meta.qshift, 'after')) + '</label>' +
      (kind === 'fixed' ? '<label>終了月（ローンなど。なければ空欄）<input class="text" type="month" id="as-end"></label>' : '') +
      '<p class="note" id="as-last" style="margin:0"></p>' +
      '<div class="btnrow"><button id="mCancel">閉じる</button><button id="as-more">追加して続ける</button><button id="mOk" class="primary">追加</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    const amt = $('#as-amt');
    amt.addEventListener('blur', () => { const v = parseAmount(amt.value); if (!Number.isNaN(v)) amt.value = yenTxt(v); });
    let added = null;
    const add = () => {
      const name = $('#as-name').value.trim(); const v = parseAmount(amt.value); const a = $('#as-acc').value;
      if (!name) { toast('項目名を入力してください'); $('#as-name').focus(); return false; }
      if (Number.isNaN(v)) { toast('金額は数字で入力してください'); amt.focus(); return false; }
      if (!a) { toast('引落口座を選んでください'); return false; }
      const shift = validShift($('#as-shift').value, 'after');
      const it = { id: uid(kind === 'fixed' ? 'f' : kind === 'once' ? 'o' : 'v'), name, account: a, amount: v, memo: '', updatedAt: new Date().toISOString(), hidden: false, shift };
      if (kind === 'once') {
        const dv = $('#as-date').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(dv)) { toast('引落日を選んでください'); return false; }
        it.date = dv; meta.qdate = dv;
      } else {
        const dv = $('#as-day').value; it.day = dv === 'end' ? 'end' : Number(dv); meta.qday = it.day;
      }
      if (kind === 'fixed') { const e = $('#as-end'); it.end = e && e.value ? e.value : null; }
      state.once = state.once || [];
      state[kind].push(it); meta.qacc = a; meta.qshift = shift; saveMeta(); save();
      added = it.id;
      toast('「' + name + '」を追加しました');
      return true;
    };
    $('#mOk').onclick = () => {
      if (!add()) return;
      close(); renderKeep();
      const row = main.querySelector('.row[data-id="' + added + '"]');
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); }
    };
    $('#as-more').onclick = () => {
      if (!add()) return;
      $('#as-last').textContent = '追加しました：' + $('#as-name').value.trim();
      $('#as-name').value = ''; amt.value = ''; $('#as-name').focus();
      renderKeep();
    };
    $('#as-name').focus();
  }

  /* ---------- バックアップ ---------- */
  function stampFile(t) { const p = n => String(n).padStart(2, '0'); return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()); }
  async function doBackup() {
    const now = new Date();
    save();
    const data = allBooksData(now);
    const name = '家計バックアップ_' + stampFile(now) + '.json';
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const done = () => { meta.lastBackupAt = now.toISOString(); saveMeta(); renderKeep(); toast('バックアップを作りました'); };
    if (N.isNative) {
      try { if (await N.shareFile(name, JSON.stringify(data, null, 1))) done(); else toast('バックアップをやめました'); }
      catch (e) { toast('バックアップを作れませんでした'); }
      return;
    }
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        done(); return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('バックアップをやめました'); return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    done();
  }

  function restoreBooksData(raw, title) {
    let list;
    try {
      if (!raw || !Array.isArray(raw.books) || !raw.books.length) throw new Error('帳簿が入っていません');
      list = raw.books.map((b, i) => ({ id: i === 0 ? 'main' : String(b.id && b.id !== 'main' ? b.id : uid('b')), name: String(b.name || '帳簿' + (i + 1)), data: normalize(b.data) }));
    } catch (err) { toast('戻せませんでした：' + (err.message || '形式が違います')); return; }
    const body = '<dl>' + list.map(b => '<dt>' + esc(b.name) + '</dt><dd>口座' + b.data.accounts.length + '・支出' + (b.data.variable.length + b.data.fixed.length + b.data.once.length) + '件</dd>').join('') + '</dl>' +
      '<p class="flag" style="margin:0">今のすべての帳簿は、この時点の内容に置きかわります。</p>';
    confirmSheet(title + 'に戻しますか？', body, 'この時点に戻す', () => {
      try { if (books) books.list.forEach(b => localStorage.removeItem(dataKey(b.id))); } catch (e2) { /* 上書きで置きかわる */ }
      const curIdx = Math.max(0, raw.books.findIndex(b => b.id === raw.current));
      books = { current: list[curIdx].id, list: list.map(b => ({ id: b.id, name: b.name })) };
      list.forEach(b => { try { localStorage.setItem(dataKey(b.id), JSON.stringify(b.data)); } catch (e2) { toast('保存できませんでした'); } });
      saveBooks(); state = readBook(books.current) || emptyState();
      meta.page = 'prep'; saveMeta(); renderAll(); window.scrollTo(0, 0); toast('戻しました');
    }, true);
  }

  function onRestoreFile(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let raw;
      try { raw = JSON.parse(String(rd.result)); } catch (err) { toast('読み込めませんでした：ファイルの形式が違います'); return; }
      const sum = a => a.reduce((s, x) => s + (x.amount || 0), 0);
      const when = raw.exportedAt ? stampText(raw.exportedAt).replace('更新：', '') : (raw.source ? raw.source + ' から作成' : '不明');
      if (raw && raw.kind === 'books' && Array.isArray(raw.books)) {
        // すべての帳簿のバックアップ
        let list;
        try {
          if (!raw.books.length) throw new Error('帳簿が入っていません');
          list = raw.books.map((b, i) => ({ id: i === 0 ? 'main' : String(b.id && b.id !== 'main' ? b.id : uid('b')), name: String(b.name || '帳簿' + (i + 1)), data: normalize(b.data) }));
        } catch (err) { toast('読み込めませんでした：' + (err.message || 'ファイルの形式が違います')); return; }
        const body = '<dl><dt>ファイル</dt><dd>' + esc(f.name) + '</dd><dt>作成</dt><dd>' + esc(when) + '</dd>' +
          list.map(b => '<dt>' + esc(b.name) + '</dt><dd>口座' + b.data.accounts.length + '・支出' + (b.data.variable.length + b.data.fixed.length + b.data.once.length) + '件</dd>').join('') + '</dl>' +
          (state ? '<p class="flag" style="margin:0">今アプリに入っているすべての帳簿は上書きされ、元に戻せません。</p>' : '');
        confirmSheet('すべての帳簿（' + list.length + '冊）を復元しますか？', body, state ? '上書きして復元' : '読み込む', () => {
          try { if (books) books.list.forEach(b => localStorage.removeItem(dataKey(b.id))); } catch (e2) { /* 上書きで置きかわる */ }
          const curIdx = Math.max(0, raw.books.findIndex(b => b.id === raw.current));
          books = { current: list[curIdx].id, list: list.map(b => ({ id: b.id, name: b.name })) };
          list.forEach(b => { try { localStorage.setItem(dataKey(b.id), JSON.stringify(b.data)); } catch (e2) { toast('保存できませんでした'); } });
          saveBooks(); state = readBook(books.current) || emptyState();
          meta.page = 'prep'; saveMeta(); renderAll(); window.scrollTo(0, 0); toast('読み込みました');
        }, !!state);
        return;
      }
      // 1冊分のデータ（以前の版のバックアップ・初期データ）→ 今の帳簿へ
      let d;
      try { d = normalize(raw); } catch (err) { toast('読み込めませんでした：' + (err.message || 'ファイルの形式が違います')); return; }
      const bn = curBook() ? curBook().name : 'メイン';
      const body = '<dl><dt>ファイル</dt><dd>' + esc(f.name) + '</dd><dt>作成</dt><dd>' + esc(when) + '</dd>' +
        '<dt>変動費</dt><dd>' + d.variable.length + '件・' + nf.format(sum(d.variable)) + '円</dd>' +
        '<dt>固定費</dt><dd>' + d.fixed.length + '件・' + nf.format(sum(d.fixed)) + '円</dd>' +
        (d.once.length ? '<dt>1回のみ</dt><dd>' + d.once.length + '件・' + nf.format(sum(d.once)) + '円</dd>' : '') +
        '<dt>口座</dt><dd>' + d.accounts.length + '口座</dd><dt>読み込み先</dt><dd>帳簿「' + esc(bn) + '」</dd></dl>' +
        (state && (state.accounts.length || state.variable.length || state.fixed.length) ? '<p class="flag" style="margin:0">帳簿「' + esc(bn) + '」の今の内容は上書きされ、元に戻せません。ほかの帳簿はそのままです。</p>' : '');
      confirmSheet('帳簿「' + bn + '」に読み込みますか？', body, '読み込む', () => {
        ensureBooks(); state = d; meta.page = 'prep'; saveMeta(); save(); renderAll(); window.scrollTo(0, 0); toast('読み込みました');
      }, !!state);
    };
    rd.onerror = () => toast('ファイルを読めませんでした');
    rd.readAsText(f);
  }

  /* ---------- 移動ボタン ---------- */
  const PAGES = ['prep', 'variable', 'fixed', 'settings'];
  const TYPING = 'input:not([type="file"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), select, textarea';
  // 指が触れている間は下のタブを出し入れしない（ボタンを押した瞬間にタブが重なるのを防ぐ）
  let pointerDown = false;
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const pointerEnd = () => { pointerDown = false; setTimeout(syncTyping, 120); };
  document.addEventListener('pointerup', pointerEnd, true);
  document.addEventListener('pointercancel', pointerEnd, true);
  function syncTyping() {
    if (pointerDown) return;
    const a = document.activeElement;
    document.body.classList.toggle('typing', !!(a && a.isConnected && a !== document.body && a.matches(TYPING)));
  }
  const nav = $('#nav');
  nav.addEventListener('click', e => {
    const b = e.target.closest('[data-page]'); if (!b) return;
    if (meta.page === b.dataset.page) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    meta.page = b.dataset.page; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0);
  });
  // 入力中はキーボードと重ならないよう隠す（ファイル選択は除く。描き直しで入力欄が消えた時も戻す）
  document.addEventListener('focusin', () => syncTyping());
  document.addEventListener('focusout', () => setTimeout(syncTyping, 120));
  window.addEventListener('focus', () => syncTyping());
  window.addEventListener('pageshow', () => syncTyping());

  $('#helpBtn').addEventListener('click', showHelp);
  const fabTop = $('#fabTop'), fabAdd = $('#fabAdd');
  const syncFab = () => {
    fabTop.hidden = !state || window.scrollY < 500;
    const pg = meta.page;
    fabAdd.hidden = !state || !(pg === 'variable' || pg === 'fixed');
    if (!fabAdd.hidden) fabAdd.textContent = pg === 'fixed' ? '＋ 固定費' : '＋ 変動費';
  };
  window.addEventListener('scroll', () => { cancelAnimationFrame(syncFab._r); syncFab._r = requestAnimationFrame(syncFab); }, { passive: true });
  fabTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  fabAdd.addEventListener('click', () => openAddSheet(meta.page === 'fixed' ? 'fixed' : 'variable'));
  $('#books').addEventListener('click', e => {
    const b = e.target.closest('[data-book]'); if (b) { switchBook(b.dataset.book); return; }
    if (e.target.closest('[data-act="book-add"]')) { meta.page = 'settings'; meta.stab = 'books'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); const n = $('#booknew'); if (n) n.focus(); }
  });

  /* ---------- 起動 ---------- */
  function boot() {
  load();
  renderAll();
  if (state) $('#saved').textContent = '保存済み';
  // 日付が変わったら確認日と集計を更新（入力中は邪魔しない）
  const tick = () => { if (keyOf(today()) !== todayKey && !(document.activeElement && document.activeElement.matches('input,select'))) renderKeep(); };
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); syncTyping(); } });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!N.isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (N.isNative) {
    // iCloudの状態を確認（ウェルカム画面で復元を出す・自動バックアップ）
    N.cloudAvailable().then(async ok => {
      cloud.available = ok;
      if (ok) cloud.data = await N.cloudLoad();
      renderKeep();
      if (ok && state) snapshot();
    });
  }
  }
  Promise.resolve(N.ready).catch(() => {}).then(boot);
})();
