/* 引落ナビ — 画面・保存・バックアップ（データはこの端末の中だけに保存し、外部へは送信しません） */
(function () {
  'use strict';
  const C = window.KCalc;
  const APP_VERSION = '2026.11.08b';
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
  function switchBook(id, keepPage) {
    if (!books || id === books.current) return;
    books.current = id; saveBooks();
    state = readBook(id) || emptyState();
    if (!keepPage) meta.page = 'prep';
    meta.reorder = null; saveMeta();
    renderAll(); window.scrollTo(0, 0); toast('「' + curBook().name + '」の帳簿を開きました');
  }
  function save() {
    try {
      ensureBooks();
      localStorage.setItem(dataKey(books.current), JSON.stringify(state));
      clearTimeout(save._h); save._h = setTimeout(snapshot, 1500);
      queueNotify();
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
      const o = { id: x.id || uid(fixed ? 'f' : 'v'), name: String(x.name || '').trim() || '（名称なし）', day: x.day, account: x.account || '', amount: x.amount == null ? null : Number(x.amount), memo: x.memo || '', updatedAt: x.updatedAt || null, hidden: !!x.hidden, shift: validShift(x.shift, 'after'), month: /^\d{4}-\d{2}$/.test(String(x.month || '')) ? String(x.month) : null };
      if (fixed === 'once') {
        o.date = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? String(x.date) : null; delete o.day;
        if (!o.date) throw new Error('日付が読み取れない項目があります：' + o.name);
        if (!validAmt(o.amount)) throw new Error('金額が読み取れない項目があります：' + o.name);
        return o;
      }
      if (fixed) o.end = x.end || null;
      if (Number(x.nm) === 1) o.nm = 1; // 翌月の引落日（例：翌10日）
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
      settings: (() => { const cs = C.closeSettings(d); return { closeDay: cs.d1.day, closeShift: cs.d1.shift, close2On: !!cs.d2, close2Day: cs.d2saved.day, close2Shift: cs.d2saved.shift }; })(),
      excludeSurplus: Array.isArray(d.excludeSurplus) ? d.excludeSurplus.map(String).filter(a => d.accounts.map(String).includes(a)) : [],
      hiddenAccounts: Array.isArray(d.hiddenAccounts) ? d.hiddenAccounts.map(String).filter(a => d.accounts.map(String).includes(a)) : [],
      income: Array.isArray(d.income) && d.income.length ? d.income.map(i => Object.assign({ id: i.id || uid('i'), name: String(i.name), day: i.day, amount: i.amount == null ? null : Number(i.amount), hidden: !!i.hidden, shift: validShift(i.shift, 'before') },
          /^\d{4}-\d{2}-\d{2}$/.test(String(i.date || '')) ? { date: i.date } : {},
          Array.isArray(i.months) && i.months.length ? { months: i.months.map(Number).filter(m => m >= 1 && m <= 12).sort((a, b) => a - b) } : {}))
        : [],
      transfers: Array.isArray(d.transfers) ? d.transfers.filter(t => t && t.from && t.to && Number(t.amount) > 0).map(t => ({ id: t.id || uid('t'), at: t.at || null, fromBook: t.fromBook || null, from: String(t.from), toBook: t.toBook || null, to: String(t.to), amount: Number(t.amount), fee: Number(t.fee) || 0, feeFrom: t.feeFrom === 'amount' ? 'amount' : 'source', undone: !!t.undone })).slice(0, 30) : [],
      history: Array.isArray(d.history) ? d.history.filter(h => h && /^\d{4}-\d{2}-\d{2}$/.test(String(h.date))).map(h => ({ id: h.id || uid('h'), date: String(h.date), name: String(h.name || ''), account: String(h.account || ''), amount: h.amount == null ? null : Number(h.amount), kind: String(h.kind || 'その他'), src: h.src || null, auto: !!h.auto, edited: !!h.edited, deductChecked: !!h.deductChecked, deducted: !!h.deducted })) : [],
      historySince: /^\d{4}-\d{2}-\d{2}$/.test(String(d.historySince || '')) ? d.historySince : null,
      deductSince: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deductSince || '')) ? d.deductSince : null,
      autoDeduct: d.autoDeduct !== false,
      historyUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(d.historyUntil || '')) ? d.historyUntil : null
    };
    for (const a of out.accounts) {
      const b = (d.balances || {})[a] || {};
      out.balances[a] = { amount: b.amount == null ? null : Number(b.amount), updatedAt: b.updatedAt || null };
    }
    return out;
  }

  /* ---------- 画面 ---------- */
  function renderAll() {
    requestAnimationFrame(syncPill);
    const T = today(); todayKey = keyOf(T);
    $('#nav').hidden = !state;
    const bk = $('#books');
    bk.hidden = !state;
    if (state && books) {
      bk.innerHTML = books.list.map((b, i) => '<button class="book b' + (i % 5) + (b.id === books.current ? ' on' : '') + '" data-book="' + esc(b.id) + '"' + (b.id === books.current ? ' aria-current="true"' : '') + '>' + esc(b.name) + '</button>').join('') +
        '<button class="book add" data-act="book-add" aria-label="帳簿を追加">＋ 帳簿</button>';
    }
    $('#today').textContent = T.m + '月' + T.d + '日（' + C.WD[C.weekday(T)] + '）';
    document.querySelector('.todaycard').hidden = !state;
    if (!state) { main.innerHTML = welcomeHTML(); bindWelcome(); return; }
    if (versionMismatch()) {
      main.innerHTML = '<div class="notice"><div><b>アプリのファイルが一部だけ古いままです。</b><br>古いファイル：<b>' + staleFiles().join('、') + '</b><br>このファイルをアップロードし直してください。アップロード済みなら、アプリを閉じて数分後に開き直してください。（app.js：' + APP_VERSION + '／calc.js：' + (C && C.VERSION || '古い版') + '）</div></div>';
      return;
    }
    recordPast();
    rollVariable();
    const r = C.compute(state, T);
    const page = PAGES.includes(meta.page) ? meta.page : 'prep';
    main.innerHTML = page === 'variable' ? listHTML('variable', '変動費', '何月分の引落かを選んで、金額を入力します。引落が済むと次の月に進みます。') + listHTML('once', '1回のみの引落', '日付を決めて1回だけ引き落とされるもの（年払い・臨時の支払いなど）。過ぎたものは「済み」にまとまります。')
      : page === 'fixed' ? listHTML('fixed', '固定費', '金額・引落日・口座が変わった時だけ変更します。')
      : page === 'settings' ? settingsHTML()
      : page === 'history' ? historyHTML()
      : page === 'income' ? '<div class="card"><div class="pad"><div class="section-head"><h2>収入</h2></div><p class="sub" style="margin:0">毎月の収入のほか、ボーナスのように年に何回かの収入や、1回だけの臨時収入も登録できます。未入金の収入は口座残高に足しません。</p></div></div>' + inHTML()
      : sampleBannerHTML() + (needsSetup() ? setupGuideHTML() : backupNoticeHTML()) + summaryHTML(r) +
        '<p class="note">表示される金額と日付は、登録した内容から計算した目安です。実際の引落日・金額は金融機関やカード会社の案内で確認してください。</p>';
    if (typeof syncFab === 'function') setTimeout(syncFab, 0);
    document.body.className = document.body.className.replace(/\bpg-\S+/g, '').trim() + ' pg-' + page;
    $('#nav').querySelectorAll('[data-page]').forEach(b => { const on = b.dataset.page === page; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    syncPanelPage();
    bindAll();
    if (typeof syncTyping === 'function') syncTyping();
  }

  /** 入力中は入力欄を作り直さず、数字だけ書き換える */
  function refreshNumbers() {
    const r = C.compute(state, today());
    main.querySelectorAll('[data-sum]').forEach(el => { el.innerHTML = yen(r.totals[el.dataset.sum]); });
    const sb = $('#shortbox'); if (sb) { sb.outerHTML = shortboxHTML(r); const bb = main.querySelector('#shortbox [data-act="bulk"]'); if (bb) bb.addEventListener('click', openBulk); bindSurBrk(); }
    const cyc = $('#cycleSec'); if (cyc) { cyc.outerHTML = cycleHTML(); bindCycle(); }
    const fb = $('#flowBox'); if (fb) { fb.innerHTML = flowHTML(); bindFlow(); }
    const scb = $('#schedBox'); if (scb) { scb.innerHTML = schedHTML(); bindSched(); }
    const tt = main.querySelector('[data-total]'); if (tt) { tt.innerHTML = totalInner(r); bindTotal(); }
    const bl = $('#ballist'); if (bl && !bl.contains(document.activeElement)) { bl.innerHTML = balListHTML(r); bindBalList(); }
    const ptH = prepTopHTML(r);
    const pt = $('#prepTop'); if (pt) pt.innerHTML = ptH.top;
    const sn = $('#schedNotice'); if (sn) sn.innerHTML = prepNoticeHTML(r);
    if (pt || sn) { bindPanels(); bindUpcoming(); bindPrepTop(); }
    const up = main.querySelector('.upcoming'); if (up) { up.outerHTML = upcomingHTML(r); bindUpcoming(); }
    const at = $('#acctable'); if (at) { at.outerHTML = acctableHTML(r); main.querySelectorAll('#acctable [data-goto]').forEach(b => b.addEventListener('click', () => gotoBank(b.dataset.goto))); }
    if (!$('#banksSec')) return;
    const shown = [...main.querySelectorAll('.bank:not(.idlebank)')].map(c => c.dataset.bank).join('|');
    if (shown !== r.banks.filter(b => b.active).map(b => b.name).join('|')) {
      const sec = $('#banksSec'); sec.outerHTML = banksHTML(r); bindBalances(); bindLines(); bindXfer(); return;
    }
    for (const b of r.banks) {
      const card = main.querySelector('.bank[data-bank="' + CSS.escape(b.name) + '"]');
      if (!card) continue;
      card.querySelectorAll('[data-bsum]').forEach(el => { el.innerHTML = yen(b.sums[el.dataset.bsum]); });
      const st = card.querySelector('[data-status]'); if (st) st.outerHTML = statusHTML(b, r);
      const af = card.querySelector('[data-after]'); if (af) af.outerHTML = afterHTML(b, r);
      const xb = card.querySelector('.bank-row2 [data-act^="xfer"]');
      if (xb && !card.classList.contains('idlebank') && xb.dataset.act !== (b.shortfall > 0 ? 'xfer-to' : 'xfer-from')) {
        xb.outerHTML = xferBtn(b); bindXfer();
      }
      card.classList.toggle('is-short', b.shortfall > 0);
      card.classList.toggle('nobal', b.balance == null);
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

  function emptyState() { return { app: 'kakeibo', version: 1, source: '', settings: { closeDay: 10, closeShift: 'after', close2On: false, close2Day: 'end', close2Shift: 'none' }, once: [], accounts: [], variable: [], fixed: [], balances: {}, hiddenAccounts: [], income: [] }; }

  /** 架空のサンプル（人名・実在の口座名は使わない） */
  function sampleState() {
    const now = new Date().toISOString();
    const v = (name, day, account, amount) => ({ id: uid('v'), name, day, account, amount, memo: '', updatedAt: now, hidden: false, shift: 'after' });
    const f = (name, day, account, amount, end) => ({ id: uid('f'), name, day, account, amount, end: end || null, memo: '', updatedAt: now, hidden: false, shift: 'after' });
    const A = '生活費口座', B = 'カード引落口座', L = 'ローン口座', M = '現金';
    const d = { app: 'kakeibo', version: 1, source: 'サンプル', sample: true, accounts: [A, B, L, M], hiddenAccounts: [],
      variable: [v('クレジットカードA', 27, B, 48000), v('クレジットカードB', 10, B, 23500), v('電気代', 26, A, 9800), v('ガス代', 26, A, 5200), v('水道代', 'end', A, 0)],
      fixed: [f('家族のこづかい', 25, M, 30000), f('住宅ローン', 27, L, 85000, '2045-03'), f('携帯電話', 26, A, 6800), f('生命保険', 27, A, 12000), f('習い事', 5, A, 8000), f('家電の分割払い', 1, B, 4500, '2027-06')],
      balances: {}, income: [{ id: uid('i'), name: '給料', day: 25, amount: 280000, hidden: false, shift: 'before' }, { id: uid('i'), name: '児童手当', day: 15, amount: 20000, months: [2, 4, 6, 8, 10, 12], hidden: false, shift: 'before' }, { id: uid('i'), name: '臨時収入（例）', day: 20, date: isoOf(C.addDays(today(), 12)), amount: 30000, hidden: false, shift: 'before' }] };
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
      '<h3>締め日と期間</h3><p>初めは締め日（毎月10日）が1つで、確認日から次の締め日までの引落で不足と余りを判定します。月末までなど、もう一つの期限の分も見たいときは「設定 → 帳簿」で「＋ もう一つの期限を追加」を押すと、参考として並びます。「設定 → 帳簿」で、それぞれ1〜28日または月末と、休日に当たったときの扱い（後ろ・前・ずらさない）に変えられます。確認日（今日）から次の締め日までの引落で、不足と余りを判定します。</p>' +
      '<h3>休日のずれ</h3><p>土日・祝日・年末年始（12/31〜1/3）に当たる日は、項目ごとに「後ろにずらす／前にずらす／ずらさない」を選べます。初期値は、支出が後ろ（翌営業日）、収入が前（前営業日）です。</p>' +
      '<h3>表示モード</h3><p>標準はライトモード（明るい表示）です。「設定 → 表示」で、ライトモード・ダークモード・自動（iPhoneの設定に合わせる）を選べます。</p>' +
      '<h3>締め期間の収支</h3><p>準備ページの「締め期間の収支」に、締め日の翌日から次の締め日までの収入の合計・支出の合計・差し引きが出ます。‹ › で前後の期間も見られます。</p>' +
      '<h3>移動と追加</h3><p>下のタブで今のページをもう一度押すか、右下の「↑」で一番上に戻れます。変動費・固定費のページでは、右下の「＋」や見出しの「＋ 追加」から、ページを移らずに追加できます。「追加して続ける」で何件も続けて入れられます。</p>' +
      '<h3>帳簿</h3><p>家族のお金なども、人ごとに別の帳簿で管理できます。画面上の名前をタップすると切り替わり、「＋ 帳簿」で追加できます。バックアップは全部の帳簿をまとめて保存します。</p>' +
      '<h3>口座間の移動</h3><p>不足している口座の「ほかの口座から移す」は、その口座へ入れる移動です。それ以外の口座の「ほかの口座へ移す」は、その口座から出す移動です。ほかの帳簿の口座（自分 → 母など）や、非表示の口座とも移動できます。準備ページの「ほかの口座から移す」「口座間で移す」で、実際に移したお金を記録すると、両方の残高が書きかわります。不足している口座から開くと、不足額が最初から入ります。手数料は「移動元から別に引く」か「移す金額から引く」を選べ、口座の組み合わせごとに前回の手数料を覚えます。間違えたときは、両方の口座の残高を入れ直してください。</p>' +
      '<h3>引き落としの記録</h3><p>下のタブの「記録」に、引落日が来た分がそのときの金額で自動で残ります。月ごとの合計・先月との差・口座ごとの合計が見られ、実際の金額と違うときは押して直せます。CSVで書き出すとExcelで開けます。</p>' +
      '<h3>プレミアム（iPhoneアプリ版・買い切り）</h3><p>「設定 → 表示」でアプリの色を選べます（ブルー・ピンク・グリーン・パープル・オレンジ）。アプリの色に合わせて、画面上のロゴとホーム画面のアイコンも同じ色になります（アイコンを変えたくないときは、スイッチでオフにできます）。</p>' +
        '<h3>引落前のお知らせ（プレミアム）</h3><p>iPhoneアプリ版のプレミアムでは、「設定 → 通知」で、引落日の当日・前日・2日前などに通知でお知らせできます（時刻も選べます）。通知の予約はiPhoneの中だけで行い、外部には送りません。ロック画面に金額を出したくないときは「金額も表示する」をオフにしてください。Webアプリ版では通知は届きません。</p>' +
        '<h3>電卓</h3><p>変動費・1回のみの引落の金額欄の右にある電卓のボタンで、明細の合計などをその場で計算できます。入っている金額から計算が始まり、「この金額にする」でそのまま金額欄に入ります（小数は四捨五入します）。</p>' +
        '<h3>何月分の引落か</h3><p>変動費は金額が毎月変わるので、各行で「○月分」を選んで入力します。金額はその月の引落にだけ使い、ほかの月は「未入力」として扱います。選んだ月の引落が済むと、自動で次の月に進んで金額が空になり、次の請求額を入れられる状態になります（済んだ分は「記録」に残ります。0円の項目はそのまま引き継ぎます）。</p>' +
      '<h3>1回のみの引落</h3><p>年払いの保険や税金など、決まった日に1回だけ引き落とされるものは、「変動費」ページの下にある「1回のみの引落」の「＋追加」から、日付を指定して追加します。変動費ページの下に並び、日付が過ぎると「済み」にまとまります。</p>' +
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
    // 開いたときは、不足があれば不足の内訳、なければ余りの内訳を最初から表示（閉じたら 'none'）
    const sel = meta.sbSel === 'short' || meta.sbSel === 'plus' ? meta.sbSel : meta.sbSel === 'none' ? null : (r.shortfallTotal > 0 ? 'short' : 'plus');
    const box = (cls, title, count, amount, sub, key) => '<div class="tot ' + cls + '"><span class="tl">' + title + '</span>' +
      '<span class="big num">' + nf.format(amount) + '<span class="yen">円</span></span><small>' + sub + '</small></div>';
    const cl = md(r.closing);
    const short = box(r.shortfallTotal > 0 ? 'short' : 'zero', cl + 'までに不足', r.shortCount, r.shortfallTotal,
      r.shortCount ? r.shortCount + '口座・入金が必要' : '不足の口座はありません', 'short');
    const plus = box(r.surplusTotal > 0 ? 'plus' : 'zero', cl + 'までの引落後の余り', r.surplusCount, r.surplusTotal,
      r.surplusCount ? r.surplusCount + '口座' : '余りの口座はありません', 'plus');
    const showAll = serial2(r.endAll) > serial2(r.closing);
    const allLine = showAll ? '<div class="allline"><span>' + md(r.endAll) + 'まで見ると</span><span class="num">不足 <b>' + nf.format(r.shortTotalAll) + '円</b></span><span class="num">余り <b>' + nf.format(r.surplusTotalAll) + '円</b></span></div>' : '';
    const miss = r.balanceMissing > 0 ? '<div class="flag">残高未入力：' + r.balanceMissing + '口座（どちらの合計にも含みません）</div>' : '';
    const bulk = ''; // 「不足をまとめて解消する」ボタンは使わない
    const row = (b, mid, val, cls) => '<div class="surrow ' + cls + '"><span class="sn">' + esc(b.name) + '</span><span class="sc num">' + mid + '</span><span class="sv num">' + val + '<small>円</small></span></div>';
    let detail = '';
    {
      const list = r.banks.filter(b => b.balance != null && b.shortfall > 0).sort((a, b) => b.shortfall - a.shortfall);
      detail = '<div class="sbdetail short"><div class="sbd-h">' + cl + 'までに入金が必要な口座</div>' +
        (list.length ? '<div class="surlist">' + list.map(b => row(b, '残高 ' + nf.format(b.balance) + ' − 引落 ' + nf.format(b.due), nf.format(b.shortfall), 'neg')).join('') +
          '<div class="surrow total"><span class="sn">合計</span><span class="sc"></span><span class="sv num">' + nf.format(r.shortfallTotal) + '<small>円</small></span></div></div>'
          : '<p class="sub" style="margin:0">不足している口座はありません。</p>') + '</div>';
    }
    {
      const list = r.banks.filter(b => b.balance != null && !b.excluded && b.surplus > 0).sort((a, b) => b.surplus - a.surplus);
      const exc = r.banks.filter(b => b.balance != null && b.excluded && b.surplus > 0);
      detail += '<div class="sbdetail plus"><div class="sbd-h">' + cl + 'までの引落後に余る口座</div>' +
        (list.length ? '<div class="surlist">' + list.map(b => row(b, '残高 ' + nf.format(b.balance) + ' − 引落 ' + nf.format(b.due), nf.format(b.surplus), 'pos')).join('') +
          '<div class="surrow total"><span class="sn">合計</span><span class="sc"></span><span class="sv num">' + nf.format(r.surplusTotal) + '<small>円</small></span></div></div>'
          : '<p class="sub" style="margin:0">余りのある口座はありません。</p>') +
        (exc.length ? '<p class="sub" style="margin:6px 0 0">余りに含めない口座：' + exc.map(b => esc(b.name) + '（' + nf.format(b.surplus) + '円）').join('、') + '</p>' : '') + '</div>';
    }
    return '<div id="shortbox"><div class="tots">' + short + plus + '</div>' + detail + miss + '</div>';
  }

  function bindSurBrk() {
    const box = main.querySelector('#shortbox'); if (!box) return;
    box.querySelectorAll('[data-sb]').forEach(b => b.addEventListener('click', () => {
      const cur = box.querySelector('.tot.sel'); const curKey = cur ? cur.dataset.sb : null;
      meta.sbSel = curKey === b.dataset.sb ? 'none' : b.dataset.sb; saveMeta();
      box.outerHTML = shortboxHTML(C.compute(state, today())); bindSurBrk();
    }));
  }
  /* ---------- やさしいイラストのアイコン ---------- */
  const ICON = {
    cal: c => '<svg class="pico" viewBox="0 0 40 40" aria-hidden="true"><rect x="5" y="8" width="30" height="27" rx="6" fill="var(--surface)" stroke="var(' + c + ')" stroke-width="2.6"/><path d="M5 16h30" stroke="var(' + c + ')" stroke-width="2.6"/><path d="M13 5v6M27 5v6" stroke="var(--brown)" stroke-width="2.8" stroke-linecap="round"/><g fill="var(' + c + ')" opacity=".6"><rect x="10" y="20" width="5" height="4" rx="1"/><rect x="18" y="20" width="5" height="4" rx="1"/><rect x="26" y="20" width="5" height="4" rx="1"/><rect x="10" y="27" width="5" height="4" rx="1"/><rect x="18" y="27" width="5" height="4" rx="1"/></g></svg>',
    bank: c => '<svg viewBox="0 0 40 34" aria-hidden="true"><path d="M20 2 L37 11 H3 Z" fill="var(' + c + ')"/><rect x="4" y="11" width="32" height="3" fill="var(' + c + ')"/><g fill="var(' + c + ')"><rect x="7" y="16" width="4" height="11" rx="1"/><rect x="15" y="16" width="4" height="11" rx="1"/><rect x="21" y="16" width="4" height="11" rx="1"/><rect x="29" y="16" width="4" height="11" rx="1"/></g><rect x="3" y="28" width="34" height="4" rx="1.5" fill="var(' + c + ')"/></svg>',
    note: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="6" width="24" height="30" rx="4" fill="var(--surface)" stroke="var(--c-pink)" stroke-width="2.6"/><path d="M12 14h14M12 20h14M12 26h8" stroke="var(--c-pink)" stroke-width="2.4" stroke-linecap="round" opacity=".6"/><path d="M24 30 L35 17 L38 20 L27 33 L23 34 Z" fill="#F7C948" stroke="var(--brown)" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="6" y="6" width="28" height="28" rx="6" fill="var(--surface)" stroke="var(--c-blue)" stroke-width="2.6"/><path d="M12 14h16M12 20h16M12 26h10" stroke="var(--c-blue)" stroke-width="2.6" stroke-linecap="round"/></svg>',
    coins: '<svg viewBox="0 0 40 40" aria-hidden="true"><g stroke="#B7791F" stroke-width="1.8" fill="#F7C948"><ellipse cx="15" cy="30" rx="11" ry="4.5"/><path d="M4 26v4c0 2.5 5 4.5 11 4.5s11-2 11-4.5v-4"/><ellipse cx="15" cy="25" rx="11" ry="4.5"/><ellipse cx="26" cy="15" rx="11" ry="4.5"/><path d="M15 15v6M37 15v6c0 2.5-5 4.5-11 4.5"/><ellipse cx="26" cy="10" rx="11" ry="4.5"/></g></svg>',
    chart: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="6" y="22" width="7" height="12" rx="2" fill="var(--c-lav)" opacity=".55"/><rect x="16.5" y="15" width="7" height="19" rx="2" fill="var(--c-lav)" opacity=".75"/><rect x="27" y="7" width="7" height="27" rx="2" fill="var(--c-lav)"/></svg>'
  };
  const BANK_COLORS = ['--c-teal', '--c-blue', '--c-peach', '--c-pink', '--c-lav', '--c-yellow'];

  /** 口座ごとの必要金額（今後の引き落とし分） */
  function acctableHTML(r) {
    const act = r.banks.filter(b => b.active);
    if (!act.length) return '<div id="acctable"></div>';
    const rows = act.map((b, i) => '<button class="acrow" data-goto="' + esc(b.name) + '">' + ICON.bank(BANK_COLORS[i % BANK_COLORS.length]) +
      '<span class="nm">' + esc(b.name) + '</span>' +
      r.windows.map(w => '<span class="am' + (w.inClose ? '' : ' after') + (w.inClose && b.shortfall > 0 ? ' short' : '') + '">' + (w.label.replace('まで', '')) + 'まで<b class="num">' + (b.sums[w.key] ? '¥' + nf.format(b.sums[w.key]) : '—') + '</b></span>').join('') +
      (r.windows.length === 1 ? '<span></span>' : '') + '<span class="chev">›</span></button>').join('');
    return '<div id="acctable"><div class="acchead">' + ICON.bank('--c-teal') + '口座一覧<span class="sub">口座ごとの今後の引き落とし額</span></div><div class="acctable">' + rows + '</div></div>';
  }
  function quickHTML() {
    return '<div class="quick">' +
      '<button class="q-v" data-quick="variable">' + ICON.note + '<span class="t">変動費の入力</span><span class="chev">›</span></button>' +
      '<button class="q-f" data-quick="fixed">' + ICON.list + '<span class="t">固定費の確認</span><span class="chev">›</span></button>' +
      '<button class="q-i" data-quick="income">' + ICON.coins + '<span class="t">収入の管理</span><span class="chev">›</span></button>' +
      '<button class="q-c" data-quick="cycle">' + ICON.chart + '<span class="t">締め期間の収支</span><span class="chev">›</span></button></div>';
  }
  function bindQuick() {
    main.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
      const q = b.dataset.quick;
      if (q === 'variable' || q === 'fixed') { meta.page = q; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); }
      else if (q === 'income') { const el = $('#incomecard'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else { const el = $('#cycleSec'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }));
    main.querySelectorAll('[data-goto]:not(.surrow)').forEach(b => b.addEventListener('click', () => gotoBank(b.dataset.goto)));
    bindSurBrk();
    main.querySelectorAll('.period[data-tile]').forEach(b => b.addEventListener('click', e => { if (e.target.closest('button,a')) return; const el = $('#banksSec'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  }
  function bindXfer() {
    main.querySelectorAll('[data-act="xfer-to"], [data-act="xfer-from"]').forEach(b => {
      if (b._bound) return; b._bound = true;
      b.addEventListener('click', () => {
        if (accountCatalog().length < 2) { toast('口座が2つ以上必要です'); return; }
        if (b.dataset.act === 'xfer-from') openTransfer('', b.dataset.acc); else openTransfer(b.dataset.acc);
      });
    });
  }
  const openLines = new Set(); // 内訳を開いている口座（描き直しても開いたまま）
  function bindLines() {
    main.querySelectorAll('[data-act="lines"]').forEach(btn => btn.addEventListener('click', () => {
      const card = btn.closest('.bank'); const name = card.dataset.bank; const list = card.querySelector('.line-list');
      const open = list.hidden; list.hidden = !open;
      if (open) openLines.add(name); else openLines.delete(name);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.textContent = '内訳' + (open ? '▴' : '▾');
    }));
  }
  /** 口座の残高ページ：口座ごとの残高だけ */
  function balListHTML(r) {
    const list = r.banks; if (!list.length) return '';
    const hide = !!meta.hideTotal;
    return '<section class="ballist" aria-label="口座ごとの残高">' + list.map((b, i) => '<div class="balrow">' + ICON.bank(BANK_COLORS[i % BANK_COLORS.length]) +
      '<label class="bn" for="bl-' + esc(b.name) + '">' + esc(b.name) + (b.excluded ? '<small>余りに含めない</small>' : '') + '</label>' +
      (hide ? '<span class="bv num">¥ •••••</span>' : '<input class="amount' + (b.balance == null ? ' empty' : '') + '" id="bl-' + esc(b.name) + '" data-bal="' + esc(b.name) + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" placeholder="未入力" value="' + (b.balance == null ? '' : yenTxt(b.balance)) + '">') + '</div>').join('') +
      '</section><p class="sub" style="margin:0">' + (hide ? '残高を入れ直すときは「残高を表示」を押してください。' : '金額を押すと、その場で残高を入れ直せます。') + '</p>';
  }
  function bindBalList() {

    main.querySelectorAll('#ballist [data-bal]').forEach(el => {
      const name = el.dataset.bal; const b = state.balances[name] || (state.balances[name] = { amount: null, updatedAt: null });
      el.addEventListener('input', () => onAmountInput(el, () => b.amount, v => { b.amount = v; b.updatedAt = new Date().toISOString(); }));
      el.addEventListener('blur', () => { const v = parseAmount(el.value); if (!Number.isNaN(v)) el.value = yenTxt(v); });
    });
  }
  function gotoBank(name) {
    const card = main.querySelector('.bank[data-bank="' + CSS.escape(name) + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
  }

  function summaryHTML(r) {
    const per = r.windows.map((w, i) => '<div class="period' + (w.inClose ? '' : ' after') + '" data-tile><span class="lab">' + ICON.cal(w.inClose ? '--c-blue' : '--c-pink') + w.label + 'に必要' + (w.inClose ? '' : '<span class="tag">参考</span>') + (i === 0 ? '<button class="linkish" data-act="go-close" aria-label="期限を変更">変更</button>' : '') + '</span><span class="rng">' + md(w.from) + '〜' + md(w.to) + (w.nominal ? '<br>' + md(w.nominal) + 'が休日のため' + md(w.to) + 'まで' : '') + '</span><span class="val num" data-sum="' + w.key + '">' + yen(r.totals[w.key]) + '</span></div>').join('');
    const inc = r.income.map(i => '<div class="income-row"><span class="who">' + esc(i.name) + '</span><span class="when">' + (i.next ? '<span class="' + (isWeekend(i.next) ? 'wkend' : '') + '">' + mdw(i.next) + '</span> 予定' + shiftNote(i.next) : '') + '</span>' +
      '<input class="amount' + (i.amount == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="inc-' + esc(i.id) + '" data-inc="' + esc(i.id) + '" value="' + yenTxt(i.amount) + '" placeholder="金額（任意）" aria-label="' + esc(i.name) + 'の収入予定額"></div>').join('');
    if (!['sched', 'need', 'money', 'flow'].includes(meta.prepPanel)) meta.prepPanel = 'sched'; // トップは「引落予定」
    const P = (k, html) => '<div class="ppanel" data-panel="' + k + '"' + (meta.prepPanel === k ? '' : ' hidden') + '>' + html + '</div>';
    const pt = prepTopHTML(r);
    return '<div id="prepTop">' + pt.top + '</div>' +
      P('money', '<div class="pphead"><span>口座残高</span><button class="small xmove" data-act="xfer-any">残高移動</button><button class="pclose" data-panel-btn="money" aria-label="口座残高を閉じる">閉じる ✕</button></div>' + totalHTML(r) + '<div id="ballist">' + balListHTML(r) + '</div>') +
      P('need', '<section class="summary" id="sec-top" aria-label="過不足"><div class="acchead">' + QI.scale.replace('<svg ', '<svg class="pico" ') + '過不足<button class="pclose" data-panel-btn="need" aria-label="過不足を閉じる">閉じる ✕</button></div>' + shortboxHTML(r) + '</section>') +
      P('sched', '<div id="schedNotice">' + prepNoticeHTML(r) + '</div><div class="pphead"><span>引落予定</span></div><div id="schedBox">' + schedHTML() + '</div>') +
      P('flow', '<div class="pphead"><span>収支記録<small class="sub">（締め期間ごと）</small></span><button class="pclose" data-panel-btn="flow" aria-label="収支記録を閉じる">閉じる ✕</button></div><div id="flowBox">' + flowHTML() + '</div>') +
      '';
  }

  /* ---------- 準備ページ上のボタン（押すとその内容だけ開く） ---------- */
  /* ---------- 準備ページの上（次の引落まで・必要な入金額・4つのボタン・直近の引落予定） ---------- */
  const QI = {
    scale: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 7v32M14 41h20" stroke="var(--accent)" stroke-width="3.4" stroke-linecap="round"/><path d="M9 13h30" stroke="var(--accent)" stroke-width="3.4" stroke-linecap="round"/><circle cx="24" cy="9" r="3.2" fill="var(--accent)"/><path d="M9 14 3.5 27h11z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round"/><path d="M3.5 27a5.5 4 0 0 0 11 0" fill="var(--gold)"/><path d="M39 14l-5.5 13h11z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round"/><path d="M33.5 27a5.5 4 0 0 0 11 0" fill="var(--gold)"/></svg>',
    sched: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="10" width="34" height="30" rx="5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3.2"/><path d="M7 18h34" stroke="var(--accent)" stroke-width="3.2"/><path d="M16 6v8M32 6v8" stroke="var(--accent)" stroke-width="3.4" stroke-linecap="round"/><g fill="var(--gold)"><circle cx="16" cy="26" r="2.6"/><circle cx="24" cy="26" r="2.6"/><circle cx="16" cy="33" r="2.6"/><circle cx="24" cy="33" r="2.6"/></g><circle cx="32" cy="26" r="2.6" fill="var(--navy)"/></svg>',
    bank: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5 L43 15 V18 H5 V15 Z" fill="var(--gold)"/><rect x="9" y="21" width="6" height="14" rx="1.5" fill="var(--accent)"/><rect x="21" y="21" width="6" height="14" rx="1.5" fill="var(--accent)"/><rect x="33" y="21" width="6" height="14" rx="1.5" fill="var(--accent)"/><rect x="5" y="37" width="38" height="5" rx="2.5" fill="var(--accent)"/></svg>',
    chart: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="26" width="8" height="15" rx="2" fill="var(--accent)"/><rect x="20" y="17" width="8" height="24" rx="2" fill="var(--accent)"/><rect x="32" y="7" width="8" height="34" rx="2" fill="var(--gold)"/></svg>',
    manage: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="6" width="28" height="34" rx="4" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3.2"/><path d="M14 16h14M14 23h10" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round"/><circle cx="35" cy="34" r="9" fill="var(--gold)"/><path d="M31 34l3 3 5-6" stroke="#fff" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  const LI = {
    card: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><rect x="14" y="13" width="4" height="2.2" rx=".6" fill="var(--gold)" stroke="none"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2" stroke-linecap="round"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 17h6M10 20.5h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" fill="color-mix(in srgb, var(--gold) 35%, transparent)"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/></svg>',
    yen: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 7.5 12 12l3.5-4.5M12 12v5M9 12.5h6M9 15h6"/></svg>'
  };
  function lineIcon(name) {
    const n = String(name);
    if (/カード|card|ｶｰﾄﾞ|PAY|pay|ペイ/i.test(n)) return LI.card;
    if (/携帯|電話|au|docomo|ドコモ|softbank|ソフトバンク|楽天モバイル|LINEMO|ahamo|povo|UQ|ワイモバ|スマホ/i.test(n)) return LI.phone;
    if (/電気|ガス|水道|光熱|でんき/.test(n)) return LI.bulb;
    if (/家賃|住宅|ローン|管理費|マンション/.test(n)) return LI.home;
    return LI.yen;
  }
  function prepTopHTML(r) {
    const T = today(), t0 = serial2(T);
    const w0 = r.windows.filter(w => w.inClose).pop() || r.windows[0];
    const items = [];
    for (const b of r.banks) for (const w of r.windows) for (const l of b.lines[w.key]) if (l.amount !== 0 && serial2(l.date) >= t0) items.push({ date: l.date, name: l.name.replace(/（\d+月分は未入力）$/, ''), amount: l.amount, bank: b.name, short: b.shortfall > 0 });
    const seen = new Set();
    const list = items.sort((a, b) => serial2(a.date) - serial2(b.date)).filter(x => { const k = x.bank + x.name + serial2(x.date); if (seen.has(k)) return false; seen.add(k); return true; });
    const next = list[0];
    const days = next ? Math.round((new Date(next.date.y, next.date.m - 1, next.date.d) - new Date(T.y, T.m - 1, T.d)) / 864e5) : null;
    const missing = r.banks.filter(b => b.dueActive && b.balance == null).length;
    const st = r.shortfallTotal > 0 ? '<span class="pst bad">不足あり</span>' : missing ? '<span class="pst warn">未入力</span>' : r.dueCount ? '<span class="pst ok">準備OK</span>' : '';
    const hero = '<button class="herocard" data-panel-btn="need" aria-expanded="' + (meta.prepPanel === 'need') + '">' +
      '<span class="hc-l"><span class="hc-lab">次の引落まで</span><span class="hc-days num">' + (days == null ? '—' : days === 0 ? '今日' : days + '<small>日</small>') + '</span></span>' +
      '<span class="hc-r"><span class="hc-lab">' + (w0 ? esc(w0.label) + 'に必要な金額' : '必要な金額') + st + '</span><span class="hc-amt num">¥' + nf.format(w0 ? (r.totals[w0.key] || 0) : 0) + '</span></span>' +
      '<span class="hc-chev" aria-hidden="true">›</span></button>';
    const q = (k, ico, lab) => '<button class="qbtn' + (meta.prepPanel === k ? ' on' : '') + '" ' + (k === 'manage' ? 'data-act="go-variable"' : 'data-panel-btn="' + k + '" aria-expanded="' + (meta.prepPanel === k) + '"') + '>' + ico + '<span>' + lab + '</span></button>';
    const quick = '<div class="quick4">' + q('sched', QI.sched, '引落予定') + q('need', QI.scale, '過不足') + q('money', QI.bank, '口座残高') + q('flow', QI.chart, '収支記録') + '</div>';
    const rows = list.slice(0, 3).map(x => '<div class="nrow"><span class="ndate' + (x.short ? ' bad' : '') + '">' + md(x.date) + '</span><span class="nico">' + lineIcon(x.name) + '</span><span class="nname">' + esc(x.name) + '<small>' + esc(x.bank) + '</small></span><span class="namt num">' + (x.amount == null ? '<span class="flag">未入力</span>' : '¥' + nf.format(x.amount)) + '</span></div>').join('');
    const near = '<section class="nearlist" aria-label="直近の引落予定"><div class="nhead"><h2>直近の引落予定</h2><button class="more" data-act="go-banks">すべて見る ›</button></div>' +
      '<div class="ncard">' + (rows || '<p class="sub" style="margin:0;padding:14px">これからの引き落としはありません。</p>') + '</div></section>';
    return { top: hero + quick, near };
  }
  function prepNoticeHTML(r) {
    const w0 = r.windows.filter(w => w.inClose).pop() || r.windows[0];
    const missing = r.banks.filter(b => b.dueActive && b.balance == null).length;
    const by = w0 ? md(w0.to) : '';
    if (r.shortfallTotal > 0) {
      const sl = r.banks.filter(b => b.balance != null && b.shortfall > 0).sort((a, b) => b.shortfall - a.shortfall);
      return '<div class="pnotice warn"><span class="pn-i" aria-hidden="true">i</span><div class="pn-body"><span>' + by + 'までに、口座へ <b class="num">¥' + nf.format(r.shortfallTotal) + '</b> の入金が必要です</span>' +
        '<div class="pn-list">' + sl.map(b => '<button class="pn-row" data-panel-btn="money"><span>' + esc(b.name) + '</span><b class="num">¥' + nf.format(b.shortfall) + ' 不足</b><span class="pn-chev" aria-hidden="true">›</span></button>').join('') + '</div></div></div>';
    }
    if (missing) return '<button class="pnotice info" data-act="go-banks"><span class="pn-i" aria-hidden="true">i</span><span>残高を入れると、入金が必要か分かります（未入力 ' + missing + '口座）</span><span class="pn-chev" aria-hidden="true">›</span></button>';
    if (r.dueCount) return '<div class="pnotice ok"><span class="pn-i" aria-hidden="true">✓</span><span>' + by + 'までの引き落としに、残高は足りています</span></div>';
    return '';
  }
  function bindPrepTop() {
    main.querySelectorAll('[data-act="xfer-any"]').forEach(b => { if (b._x) return; b._x = 1; b.addEventListener('click', () => { if (accountCatalog().length < 2) { toast('口座が2つ以上必要です'); return; } openTransfer('', ''); }); });

    main.querySelectorAll('[data-act="go-variable"]').forEach(b => b.addEventListener('click', () => { meta.page = 'variable'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); }));
    main.querySelectorAll('[data-act="go-short"]').forEach(b => b.addEventListener('click', () => { const el = main.querySelector('.bank.is-short') || $('#banksSec'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  }
  function prepBtnsHTML(r) {
    const T = today(), t0 = serial2(T);
    const withBal = r.banks.filter(b => b.balance != null);
    const total = withBal.reduce((a, b) => a + b.balance, 0);
    const w0 = r.windows.filter(w => w.inClose).pop() || r.windows[0];
    const missing = r.banks.filter(b => b.dueActive && b.balance == null).length;
    const st = r.shortfallTotal > 0 ? '<span class="pst bad" title="不足 ' + nf.format(r.shortfallTotal) + '円">不足</span>'
      : missing ? '<span class="pst warn" title="残高未入力 ' + missing + '口座">未入力</span>'
      : r.dueCount ? '<span class="pst ok">✓ 足りる</span>' : '<span class="pst">引落なし</span>';
    const act = r.banks.filter(b => b.active).length;
    let nextUp = null;
    for (const b of r.banks) for (const w of r.windows) for (const l of b.lines[w.key]) if (l.amount !== 0 && serial2(l.date) >= t0 && (!nextUp || serial2(l.date) < serial2(nextUp))) nextUp = l.date;
    const nextInc = r.income.filter(i => i.next && serial2(i.next) >= t0).map(i => i.next).sort((a, b) => serial2(a) - serial2(b))[0];
    const btn = (k, ico, lab, val, cls, extra) => '<button class="pbtn' + (meta.prepPanel === k ? ' on' : '') + (cls ? ' ' + cls : '') + '" data-panel-btn="' + k + '" aria-expanded="' + (meta.prepPanel === k) + '">' + (extra ? '<span class="ptop">' + ico + extra + '</span>' : ico) + '<span class="pl">' + lab + '</span><span class="pv num">' + val + '</span></button>';
    return '<nav class="prepbtns" id="prepbtns" aria-label="準備ページの項目">' +
      btn('total', ICON.coins, '合計残高', meta.hideTotal ? '¥ •••••' : withBal.length ? '¥' + nf.format(total) : '未入力') +
      btn('need', ICON.cal('--c-blue'), w0 ? w0.label + 'に必要' : '必要額', w0 ? '¥' + nf.format(r.totals[w0.key] || 0) : '—', '', st) +
      btn('accts', ICON.bank('--c-blue'), '口座一覧', act + '口座') +
      btn('upcoming', ICON.list, '入出金予定', nextUp ? '次 ' + md(nextUp) : 'なし') +
      btn('income', ICON.note, '収入予定', nextInc ? '次 ' + md(nextInc) : '—') +
      btn('cycle', ICON.chart, '締め期間の収支', '収入・支出') +
      '</nav>';
  }
  /** 過不足を開いている間は、過不足だけのページにする（銀行別の入金準備などは隠す） */
  function syncPanelPage() { const onPrep = meta.page === 'prep'; document.body.classList.toggle('pp-need', onPrep && meta.prepPanel === 'need'); document.body.classList.toggle('pp-money', onPrep && meta.prepPanel === 'money'); document.body.classList.toggle('pp-flow', onPrep && meta.prepPanel === 'flow');  }
  function bindPanels() {
    main.querySelectorAll('[data-panel-btn]').forEach(b => { if (b._pb) return; b._pb = 1; b.addEventListener('click', () => {
      const k = b.dataset.panelBtn; const was = meta.prepPanel; meta.prepPanel = meta.prepPanel === k && k !== 'sched' ? 'sched' : k;
      if (meta.prepPanel === 'need' && was !== 'need') { delete meta.sbSel; const sbx = $('#shortbox'); if (sbx) { sbx.outerHTML = shortboxHTML(C.compute(state, today())); bindSurBrk(); } }
      saveMeta();
      if (was === 'money' || meta.prepPanel === 'money') { renderKeep(); window.scrollTo(0, 0); return; }
      main.querySelectorAll('.ppanel').forEach(p => { p.hidden = p.dataset.panel !== meta.prepPanel; });
      main.querySelectorAll('[data-panel-btn]').forEach(x => { const on = x.dataset.panelBtn === meta.prepPanel; x.classList.toggle('on', on); x.setAttribute('aria-expanded', on); });
      syncPanelPage();
      const op = main.querySelector('.ppanel:not([hidden])'); if (op) op.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }); });
  }

  /* ---------- 全口座の合計残高（隠すこともできる） ---------- */
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.8 17.8 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function totalInner(r) {
    const withBal = r.banks.filter(b => b.balance != null);
    const missing = r.banks.filter(b => b.active && b.balance == null).length;
    const total = withBal.reduce((a, b) => a + b.balance, 0);
    const hide = !!meta.hideTotal;
    return '<span class="tl-lab">全口座の合計残高<button class="eye" data-act="eye" aria-pressed="' + hide + '">' + (hide ? EYE_OFF + '残高を表示' : EYE + '残高を隠す') + '</button></span>' +
      '<span class="tl-val num' + (hide ? ' masked' : '') + '">' + (hide ? '¥ ••••••' : '¥' + nf.format(total)) + '</span>' +
      '<span class="tl-note">' + (withBal.length ? withBal.length + '口座の残高の合計' + (missing ? '（残高未入力の口座 ' + missing + '件）' : '') : '下の「銀行別の入金準備」で残高を入れると合計が出ます') + '</span>';
  }
  function totalHTML(r) {
    return '<section class="totalcard" id="totalbal" aria-label="全口座の合計残高">' + ICON.coins.replace('<svg ', '<svg class="coins" ') + '<div class="tl-body" data-total>' + totalInner(r) + '</div></section>';
  }
  function bindUpcoming() {
    main.querySelectorAll('[data-act="go-banks"]').forEach(b => { if (b._gb) return; b._gb = 1; b.addEventListener('click', () => { const el = $('#banksSec'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); });
  }
  function bindTotal() {
    const b = main.querySelector('[data-act="eye"]'); if (!b) return;
    b.addEventListener('click', () => { meta.hideTotal = !meta.hideTotal; saveMeta(); const t = main.querySelector('[data-total]'); const rr = C.compute(state, today()); t.innerHTML = totalInner(rr); bindTotal(); const bl = $('#ballist'); if (bl) { bl.innerHTML = balListHTML(rr); bindBalList(); } });
  }
  /* ---------- これからの入出金（直近の予定） ---------- */
  const ARROW = d => '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + (d === 'in' ? '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>' : '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>') + '</svg>';
  function upcomingHTML(r) {
    const T = today(), t0 = serial2(T); const items = [];
    for (const b of r.banks) for (const w of r.windows) for (const l of b.lines[w.key]) if (serial2(l.date) >= t0 && l.amount !== 0) items.push({ d: 'out', date: l.date, name: l.name.replace(/（\d+月分は未入力）$/, ''), amount: l.amount });
    for (const i of r.income) if (i.next && serial2(i.next) >= t0) items.push({ d: 'in', date: i.next, name: i.name, amount: i.amount });
    const seen = new Set();
    const list = items.sort((a, b) => serial2(a.date) - serial2(b.date)).filter(x => { const k = x.d + x.name + serial2(x.date); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
    if (!list.length) return '';
    return '<section class="upcoming" aria-label="これからの入出金"><div class="acchead"><span>' + ICON.list + 'これからの入出金</span><button class="more" data-act="go-banks">すべて見る ›</button></div>' +
      list.map(x => '<div class="uprow ' + x.d + '"><span class="ar">' + ARROW(x.d) + '</span><span class="kd">' + (x.d === 'in' ? '入金' : '引落') + '</span><span class="nm">' + esc(x.name) + '</span><span class="dt">' + md(x.date) + '</span><span class="am num">' + (x.amount == null ? '<span class="flag">未入力</span>' : (x.d === 'in' ? '+' : '−') + '¥' + nf.format(x.amount)) + '</span></div>').join('') + '</section>';
  }

  let cycleOffset = 0; // 0=今のサイクル（画面を開き直すと今に戻る）
  /* ---------- 締め期間ごとの収支（グラフ） ---------- */
  let flowSel = 0; // 0=今回の締め期間、-1=前回…
  const FLOW_FROM = -5, FLOW_TO = 1;
  /** 1つの締め期間の収支。過ぎた日は「記録」、今日以降は登録内容から */
  function flowData(off) {
    const T = today(), tIso = isoOf(T);
    const cy = C.cycle(state, T, off);
    const fIso = isoOf(cy.from), toIso = isoOf(cy.to);
    const items = []; let expense = 0, unentered = 0, recorded = false;
    for (const h of state.history || []) {
      if (h.date < fIso || h.date > toIso || h.date >= tIso) continue;
      recorded = true;
      if (h.amount == null) { unentered++; items.push({ name: h.name, account: h.account, date: h.date, amount: null, past: true }); continue; }
      expense += h.amount; items.push({ name: h.name, account: h.account, date: h.date, amount: h.amount, past: true });
    }
    if (toIso >= tIso) {
      const from = fIso > tIso ? cy.from : T;
      const hiddenAcc = new Set(state.hiddenAccounts || []);
      for (const k of ['variable', 'fixed', 'once']) for (const it of state[k] || []) {
        if (it.hidden || hiddenAcc.has(it.account) || !state.accounts.includes(it.account)) continue;
        for (const o of C.occurrencesIn(it, from, cy.to, false)) {
          const amt = C.amountFor(it, o); if (amt === 0) continue;
          if (amt == null) { unentered++; items.push({ name: it.name, account: it.account, date: isoOf(o), amount: null, past: false }); continue; }
          expense += amt; items.push({ name: it.name, account: it.account, date: isoOf(o), amount: amt, past: false });
        }
      }
    }
    const pastOnly = toIso < tIso;
    return { off, from: cy.from, to: cy.to, income: cy.income, incomeMissing: cy.incomeMissing, expense, unentered, items, diff: cy.income - expense, noRecord: pastOnly && !recorded };
  }
  function flowHTML() {
    const data = []; for (let o = FLOW_FROM; o <= FLOW_TO; o++) data.push(flowData(o));
    const max = Math.max(1, ...data.map(d => Math.max(d.income, d.expense)));
    const step = niceStep(max / 3), top = Math.ceil(max / step) * step;
    const W = 340, H = 190, L = 34, Rr = 6, T0 = 14, B = 34, ch = H - T0 - B, gw = (W - L - Rr) / data.length, bw = Math.min(14, gw / 2 - 4);
    const y = v => T0 + ch - (v / top) * ch;
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += '<line x1="' + L + '" x2="' + (W - Rr) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="fg-grid"/><text x="' + (L - 4) + '" y="' + (y(v) + 3.5) + '" class="fg-ax" text-anchor="end">' + (v === 0 ? '0' : (v / 10000) + '万') + '</text>';
    const bar = (x, v, cls) => { if (!v) return ''; const h = Math.max(2, (v / top) * ch), yy = T0 + ch - h, r = Math.min(4, bw / 2, h); return '<path class="' + cls + '" d="M' + x + ',' + (T0 + ch) + 'V' + (yy + r) + 'Q' + x + ',' + yy + ' ' + (x + r) + ',' + yy + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + yy + ' ' + (x + bw) + ',' + (yy + r) + 'V' + (T0 + ch) + 'Z"/>'; };
    data.forEach((d, i) => {
      const cx = L + gw * i + gw / 2, sel = d.off === flowSel;
      g += '<g class="fg-col' + (sel ? ' sel' : '') + '" data-flow="' + d.off + '" tabindex="0" role="button" aria-label="' + md(d.to) + '締め 収入' + nf.format(d.income) + '円 支出' + nf.format(d.expense) + '円">' +
        '<rect class="fg-hit" x="' + (L + gw * i + 1) + '" y="' + (T0 - 8) + '" width="' + (gw - 2) + '" height="' + (ch + 8 + B) + '" rx="8"/>' +
        bar(cx - bw - 1, d.income, 'fg-in') + bar(cx + 1, d.expense, 'fg-out' + (d.noRecord ? ' faint' : '')) +
        '<text x="' + cx + '" y="' + (H - B + 15) + '" class="fg-lab" text-anchor="middle">' + md(d.to) + '</text>' +
        '<text x="' + cx + '" y="' + (H - B + 28) + '" class="fg-sub" text-anchor="middle">' + (d.off === 0 ? '今回' : d.off === -1 ? '前回' : d.off === 1 ? '次回' : '') + '</text></g>';
    });
    const svg = '<svg class="flowchart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="締め期間ごとの収入と支出">' + g + '</svg>';
    const d = data.find(x => x.off === flowSel) || data[-FLOW_FROM];
    const neg = d.diff < 0;
    const byName = {}; for (const it of d.items) { if (it.amount == null) continue; const k = it.name; byName[k] = (byName[k] || 0) + it.amount; }
    const top5 = Object.entries(byName).sort((a, b) => b[1] - a[1]);
    const detail = '<div class="flowdet"><div class="fd-h"><b>' + md(d.from) + '〜' + md(d.to) + '</b><span class="sub">（' + md(d.to) + '締め）</span></div>' +
      '<div class="fd-grid"><div><span class="k"><i class="sw in"></i>収入</span><span class="v num">' + nf.format(d.income) + '<small>円</small></span>' + (d.incomeMissing ? '<span class="flag">金額未入力 ' + d.incomeMissing + '件</span>' : '') + '</div>' +
      '<div><span class="k"><i class="sw out"></i>支出</span><span class="v num">' + nf.format(d.expense) + '<small>円</small></span>' + (d.unentered ? '<span class="flag">金額未入力 ' + d.unentered + '件</span>' : '') + '</div>' +
      '<div class="' + (neg ? 'neg' : 'pos') + '"><span class="k">差し引き</span><span class="v num">' + (neg ? '−' : '＋') + nf.format(Math.abs(d.diff)) + '<small>円</small></span></div></div>' +
      (d.noRecord ? '<p class="sub" style="margin:0">この期間は記録がないため、支出は0円になっています（記録は使い始めた日から残ります）。</p>' : '') +
      (top5.length ? '<div class="fd-list">' + top5.map(([n, v]) => '<div class="fd-row"><span>' + esc(n) + '</span><span class="num">' + nf.format(v) + '円</span></div>').join('') + '</div>' : '') + '</div>';
    return '<section class="flowcard"><div class="fg-legend"><span><i class="sw in"></i>収入</span><span><i class="sw out"></i>支出</span><span class="sub">棒を押すと内訳</span></div>' + svg + detail +
      '<button class="small histlink" data-act="go-history">引落の記録を見る ›</button><p class="note" style="margin:0">過ぎた日の支出は「記録」、今日からあとは登録している金額で計算しています。収入は下のタブの「収入」の金額です。</p></section>';
  }
  /* ---------- 締め期間ごとの引落予定 ---------- */
  let schedOff = 0;
  function schedHTML() {
    const d = flowData(schedOff);
    const label = schedOff === 0 ? '今回' : schedOff === -1 ? '前回' : schedOff === 1 ? '次回' : schedOff > 0 ? schedOff + '回あと' : -schedOff + '回前';
    const tIso = isoOf(today());
    const list = d.items.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const rows = list.map(x => { const o = isoToObj(x.date); const done = x.date < tIso;
      return '<div class="srow2' + (done ? ' done' : '') + '"><span class="ndate">' + mdw(o) + '</span><span class="nico">' + lineIcon(x.name) + '</span><span class="nname">' + esc(x.name) + '<small>' + esc(x.account) + (done ? '・引落済み' : '') + '</small></span><span class="namt num">' + (x.amount == null ? '<span class="flag">未入力</span>' : '¥' + nf.format(x.amount)) + '</span></div>'; }).join('');
    return '<section class="schedcard"><div class="sc-nav"><button class="small" data-sched="-1" aria-label="前の締め期間">‹</button><div class="sc-t"><b>' + label + '（' + md(d.to) + '締め）</b><span class="sub">' + md(d.from) + '〜' + md(d.to) + '</span></div><button class="small" data-sched="1" aria-label="次の締め期間">›</button></div>' +
      (rows ? '<div class="sc-list">' + rows + '</div>' : '<p class="sub" style="margin:0;padding:8px 2px">この期間の引き落としはありません。</p>') +
      '<div class="sc-total"><span>合計 ' + list.length + '件</span><b class="num">¥' + nf.format(d.expense) + '</b></div>' +
      (d.unentered ? '<p class="flag" style="margin:0">金額未入力が ' + d.unentered + '件あります（合計に入っていません）</p>' : '') +
      (d.noRecord ? '<p class="sub" style="margin:0">この期間は記録がないため、引き落としを表示できません（記録は使い始めた日から残ります）。</p>' : '') +
      '<p class="note" style="margin:0">過ぎた日は「記録」、今日からあとは登録している内容から表示しています。</p></section>';
  }
  function bindSched() {
    main.querySelectorAll('[data-sched]').forEach(b => b.addEventListener('click', () => { schedOff += Number(b.dataset.sched); const sb = $('#schedBox'); if (sb) { sb.innerHTML = schedHTML(); bindSched(); } }));
  }
  function niceStep(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function bindBack() {
    main.querySelectorAll('[data-act="back-flow"]').forEach(b => b.addEventListener('click', () => { meta.page = 'prep'; meta.prepPanel = 'flow'; saveMeta(); renderAll(); window.scrollTo(0, 0); }));
  }
  function bindFlow() {
    main.querySelectorAll('[data-act="go-history"]').forEach(b => { if (b._gh) return; b._gh = 1; b.addEventListener('click', () => { meta.page = 'history'; meta.prepPanel = 'sched'; saveMeta(); renderAll(); window.scrollTo(0, 0); }); });
    main.querySelectorAll('[data-flow]').forEach(g => {
      const go = () => { flowSel = Number(g.dataset.flow); const fb = $('#flowBox'); if (fb) { fb.innerHTML = flowHTML(); bindFlow(); } };
      g.addEventListener('click', go); g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }
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
    // 不足している口座は「入れる」、それ以外は「出す」移動として開く（表示はどちらも「残高移動」）
    return b.shortfall > 0 ? '<button class="small primary xbtn" data-act="xfer-to" data-acc="' + esc(b.name) + '" title="ほかの口座からこの口座へ">残高移動</button>'
      : '<button class="small xbtn" data-act="xfer-from" data-acc="' + esc(b.name) + '" title="この口座からほかの口座へ">残高移動</button>';
  }
  function serial2(d) { return Date.UTC(d.y, d.m - 1, d.d); }
  function statusHTML(b, r) {
    // 省スペースのため短く表示（何日までの分かは title と上の合計に出す）
    const cl = r ? md(r.closing) + 'まで' : '';
    if (b.balance == null) return '<span class="pill none" data-status>未入力</span>';
    if (b.shortfall > 0) return '<span class="pill short num" data-status title="' + cl + 'に不足">不足 ' + nf.format(b.shortfall) + '円</span>';
    return '<span class="pill ' + (b.excluded ? 'none' : 'ok') + ' num" data-status title="' + cl + 'の余り">余り ' + nf.format(b.surplus) + '円' + (b.excluded ? '・合計外' : '') + '</span>';
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
    const cards = active.map(b => '<article class="bank' + (b.shortfall > 0 ? ' is-short' : '') + (b.balance == null ? ' nobal' : '') + '" data-bank="' + esc(b.name) + '">' +
      '<div class="bank-head"><span class="bank-name">' + esc(b.name) + '</span><span class="next">' + nextHTML(b) + '</span></div>' +
      '<div class="bank-row2"><div class="bank-amts">' + r.windows.map(w => '<div class="' + (w.inClose ? '' : 'after') + '"><span class="k">' + w.label + (w.inClose ? '' : '（参考）') + '</span><span class="v num" data-bsum="' + w.key + '">' + yen(b.sums[w.key]) + '</span></div>').join('') + '</div>' +
      '<button class="small linesbtn" data-act="lines" aria-expanded="' + (openLines.has(b.name) ? 'true' : 'false') + '">内訳' + (openLines.has(b.name) ? '▴' : '▾') + '</button>' + xferBtn(b) + '</div>' +
      (b.unentered ? '<div class="flag">金額未入力の引落が' + b.unentered + '件あります（0円として数えていません）</div>' : '') +
      '<div class="bank-foot"><label for="bal-' + esc(b.name) + '">残高</label><input class="amount' + (b.balance == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="bal-' + esc(b.name) + '" data-bal="' + esc(b.name) + '" value="' + yenTxt(b.balance) + '" placeholder="未入力">' + statusHTML(b, r) + '</div>' + afterHTML(b, r) +
      '<div class="line-list"' + (openLines.has(b.name) ? '' : ' hidden') + '>' + linesInner(b, r.windows) + '</div>' +
      '</article>').join('');
    const idleTxt = idle.length ? '<div class="idle-head">この期間に引落のない口座<span class="sub">残高を入れると余りに入ります</span></div>' + idle.map(b => '<article class="bank idlebank' + (b.balance == null ? ' nobal' : '') + '" data-bank="' + esc(b.name) + '">' +
      '<div class="bank-head"><span class="bank-name">' + esc(b.name) + '</span><span class="next">' + nextHTML(b) + '</span></div>' +
      '<div class="bank-foot"><label for="bal-' + esc(b.name) + '">残高</label><input class="amount' + (b.balance == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="bal-' + esc(b.name) + '" data-bal="' + esc(b.name) + '" value="' + yenTxt(b.balance) + '" placeholder="未入力">' + statusHTML(b, r) + '<button class="small" data-act="xfer-from" data-acc="' + esc(b.name) + '">残高移動</button></div>' + afterHTML(b, r) + '</article>').join('') : '';
    return '<section id="banksSec" aria-label="銀行別の入金準備表"><div class="section-head"><h2>銀行別の入金準備</h2><span class="head-right"><span class="sub">' + md(r.closing) + 'まで</span><button class="small" data-act="xfer-to" data-acc="">残高移動</button></span></div>' +
      '<div class="banks">' + (cards || '<div class="idle">この期間の引落はありません</div>') + '</div>' +
      '<p class="note">集計は確認日以降の引落だけです。土日・祝日・年末年始（12/31〜1/3）に当たる日は、項目ごとの設定（初期値は支出が後ろ、収入が前）でずらしています。締め日が休日の場合は、設定に合わせて締め日もずらします。</p></section>';
  }

  /** 何月分の引落か（変動費）。毎月同じ／先月〜3か月先 */
  function monthSelect(id, it) {
    const T = today(); let h = '<select id="' + id + '" data-f="month" aria-label="何月分の引落か">';
    const ms = [];
    for (let i = -1; i <= 3; i++) { const ym = C.addMonth(T.y, T.m, i); ms.push(ym.y + '-' + String(ym.m).padStart(2, '0')); }
    if (it.month && !ms.includes(it.month)) ms.unshift(it.month);
    for (const v of ms) {
      const [y, m] = v.split('-').map(Number);
      let when = '';
      if (it.day != null) { const dm = C.addMonth(y, m, it.nm || 0); const a = C.actual(it, dm.y, dm.m, false); when = '（' + a.m + '/' + a.d + '）'; }
      h += '<option value="' + v + '"' + (it.month === v ? ' selected' : '') + '>' + (y !== T.y ? y + '年' : '') + m + '月分' + when + '</option>';
    }
    return h + '</select>';
  }
  function daySelect(id, d, nm, allowNext) {
    let h = '<select id="' + id + '" aria-label="引落日">' + (allowNext ? '<optgroup label="その月">' : '');
    for (let i = 1; i <= 31; i++) h += '<option value="' + i + '"' + (!nm && d === i ? ' selected' : '') + '>' + i + '日</option>';
    h += '<option value="end"' + (!nm && d === 'end' ? ' selected' : '') + '>月末</option>';
    if (allowNext) {
      h += '</optgroup><optgroup label="翌月（例：11月分を12月に引落）">';
      for (let i = 1; i <= 31; i++) h += '<option value="n' + i + '"' + (nm && d === i ? ' selected' : '') + '>翌' + i + '日</option>';
      h += '<option value="nend"' + (nm && d === 'end' ? ' selected' : '') + '>翌月末</option></optgroup>';
    }
    return h + '</select>';
  }
  /** 引落日の選択値 → { day, nm }（"n10" = 翌10日） */
  function parseDay(v) { const nm = String(v).charAt(0) === 'n' ? 1 : 0; const r = nm ? String(v).slice(1) : String(v); return { day: r === 'end' ? 'end' : Number(r), nm }; }
  function setDay(it, v) { const p = parseDay(v); it.day = p.day; if (p.nm) it.nm = 1; else delete it.nm; }
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
        '<input class="amount' + (it.amount == null ? ' empty' : '') + '" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="amt-' + esc(it.id) + '" data-f="amount" value="' + yenTxt(it.amount) + '" placeholder="未入力" aria-label="' + esc(it.name) + 'の金額">' +
        (kind !== 'fixed' ? '<button type="button" class="calcbtn" data-act="calc" aria-label="' + esc(it.name) + 'を電卓で計算">' + CALC_ICON + '</button>' : '') + '</div>' +
        '<div class="row-sub">' + (kind === 'once' ? '<input class="text datein" type="date" id="date-' + esc(it.id) + '" data-f="date" value="' + esc(it.date) + '" aria-label="引落日">' : daySelect('day-' + esc(it.id), it.day, it.nm, true)) + (kind === 'variable' ? monthSelect('mon-' + esc(it.id), it) : '') + acctSelect('acc-' + esc(it.id), it.account) +
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

  const STABS = [['acc', '口座'], ['books', '帳簿'], ['backup', '保存'], ['notify', '通知'], ['view', '表示']];
  function settingsHTML() {
    const st = STABS.some(t => t[0] === meta.stab) ? meta.stab : 'acc';
    const seg = '<div class="seg" role="tablist">' + STABS.map(t => '<button role="tab" aria-selected="' + (t[0] === st) + '" class="' + (t[0] === st ? 'on' : '') + '" data-stab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
    let body = '';
    if (st === 'out') body = outHTML();
    else if (st === 'in') body = inHTML();
    else if (st === 'acc') body = accHTML();
    else if (st === 'books') body = booksHTML();
    else if (st === 'view') body = viewHTML();
    else if (st === 'notify') body = notifyHTML();
    else body = backupHTML();
    const cs = C.closeSettings(state);
    const dayOpts = sel => { let o = ''; for (let i = 1; i <= 28; i++) o += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>毎月' + i + '日</option>'; return o + '<option value="end"' + (sel === 'end' ? ' selected' : '') + '>毎月 月末</option>'; };
    const sh = (id, v) => shiftSelect(id, v, '休日のとき').replace(SHIFT_LABEL.after, '後ろ（翌営業日）').replace(SHIFT_LABEL.before, '前（前営業日）');
    const closeCard = '<div class="card form closecard" id="closecard"><div class="shead">いつまでに必要か（期限）<span class="sub">帳簿「' + esc(curBook() ? curBook().name : '') + '」の設定です。締め日までの引落で、不足と余りを判定します</span></div>' +
      '<div class="dl"><b>締め日</b><div class="two"><label>日付<select id="close-day">' + dayOpts(cs.d1.day) + '</select></label><label>休日のとき' + sh('close-shift', cs.d1.shift) + '</label></div></div>' +
      (cs.d2
        ? '<div class="dl"><div class="dlhead"><b>もう一つの期限（参考）</b><button class="small danger" data-act="close2-off">外す</button></div><span class="sub">準備ページに、この期限までの必要額も参考として並びます</span><div class="two"><label>日付<select id="close2-day">' + dayOpts(cs.d2.day) + '</select></label><label>休日のとき' + sh('close2-shift', cs.d2.shift) + '</label></div></div>'
        : '<div class="dl"><button class="small" data-act="close2-on">＋ もう一つの期限を追加</button><span class="sub">例：締め日が10日で、月末までの分も見ておきたいとき</span></div>') + '</div>';
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

  const INKIND = { monthly: '毎月', months: '年に数回', once: '1回だけ（臨時）' };
  const incKind = i => i.date ? 'once' : (Array.isArray(i.months) && i.months.length ? 'months' : 'monthly');
  function monthsPick(id, sel) {
    return '<div class="mpick" id="' + id + '" role="group" aria-label="入金がある月">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => '<button type="button" class="chip' + (sel.includes(m) ? ' on' : '') + '" data-m="' + m + '" aria-pressed="' + sel.includes(m) + '">' + m + '月</button>').join('') + '</div>';
  }
  function incWhen(i) {
    const k = incKind(i);
    if (k === 'once') { const o = isoToObj(i.date); return o.y + '/' + o.m + '/' + o.d; }
    if (k === 'months') return i.months.join('・') + '月の' + dayLabel(i.day);
    return '毎月' + dayLabel(i.day);
  }
  function inHTML() {
    const on = meta.reorder === 'income';
    if (on) return '<div class="card"><div class="pad">' + headHTML('収入', state.income.length + '件', 'income') + '</div>' + orderRows('income', state.income.map(i => ({ key: i.id, label: i.name, sub: incWhen(i) + (i.hidden ? '・非表示' : '') }))) + '</div>';
    const row = i => { const k = incKind(i);
      return '<div class="irow' + (i.hidden ? ' is-hidden' : '') + (i.amount == null ? ' noamt' : '') + '" data-inc-id="' + esc(i.id) + '">' +
        '<div class="irow-head"><span class="ih-kind">' + INKIND[k] + '・' + esc(incWhen(i)) + '</span>' + (i.amount == null ? '<span class="pst warn">金額未入力</span>' : '') + '</div>' +
        '<div class="irow-top"><input class="text" id="incname-' + esc(i.id) + '" value="' + esc(i.name) + '" aria-label="収入の名前">' +
        '<input class="amount" inputmode="numeric" enterkeyhint="done" autocomplete="off" id="incamt-' + esc(i.id) + '" data-inc="' + esc(i.id) + '" value="' + yenTxt(i.amount) + '" placeholder="金額" aria-label="' + esc(i.name) + 'の金額"></div>' +
        (k === 'once' ? '<div class="irow-bot"><label class="inl">入金日<input type="date" class="text" id="incdate-' + esc(i.id) + '" value="' + esc(i.date) + '"></label></div>'
          : (k === 'months' ? monthsPick('incmon-' + esc(i.id), i.months) : '') + '<div class="irow-bot">' + daySelect('incday-' + esc(i.id), i.day) + '</div>') +
        '<div class="irow-bot">' + shiftSelect('incshift-' + esc(i.id), i.shift || 'before', '入金日が休日のとき') + '</div>' +
        '<div class="irow-bot irow-act"><span class="grow"></span>' + hideBtn(!!i.hidden, 'inchide') + '<button class="danger small" data-act="incdel" aria-label="「' + esc(i.name) + '」を削除">「' + esc(i.name.length > 8 ? i.name.slice(0, 8) + '…' : i.name) + '」を削除</button></div></div>'; };
    const groups = ['monthly', 'months', 'once'].map(k => { const l = state.income.filter(i => incKind(i) === k); return l.length ? '<div class="igroup"><div class="ig-h">' + INKIND[k] + '<span class="sub">' + l.length + '件</span></div>' + l.map(row).join('') + '</div>' : ''; }).join('');
    const nk = ['monthly', 'months', 'once'].includes(meta.incNewKind) ? meta.incNewKind : 'monthly';
    const T = today();
    return '<div class="card"><div class="pad">' + headHTML('登録している収入', state.income.length + '件', 'income') + '</div>' + (groups || '<p class="sub" style="padding:0 16px">収入はまだありません。</p>') +
      '<div class="form addform"><div class="shead">収入を追加</div>' +
      '<div class="seg inkind" role="tablist">' + ['monthly', 'months', 'once'].map(k => '<button role="tab" data-inkind="' + k + '" class="' + (k === nk ? 'on' : '') + '" aria-selected="' + (k === nk) + '">' + INKIND[k] + '</button>').join('') + '</div>' +
      '<label>名前<input class="text" id="inc-new-name" autocomplete="off" placeholder="' + (nk === 'monthly' ? '例：給料' : nk === 'months' ? '例：ボーナス' : '例：お祝い・還付金') + '"></label>' +
      (nk === 'once' ? '<label>入金日<input type="date" class="text" id="inc-new-date" value="' + isoOf(T) + '"></label>'
        : (nk === 'months' ? '<div class="flabel">入金がある月（複数選べます）</div>' + monthsPick('inc-new-months', [6, 12]) : '') + '<label>入金日' + daySelect('inc-new-day', nk === 'months' ? 10 : 25) + '</label>') +
      '<div class="two"><label>金額（任意）<input class="amount wide" id="inc-new-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" placeholder="未入力"></label><label>休日のとき' + shiftSelect('inc-new-shift', 'before') + '</label></div>' +
      '<button class="primary" data-act="incadd">収入に追加</button></div></div>';
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
    const autoSw = '<div class="card form autodeduct"><label class="switchrow"><span><b>引落日が過ぎたら残高から引く</b><small>引落日の翌日にアプリを開くと、その日の引き落とし額を口座の残高から自動で引きます（引落日以降に残高を入れ直した口座は引きません）</small></span><input type="checkbox" id="autoDeduct" role="switch"' + (state.autoDeduct !== false ? ' checked' : '') + '></label></div>';
    return autoSw + '<div class="card">' + '<div class="pad">' + headHTML('口座', state.accounts.length + '口座', 'accounts') +
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

  /** 表示モード（ライト・ダーク・自動） */
  const COLORS = [['blue', 'ブルー'], ['pink', 'ピンク'], ['green', 'グリーン'], ['purple', 'パープル'], ['orange', 'オレンジ']];
  const icon = { supported: false, name: 'blue' };
  async function refreshIcon() {
    if (!(N.isNative && N.iconGet)) return;
    const r = await N.iconGet(); icon.supported = !!r.supported; icon.name = r.name || 'blue';
    syncIcon();
    if (meta.page === 'settings' && meta.stab === 'view') renderKeep();
  }
  /** ホーム画面のアイコンをアプリの色にそろえる（アプリ版・プレミアム） */
  async function syncIcon() {
    if (!(N.isNative && N.iconSet && icon.supported) || meta.iconSync === false) return;
    const want = proActive() ? colorOf() : 'blue';
    if (want === icon.name) return;
    if (await N.iconSet(want)) icon.name = want;
  }
  function colorOf() { return COLORS.some(c => c[0] === meta.color) ? meta.color : 'blue'; }
  function colorHTML() {
    const can = proActive(); const cur = can ? colorOf() : 'blue';
    return '<div class="card form colorcard"><div class="shead">アプリの色<span class="sub">全部の帳簿で共通の設定です</span></div>' +
      proHTML('アプリの色の変更') +
      '<div class="colorpick" role="radiogroup" aria-label="アプリの色">' + COLORS.map(c => '<button role="radio" aria-checked="' + (c[0] === cur) + '" class="cpick c-' + c[0] + (c[0] === cur ? ' on' : '') + '" data-color="' + c[0] + '"' + (can || c[0] === 'blue' ? '' : ' disabled') + '><img src="icon-' + c[0] + '-180.png" alt="" width="48" height="48"><b>' + c[1] + '</b></button>').join('') + '</div>' +
      (N.isNative && icon.supported ? '<label class="switchrow"><span><b>ホーム画面のアイコンも同じ色にする</b><small>色を変えると、iPhoneが「アイコンを変更しました」と表示します</small></span><input type="checkbox" id="iconSync" role="switch"' + (meta.iconSync !== false ? ' checked' : '') + (can ? '' : ' disabled') + '></label>'
        : N.isNative ? '' : (can ? '<div class="iconhow"><b>ホーム画面のアイコンも同じ色にするには</b><ol><li>念のため「設定 → 保存」でバックアップを保存する</li><li>この画面を<b>Safari</b>で開いて、同じ色を選ぶ</li><li>共有ボタン →「ホーム画面に追加」</li><li>前のアイコンはホーム画面から削除（「アプリを削除」は選ばない）</li></ol><small>Webアプリ版は、ホーム画面に追加したときのアイコンのまま変わらないため、追加し直す必要があります。</small></div>' : '<p class="sub" style="margin:0">アプリ版では、ホーム画面のアイコンも同じ色に変わります。</p>')) + '</div>';
  }
  function viewHTML() {
    const t = themeOf();
    const desc = { light: '明るい表示（標準）', dark: '暗い表示。夜や暗い場所で見やすい', auto: 'iPhoneの設定（ライト／ダーク）に合わせて切り替え' };
    return '<div class="card form"><div class="shead">表示モード<span class="sub">全部の帳簿で共通の設定です</span></div>' +
      '<div class="modepick" role="radiogroup" aria-label="表示モード">' + THEMES.map(x => '<button role="radio" aria-checked="' + (x[0] === t) + '" class="mode m-' + x[0] + (x[0] === t ? ' on' : '') + '" data-mode="' + x[0] + '"><span class="sw"></span><b>' + { light: 'ライトモード', dark: 'ダークモード', auto: '自動' }[x[0]] + '</b><small>' + desc[x[0]] + '</small></button>').join('') + '</div></div>' + colorHTML();
  }

  /* ---------- 引落前のお知らせ（iPhoneアプリ版の通知。端末の中だけで予約し、外部には送らない） ---------- */
  const NDAYS = [[0, '当日'], [1, '前日'], [2, '2日前'], [3, '3日前'], [7, '1週間前']];
  function notifyCfg() {
    const n = meta.notify || {};
    return { on: !!n.on, days: Array.isArray(n.days) && n.days.length ? n.days : [1], hour: Number.isInteger(n.hour) ? n.hour : 8, amount: !!n.amount };
  }
  /** プレミアム（買い切り）。購入の状態はiPhoneのApp Store（StoreKit）にだけ問い合わせる */
  const pro = { owned: false, checked: false, available: false, price: '', busy: false };
  function proHTML(what) {
    if (!N.isNative && proActive()) return what === '引落前のお知らせ' ? '' : '<p class="proline ok">✓ プレミアムをご利用中です（Webアプリ版）。</p>';
    if (!(N.isNative && N.proStatus)) return '<p class="note"><span class="probadge">プレミアム</span> ' + esc(what) + 'は、<b>iPhoneアプリ版（App Store）のプレミアム</b>で使えます。' + (what === '引落前のお知らせ' ? '' : '<button class="linkbtn" data-act="owner-code">コードをお持ちの方</button>') + '</p>';
    if (pro.owned) return '<p class="proline ok">✓ プレミアムをご利用中です。ありがとうございます。</p>';
    return '<div class="procard"><div class="protitle"><span class="probadge">プレミアム</span>' + esc(what) + 'はプレミアムの機能です</div>' +
      '<p class="sub">一度購入すれば、ずっと使えます（買い切り・月額料金なし）。プレミアムでは「引落前のお知らせ」と「アプリの色」が使えます。同じApple IDなら機種変更しても使えます。</p>' +
      '<div class="btnrow"><button class="primary" data-act="pro-buy"' + (pro.busy || (pro.checked && !pro.available) ? ' disabled' : '') + '>' + (pro.busy ? '処理中…' : pro.price ? pro.price + 'で購入する' : pro.checked ? '現在購入できません' : '確認中…') + '</button>' +
      '<button data-act="pro-restore"' + (pro.busy ? ' disabled' : '') + '>購入を復元</button></div></div>';
  }
  /** 起動直後に色がちらつかないよう、確認できた購入状態を覚えておく（確認のたびに上書き） */
  function cachePro() { meta.proSeen = !!pro.owned; saveMeta(); }
  function proActive() {
    if (window.__NAVI_PREVIEW__ === true) return true; // 確認版だけはプレミアムの見た目を試せる
    if (!N.isNative && UNLOCK_HASHES.includes(meta.ownerUnlock)) return true; // Webアプリ版：持ち主のコードで使える（アプリ版はApp Storeの購入だけ）
    return pro.checked ? pro.owned : !!(N.isNative && meta.proSeen);
  }
  const FRIEND_HASH = 'fd6d5b742c8b859655ff74d1255bb4da09c1c000a29eee9171390bc571b94428'; // 知り合い用（消すと、このコードで開放した人はブルーに戻る）
  const OWNER_HASH = '129f4958b98e9c1516e4ac62c01dc1e60b036c3a286dd02fb3b9230e919f671a';
  const UNLOCK_HASHES = [OWNER_HASH, FRIEND_HASH];
  async function checkOwnerCode(code) {
    try {
      const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hikiotoshi-navi:' + norm));
      const hx = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      return UNLOCK_HASHES.includes(hx) ? hx : false;
    } catch (e) { return false; }
  }
  function openOwnerCode() {
    const m = $('#modal');
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">プレミアムのコード</h2><p class="sub">お持ちのコードを入れると、このiPhoneのWebアプリ版でプレミアムの見た目（アプリの色）が使えます。</p>' +
      '<input class="text" id="ocIn" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" aria-label="コード">' +
      '<div class="btnrow"><button id="mCancel">やめる</button><button id="mOk" class="primary">使う</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close; m.onclick = e => { if (e.target === m) close(); };
    $('#mOk').onclick = async () => {
      const hx = await checkOwnerCode($('#ocIn').value);
      if (hx) { meta.ownerUnlock = hx; saveMeta(); close(); applyTheme(); renderKeep(); toast('プレミアムが使えるようになりました'); }
      else toast('コードが違います');
    };
    setTimeout(() => { const i = $('#ocIn'); if (i) i.focus(); }, 50);
  }
  async function refreshPro() {
    if (!(N.isNative && N.proStatus)) return;
    const r = await N.proStatus();
    pro.owned = !!r.owned; pro.available = !!r.available; pro.price = r.price || ''; pro.checked = true;
    cachePro(); applyTheme(); syncIcon();
    if (meta.page === 'settings' && (meta.stab === 'notify' || meta.stab === 'view')) renderKeep();
    applyNotify();
  }
  function notifyHTML() {
    const c = notifyCfg(); const can = !!(N.isNative && N.notifySchedule) && pro.owned;
    const hours = []; for (let h = 5; h <= 22; h++) hours.push(h);
    return '<div class="card form notifycard"><div class="shead">引落前のお知らせ<span class="sub">全部の帳簿の引き落としが対象です</span></div>' +
      proHTML('引落前のお知らせ') + (N.isNative ? '' : '<p class="sub" style="margin:0">Webアプリ版では、外部のサーバーを使わずに通知を出すことができないため、通知は届きません。</p>') +
      '<label class="switchrow"><span><b>お知らせする</b><small>引落日が近づくと、iPhoneの通知でお知らせします</small></span><input type="checkbox" id="nfOn" role="switch"' + (c.on && can ? ' checked' : '') + (can ? '' : ' disabled') + '></label>' +
      '<div class="nfopts"' + (c.on && can ? '' : ' aria-disabled="true"') + '>' +
      '<div class="flabel">いつお知らせするか（複数選べます）</div><div class="chips" role="group" aria-label="お知らせする日">' +
      NDAYS.map(d => '<button class="chip' + (c.days.includes(d[0]) ? ' on' : '') + '" data-nday="' + d[0] + '" aria-pressed="' + c.days.includes(d[0]) + '">' + d[1] + '</button>').join('') + '</div>' +
      '<label class="flabel" for="nfHour">時刻</label><select id="nfHour">' + hours.map(h => '<option value="' + h + '"' + (h === c.hour ? ' selected' : '') + '>' + h + ':00</option>').join('') + '</select>' +
      '<label class="switchrow"><span><b>金額も表示する</b><small>オフにすると、ロック画面に金額を出しません</small></span><input type="checkbox" id="nfAmt" role="switch"' + (c.amount ? ' checked' : '') + '></label>' +
      '<div class="nfprev"><div class="flabel">お知らせの例</div><div class="nfbubble"><b>明日は引き落とし日です</b><span>' + esc(notifySample(c)) + '</span></div></div>' +
      (can ? '<p class="sub" id="nfStatus">' + esc(notifyStatus) + '</p>' : '') +
      '</div></div>';
  }
  function notifySample(c) {
    const list = notifyList(Object.assign({}, c, { days: [1] }), 1);
    if (list.length) return list[0].body;
    return 'T-NEOメイン：カード代ほか1件' + (c.amount ? '　合計 52,000円' : '');
  }
  let notifyStatus = '';
  /** 予約する通知の一覧を作る（最大 limit 件・今から40日先まで） */
  function notifyList(c, limit) {
    const T = today(), to = C.addDays(T, 40);
    const now = new Date(), multi = books.list.length > 1;
    const groups = new Map();
    for (const bk of books.list) {
      const data = bk.id === books.current ? state : readBook(bk.id); if (!data) continue;
      const hiddenAcc = new Set(data.hiddenAccounts || []); const accs = data.accounts || [];
      for (const kind of ['variable', 'fixed', 'once']) for (const it of data[kind] || []) {
        if (it.hidden || hiddenAcc.has(it.account) || !accs.includes(it.account)) continue;
        for (const o of C.occurrencesIn(it, T, to)) {
          const amt = C.amountFor(it, o); if (amt === 0) continue;
          const key = bk.id + '|' + it.account + '|' + C.serial(o);
          if (!groups.has(key)) groups.set(key, { book: bk.name, account: it.account, date: o, names: [], total: 0, missing: 0 });
          const g = groups.get(key); g.names.push(it.name); if (amt == null) g.missing++; else g.total += amt;
        }
      }
    }
    const out = [];
    for (const g of groups.values()) for (const d of c.days) {
      const day = C.addDays(g.date, -d);
      const at = new Date(day.y, day.m - 1, day.d, c.hour, 0, 0);
      if (at <= now) continue;
      const title = d === 0 ? '今日は引き落とし日です' : d === 1 ? '明日は引き落とし日です' : d + '日後（' + g.date.m + '/' + g.date.d + '）に引き落としがあります';
      const names = g.names.length > 2 ? g.names.slice(0, 2).join('・') + 'ほか' + (g.names.length - 2) + '件' : g.names.join('・');
      const body = (multi ? '【' + g.book + '】' : '') + g.account + '：' + names + (c.amount ? (g.missing && !g.total ? '　金額未入力' : '　合計 ' + nf.format(g.total) + '円' + (g.missing ? '（金額未入力あり）' : '')) : '');
      out.push({ at: at.getTime(), title, body });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, limit);
  }
  function queueNotify() { if (!(N.isNative && N.notifySchedule)) return; clearTimeout(queueNotify._h); queueNotify._h = setTimeout(applyNotify, 1500); }
  async function applyNotify(ask) {
    if (!(N.isNative && N.notifySchedule) || !books) return;
    const c = notifyCfg();
    try {
      if (!pro.checked) return; // 購入の確認が済むまで何もしない
      if (!c.on || !pro.owned) { await N.notifySchedule([]); notifyStatus = ''; return; }
      const perm = await N.notifyPermission(!!ask);
      if (perm !== 'granted') {
        notifyStatus = '通知が許可されていません。iPhoneの「設定」→「通知」→「引落ナビ」で許可してください。';
      } else {
        const list = notifyList(c, 60);
        await N.notifySchedule(list);
        notifyStatus = list.length ? '次のお知らせ：' + new Date(list[0].at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '（予約 ' + list.length + '件）' : '40日先までにお知らせする引き落としはありません';
      }
    } catch (e) { notifyStatus = 'お知らせを予約できませんでした'; }
    const el = $('#nfStatus'); if (el) el.textContent = notifyStatus;
  }
  function bindNotify() {
    const buy = main.querySelector('[data-act="pro-buy"]');
    if (buy) buy.addEventListener('click', async () => {
      pro.busy = true; renderKeep();
      const r = await N.proPurchase(); pro.busy = false;
      if (r.owned) { pro.owned = true; toast('プレミアムを購入しました。ありがとうございます'); }
      else if (r.reason === 'pending') toast('購入の承認待ちです（ファミリー共有の承認など）');
      else if (r.reason === 'notfound') toast('現在購入できません。時間をおいてお試しください');
      else if (r.reason && r.reason !== 'cancelled') toast('購入できませんでした');
      cachePro(); applyTheme(); renderKeep(); applyNotify(true);
    });
    const rs = main.querySelector('[data-act="pro-restore"]');
    if (rs) rs.addEventListener('click', async () => {
      pro.busy = true; renderKeep();
      const r = await N.proRestore(); pro.busy = false; pro.owned = !!r.owned;
      toast(r.owned ? '購入を復元しました' : 'このApple IDでの購入は見つかりませんでした');
      cachePro(); applyTheme(); renderKeep(); applyNotify();
    });
    const on = $('#nfOn'); if (!on) return;
    const set = (patch, ask) => { meta.notify = Object.assign(notifyCfg(), patch); saveMeta(); renderKeep(); applyNotify(ask); };
    on.addEventListener('change', () => { set({ on: on.checked }, on.checked); toast(on.checked ? '引落前にお知らせします' : 'お知らせを止めました'); });
    main.querySelectorAll('[data-nday]').forEach(b => b.addEventListener('click', () => {
      const d = Number(b.dataset.nday); let days = notifyCfg().days.slice();
      days = days.includes(d) ? days.filter(x => x !== d) : days.concat(d).sort((a, c) => a - c);
      if (!days.length) { toast('少なくとも1つ選んでください'); return; }
      set({ days });
    }));
    $('#nfHour').addEventListener('change', e => set({ hour: Number(e.target.value) }));
    $('#nfAmt').addEventListener('change', e => set({ amount: e.target.checked }));
  }

  function bindSettings() {
    bindNotify();
    const ad = $('#autoDeduct'); if (ad) ad.addEventListener('change', () => { state.autoDeduct = ad.checked; if (ad.checked) { /* 入れ直したときは、その日以降の引落から */ const t = isoOf(today()); for (const h of state.history || []) if (h.date < t) h.deductChecked = true; } save(); toast(ad.checked ? '引落日が過ぎたら残高から引きます' : '残高から自動で引くのをやめました'); });
    const oc = main.querySelector('[data-act="owner-code"]'); if (oc) oc.addEventListener('click', openOwnerCode);
    const isw = $('#iconSync');
    if (isw) isw.addEventListener('change', () => { meta.iconSync = isw.checked; saveMeta(); if (isw.checked) syncIcon(); else if (icon.name !== 'blue') N.iconSet('blue').then(ok => { if (ok) icon.name = 'blue'; }); });
    main.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
      if (!proActive()) return;
      meta.color = b.dataset.color; saveMeta(); applyTheme(); renderKeep(); syncIcon();
      toast('アプリの色を「' + COLORS.find(c => c[0] === meta.color)[1] + '」にしました');
    }));
    main.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      meta.theme = b.dataset.mode; saveMeta(); applyTheme(); renderKeep();
      toast({ light: 'ライトモードにしました', dark: 'ダークモードにしました', auto: 'iPhoneの設定に合わせます' }[meta.theme]);
    }));
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
      const cur = () => C.closeSettings(state);
      const setS = (patch) => { const c0 = cur(); state.settings = Object.assign({ closeDay: c0.d1.day, closeShift: c0.d1.shift, close2On: !!c0.d2, close2Day: c0.d2saved.day, close2Shift: c0.d2saved.shift }, patch); save(); renderKeep(); };
      const upd = () => {
        const p = { closeDay: dv(cd.value), closeShift: validShift($('#close-shift').value, 'after') };
        if ($('#close2-day')) { p.close2Day = dv($('#close2-day').value); p.close2Shift = validShift($('#close2-shift').value, 'none'); }
        setS(p);
        toast('締め日：' + lab(state.settings.closeDay) + (state.settings.close2On ? '／もう一つの期限：' + lab(state.settings.close2Day) : ''));
      };
      ['#close-day', '#close-shift', '#close2-day', '#close2-shift'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', upd); });
      const on = main.querySelector('[data-act="close2-on"]'); if (on) on.addEventListener('click', () => { setS({ close2On: true }); toast('もう一つの期限を追加しました（' + lab(state.settings.close2Day) + '）'); });
      const off = main.querySelector('[data-act="close2-off"]'); if (off) off.addEventListener('click', () => { setS({ close2On: false }); toast('もう一つの期限を外しました'); });
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
      const dsel = row.querySelector('select[id^="incday-"]'); if (dsel) dsel.addEventListener('change', e => { inc.day = e.target.value === 'end' ? 'end' : Number(e.target.value); save(); renderKeep(); });
      const dt = row.querySelector('input[id^="incdate-"]'); if (dt) dt.addEventListener('change', e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { inc.date = e.target.value; save(); renderKeep(); } });
      row.querySelectorAll('.mpick [data-m]').forEach(b => b.addEventListener('click', () => { const m = Number(b.dataset.m); let ms = (inc.months || []).slice(); ms = ms.includes(m) ? ms.filter(x => x !== m) : ms.concat(m).sort((a, c) => a - c); if (!ms.length) { toast('少なくとも1つの月を選んでください'); return; } inc.months = ms; save(); renderKeep(); }));
      row.querySelector('select[id^="incshift-"]').addEventListener('change', e => { inc.shift = validShift(e.target.value, 'before'); save(); renderKeep(); toast('「' + inc.name + '」：' + SHIFT_LABEL[inc.shift]); });
      row.querySelector('[data-act="inchide"]').addEventListener('click', () => { inc.hidden = !inc.hidden; save(); renderKeep(); toast(inc.hidden ? '「' + inc.name + '」を非表示にしました' : '「' + inc.name + '」を表示しました'); });
      row.querySelector('[data-act="incdel"]').addEventListener('click', () => confirmSheet('収入「' + inc.name + '」を削除しますか？', '', '削除する', () => {
        state.income = state.income.filter(x => x.id !== inc.id); save(); renderKeep(); toast('削除しました');
      }, true));
    });
    main.querySelectorAll('[data-inkind]').forEach(b => b.addEventListener('click', () => { meta.incNewKind = b.dataset.inkind; saveMeta(); renderKeep(); }));
    main.querySelectorAll('#inc-new-months [data-m]').forEach(b => b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }));
    const incadd = main.querySelector('[data-act="incadd"]');
    if (incadd) {
      const amt = $('#inc-new-amt');
      amt.addEventListener('blur', () => { const v = parseAmount(amt.value); if (!Number.isNaN(v)) amt.value = yenTxt(v); });
      incadd.addEventListener('click', () => {
        const n = $('#inc-new-name').value.trim(); const v = parseAmount(amt.value);
        if (!n) { toast('収入の名前を入力してください'); return; }
        if (Number.isNaN(v)) { toast('金額は数字で入力してください'); return; }
        const nk = ['monthly', 'months', 'once'].includes(meta.incNewKind) ? meta.incNewKind : 'monthly';
        const it = { id: uid('i'), name: n, day: 25, amount: v, hidden: false, shift: validShift($('#inc-new-shift').value, 'before') };
        if (nk === 'once') { const dt = $('#inc-new-date').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('入金日を選んでください'); return; } it.date = dt; it.day = Number(dt.slice(8)); }
        else { const dv = $('#inc-new-day').value; it.day = dv === 'end' ? 'end' : Number(dv); }
        if (nk === 'months') { const ms = [...main.querySelectorAll('#inc-new-months .chip.on')].map(b => Number(b.dataset.m)); if (!ms.length) { toast('入金がある月を選んでください'); return; } it.months = ms; }
        state.income.push(it);
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
      const cb = row.querySelector('[data-act="calc"]');
      if (cb) cb.addEventListener('click', () => openCalc(amt, it.name));
      const ms = row.querySelector('[data-f="month"]');
      if (ms) ms.addEventListener('change', e => { if (!e.target.value) return; it.month = e.target.value; touch(it, row); save(); renderKeep(); toast('「' + it.name + '」：' + Number(it.month.split('-')[1]) + '月分の金額にしました'); });
      const ds = row.querySelector('select[id^="day-"]');
      if (ds) ds.addEventListener('change', e => { setDay(it, e.target.value); touch(it, row); save(); renderKeep(); });
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
    bindXfer();
    bindCycle();
    bindQuick();
    bindLines();
    bindHistory();
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
    // 支出・収入は下のタブのページで登録・編集する
    main.querySelectorAll('[data-act="go-out"]').forEach(b => b.addEventListener('click', () => { meta.page = 'variable'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); }));
    main.querySelectorAll('[data-act="go-in"]').forEach(b => b.addEventListener('click', () => { meta.page = 'income'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); }));
    bindTotal(); bindUpcoming(); bindPanels(); bindPrepTop(); bindFlow(); bindSched(); bindBack();
    main.querySelectorAll('[data-act="go-close"]').forEach(b => b.addEventListener('click', () => { go('books'); const c = $('#closecard'); if (c) c.scrollIntoView({ block: 'start' }); }));
    main.querySelectorAll('[data-act="sample-clear"]').forEach(b => b.addEventListener('click', () => confirmSheet('サンプルを消しますか？', '<p class="sub" style="margin:0">サンプルの口座・支出・収入をすべて消して、空の状態からはじめます。</p>', '消してはじめる', () => {
      state = emptyState(); meta.page = 'prep'; saveMeta(); save(); renderAll(); window.scrollTo(0, 0); toast('空の状態になりました');
    }, true)));
    main.querySelectorAll('[data-act="wipe"]').forEach(b => b.addEventListener('click', () => confirmSheet('すべてのデータを消しますか？', '<p class="flag" style="margin:0">口座・支出・収入・残高がすべて消え、元に戻せません。</p>', 'すべて消す', () => {
      try { (books ? books.list : [{ id: 'main' }]).forEach(b => localStorage.removeItem(dataKey(b.id))); localStorage.removeItem(BOOKS); } catch (e) { /* 消せなくても画面は初期化する */ }
      books = null;
      try { localStorage.removeItem(HISTORY); } catch (e) { /* 履歴も消す */ }
      state = null; meta = { lastBackupAt: meta.lastBackupAt, backupEvery: meta.backupEvery, theme: meta.theme }; saveMeta(); renderAll(); window.scrollTo(0, 0); $('#saved').textContent = ''; toast('すべてのデータを消しました');
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

  /* ---------- 電卓（変動費などの金額をその場で計算して入れる） ---------- */
  const CALC_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="3" width="14" height="18" rx="2.5"/><rect x="8" y="6" width="8" height="3.2" rx=".8"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01" stroke-width="2.4"/></svg>';
  const OPS = { '+': '＋', '-': '−', '*': '×', '/': '÷' };
  /** 式（数字と + - * /）を計算する。掛け算・割り算を先に。作れない式は null */
  function calcEval(toks) {
    const t = toks.slice(); if (!t.length) return null;
    if (OPS[t[t.length - 1]]) t.pop();
    if (!t.length) return null;
    const nums = [], ops = [];
    for (let i = 0; i < t.length; i++) {
      if (i % 2 === 0) { const n = Number(t[i]); if (!isFinite(n)) return null; nums.push(n); } else ops.push(t[i]);
    }
    const n2 = [nums[0]], o2 = [];
    for (let i = 0; i < ops.length; i++) {
      const b = nums[i + 1];
      if (ops[i] === '*') n2[n2.length - 1] *= b;
      else if (ops[i] === '/') { if (b === 0) return null; n2[n2.length - 1] /= b; }
      else { o2.push(ops[i]); n2.push(b); }
    }
    let v = n2[0]; for (let i = 0; i < o2.length; i++) v = o2[i] === '+' ? v + n2[i + 1] : v - n2[i + 1];
    return Math.round(v * 1e6) / 1e6;
  }
  function openCalc(inp, name) {
    const m = $('#modal');
    const cur = parseAmount(inp.value);
    let toks = (cur != null && !Number.isNaN(cur)) ? [String(cur)] : [];
    let fresh = toks.length > 0; // 最初の数字は打つと置きかわる
    const keys = [['C', 'clr'], ['⌫', 'bs'], ['÷', '/'], ['×', '*'], ['7'], ['8'], ['9'], ['−', '-'], ['4'], ['5'], ['6'], ['＋', '+'], ['1'], ['2'], ['3'], ['=', 'eq'], ['0'], ['00'], ['.', 'dot']];
    m.innerHTML = '<div class="sheet calc" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">電卓<span class="sub">　' + esc(name) + '</span></h2>' +
      '<div class="calc-disp"><div class="calc-expr" id="cExpr"></div><div class="calc-res" id="cRes" aria-live="polite"></div></div>' +
      '<div class="calc-keys">' + keys.map(k => '<button type="button" data-k="' + (k[1] || k[0]) + '" class="' + (OPS[k[1]] ? 'op' : k[1] === 'eq' ? 'eq' : k[1] === 'clr' || k[1] === 'bs' ? 'fn' : '') + '">' + k[0] + '</button>').join('') + '</div>' +
      '<div class="btnrow"><button id="mCancel">やめる</button><button id="mOk" class="primary">この金額にする</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    const result = () => calcEval(toks);
    const draw = () => {
      $('#cExpr').textContent = toks.length ? toks.map(x => OPS[x] ? ' ' + OPS[x] + ' ' : (x.indexOf('.') >= 0 ? x : nf.format(Number(x)))).join('') : '0';
      const v = result(); const r = $('#cRes');
      if (v == null) { r.textContent = toks.length ? '計算できません' : '0円'; r.classList.toggle('bad', !!toks.length); }
      else { const y = Math.round(v); r.textContent = '= ' + nf.format(y) + '円' + (y !== v ? '（四捨五入）' : ''); r.classList.toggle('bad', y < 0); }
      const ok = $('#mOk'); const y = v == null ? null : Math.round(v);
      ok.disabled = toks.length > 0 && (y == null || y < 0);
    };
    const press = k => {
      const last = toks[toks.length - 1]; const isOp = x => !!OPS[x];
      if (k === 'clr') { toks = []; fresh = false; }
      else if (k === 'bs') { fresh = false; if (!toks.length) return; if (isOp(last)) toks.pop(); else { const s2 = last.slice(0, -1); if (s2 === '' || s2 === '-') toks.pop(); else toks[toks.length - 1] = s2; } }
      else if (k === 'eq') { const v = result(); if (v != null) { toks = [String(v)]; fresh = true; } }
      else if (OPS[k]) { fresh = false; if (!toks.length) return; if (isOp(last)) toks[toks.length - 1] = k; else toks.push(k); }
      else { // 数字・00・小数点
        if (fresh) { toks = []; fresh = false; }
        const l2 = toks[toks.length - 1];
        if (!toks.length || isOp(l2)) toks.push(k === 'dot' ? '0.' : k === '00' ? '0' : k);
        else if (k === 'dot') { if (l2.indexOf('.') < 0) toks[toks.length - 1] = l2 + '.'; }
        else if (l2 === '0') toks[toks.length - 1] = k === '00' ? '0' : k;
        else if (l2.replace('.', '').length < 12) toks[toks.length - 1] = l2 + k;
      }
      draw();
    };
    m.querySelector('.calc-keys').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
    $('#mCancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    $('#mOk').onclick = () => {
      const v = result(); const y = toks.length ? (v == null ? null : Math.round(v)) : null;
      if (toks.length && (y == null || y < 0)) return;
      close();
      inp.value = y == null ? '' : String(y);
      inp.dispatchEvent(new Event('input', { bubbles: true })); // 保存・計算は通常の入力と同じ流れ
      inp.dispatchEvent(new Event('blur'));
      toast('「' + name + '」に ' + (y == null ? '未入力' : nf.format(y) + '円') + ' を入れました');
    };
    draw();
  }

  /* ---------- 今開いている帳簿（帳簿の切り替えが画面の外に出たら上に小さく出す） ---------- */
  function syncPill() {
    const p = $('#bookPill'); if (!p) return;
    const bk = $('#books');
    const show = !!(state && books && books.list.length > 1 && !bk.hidden && bk.getBoundingClientRect().bottom < 4);
    if (show) {
      const i = books.list.findIndex(b => b.id === books.current); const b = books.list[i];
      const name = b ? b.name : '';
      if (p._k !== books.current + name) { p._k = books.current + name; p.className = 'bookpill b' + ((i < 0 ? 0 : i) % 5); p.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="lbl">帳簿</span>' + esc(name) + '<span class="chev" aria-hidden="true">▾</span>'; p.setAttribute('aria-label', '開いている帳簿：' + name + '（タップで切り替え）'); }
    }
    p.hidden = !show;
  }
  function openBookSwitch() {
    const m = $('#modal');
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">帳簿を切り替える</h2>' +
      '<div class="bookpick">' + books.list.map((b, i) => '<button class="book b' + (i % 5) + (b.id === books.current ? ' on' : '') + '" data-pick="' + esc(b.id) + '">' + esc(b.name) + (b.id === books.current ? '<span class="sub">（開いています）</span>' : '') + '</button>').join('') + '</div>' +
      '<div class="btnrow"><button id="mCancel">閉じる</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close; m.onclick = e => { if (e.target === m) close(); };
    m.querySelectorAll('[data-pick]').forEach(x => x.addEventListener('click', () => {
      const id = x.dataset.pick; close();
      if (id !== books.current) switchBook(id, true); // 今のページのまま帳簿だけ切り替える
    }));
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

  /* ---------- 引き落としの記録 ---------- */
  function isoToday() { return isoOf(today()); }
  function isoToObj(iso) { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; }
  /** 引落日が来た分を自動で記録する（初めて使った日から。消した記録は作り直さない） */
  function recordPast() {
    if (!state) return;
    const T = today(), iso = isoOf(T);
    state.history = state.history || [];
    if (!state.historySince) { state.historySince = iso; }
    const startIso = state.historyUntil ? isoOf(C.addDays(isoToObj(state.historyUntil), 1)) : state.historySince;
    if (startIso > iso) return;
    const from = isoToObj(startIso);
    const hiddenAcc = new Set(state.hiddenAccounts || []);
    const kinds = [['variable', '変動費'], ['fixed', '固定費'], ['once', '1回のみ']];
    let added = 0;
    for (const [k, label] of kinds) {
      for (const it of (state[k] || [])) {
        if (it.hidden || hiddenAcc.has(it.account) || !state.accounts.includes(it.account)) continue;
        for (const o of C.occurrencesIn(it, from, T, false)) {
          const amt = C.amountFor(it, o);
          if (amt === 0) continue;
          state.history.push({ id: uid('h'), date: isoOf(o), name: it.name, account: it.account, amount: amt, kind: label, src: it.id, auto: true, edited: false });
          added++;
        }
      }
    }
    state.historyUntil = iso;
    if (added) state.history.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    deductPast(iso);
    save();
  }
  /** 引落日が過ぎた引き落としを、口座の残高から一度だけ引く（この機能を入れた日以降の引落が対象） */
  function localIso(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function deductPast(todayIso) {
    if (!state.deductSince) state.deductSince = todayIso;
    if (state.autoDeduct === false) return;
    const done = {};
    for (const h of state.history || []) {
      if (!h.auto || h.deductChecked || h.date < state.deductSince || h.date >= todayIso) continue;
      h.deductChecked = true;
      if (h.amount == null || h.amount === 0) continue;
      const b = state.balances[h.account];
      if (!b || b.amount == null) continue;
      if (b.updatedAt && localIso(b.updatedAt) >= h.date) continue; // 引落日以降に残高を入れ直している
      b.amount -= h.amount; h.deducted = true;
      done[h.account] = (done[h.account] || 0) + h.amount;
    }
    const keys = Object.keys(done);
    if (keys.length) setTimeout(() => toast('引落が済んだ分を残高から引きました：' + keys.map(k => k + ' −' + nf.format(done[k]) + '円').join('、')), 600);
  }
  /**
   * 変動費は「○月分」で管理する。
   * ・月が決まっていない項目は、次の引落の月にする（金額はそのまま）
   * ・選んだ月の引落が済んだら、次の月に進めて金額を空にする（済んだ分は記録に残っている）。0円はそのまま引き継ぐ
   */
  function rollVariable() {
    if (!state) return;
    const T = today(); let changed = 0;
    for (const it of state.variable || []) {
      const nd = C.nextDate(it, T); if (!nd) continue;
      const n0 = nd.orig || nd; const n = it.nm ? C.addMonth(n0.y, n0.m, -it.nm) : n0; const ym = n.y + '-' + String(n.m).padStart(2, '0');
      if (!it.month) { it.month = ym; changed++; }
      else if (it.month < ym) { it.month = ym; if (it.amount !== 0) { it.amount = null; it.updatedAt = null; } changed++; }
    }
    if (changed) save();
  }
  let histMonth = null; // 表示中の月（YYYY-MM）
  function ymOf(iso) { return iso.slice(0, 7); }
  function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return y + '年' + m + '月'; }
  function ymShift(ym, n) { const [y, m] = ym.split('-').map(Number); const t = C.addMonth(y, m, n); return t.y + '-' + String(t.m).padStart(2, '0'); }
  function historyHTML() {
    const cur = isoToday().slice(0, 7);
    histMonth = histMonth || cur;
    const all = state.history || [];
    const list = all.filter(h => ymOf(h.date) === histMonth).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const sum = l => l.reduce((s, h) => s + (h.amount || 0), 0);
    const total = sum(list), prevTotal = sum(all.filter(h => ymOf(h.date) === ymShift(histMonth, -1)));
    const missing = list.filter(h => h.amount == null).length;
    const diff = total - prevTotal;
    const byAcc = {}; list.forEach(h => { byAcc[h.account] = (byAcc[h.account] || 0) + (h.amount || 0); });
    const accRows = Object.keys(byAcc).sort((a, b) => byAcc[b] - byAcc[a]).map((a, i) => '<div class="hacc">' + ICON.bank(BANK_COLORS[i % BANK_COLORS.length]) + '<span class="grow">' + esc(a) + '</span><b class="num">' + nf.format(byAcc[a]) + '円</b></div>').join('');
    const rows = list.map(h => '<button class="hrec" data-hid="' + esc(h.id) + '"><span class="hd">' + dateLabel(h.date) + '</span><span class="hn"><b>' + esc(h.name) + '</b><span class="kchip k-' + ({ '変動費': 'v', '固定費': 'f', '1回のみ': 'o' }[h.kind] || 'o') + '">' + esc(h.kind) + '</span><small>' + esc(h.account) + (h.edited ? '・修正済み' : h.auto ? '' : '・手入力') + (h.deducted ? '・残高から引き済み' : '') + '</small></span><span class="ha num">' + (h.amount == null ? '<span class="flag">未入力</span>' : nf.format(h.amount) + '円') + '</span></button>').join('');
    const since = state.historySince ? dateLabel(state.historySince) : '';
    return '<section id="sec-history" aria-label="引き落としの記録"><button class="backlink" data-act="back-flow">‹ 収支記録に戻る</button><div class="section-head"><h2>引き落としの記録</h2><span class="head-right"><button class="small primary" data-act="hist-add">＋ 追加</button></span></div>' +
      '<div class="cycle hsum"><div class="cyc-head"><button class="small" data-hm="-1" aria-label="前の月">‹</button><div class="cyc-title"><b>' + ymLabel(histMonth) + '</b><span class="sub">' + list.length + '件の引き落とし</span></div><button class="small" data-hm="1" aria-label="次の月"' + (histMonth >= cur ? ' disabled' : '') + '>›</button></div>' +
      '<div class="cyc-grid two-col"><div><span class="k">引き落としの合計</span><span class="v num">' + nf.format(total) + '<span class="yen">円</span></span>' + (missing ? '<span class="flag">金額未入力 ' + missing + '件</span>' : '') + '</div>' +
      '<div class="diff ' + (diff > 0 ? 'neg' : 'pos') + '"><span class="k">先月との差</span><span class="v num">' + (diff > 0 ? '＋' : diff < 0 ? '−' : '±') + nf.format(Math.abs(diff)) + '<span class="yen">円</span></span><span class="sub">先月 ' + nf.format(prevTotal) + '円</span></div></div>' +
      (accRows ? '<div class="haccs">' + accRows + '</div>' : '') + '</div>' +
      '<div class="list hlist">' + (rows || '<div class="emptyrow sub">この月の記録はありません</div>') + '</div>' +
      '<div class="btnrow" style="margin-top:12px"><button data-act="hist-csv" data-scope="month">この月をCSVで書き出す</button><button data-act="hist-csv" data-scope="all">全部をCSVで書き出す</button></div>' +
      '<p class="note">引落日が来た分を、そのときの金額で自動で記録します（' + since + 'から）。実際の金額と違うときは、記録を押して直せます。それより前の分は「＋ 追加」で入れられます。</p></section>';
  }
  function bindHistory() {
    main.querySelectorAll('[data-hm]').forEach(b => b.addEventListener('click', () => { histMonth = ymShift(histMonth, Number(b.dataset.hm)); renderKeep(); }));
    main.querySelectorAll('[data-hid]').forEach(b => b.addEventListener('click', () => openHistEdit(b.dataset.hid)));
    main.querySelectorAll('[data-act="hist-add"]').forEach(b => b.addEventListener('click', () => openHistEdit(null)));
    main.querySelectorAll('[data-act="hist-csv"]').forEach(b => b.addEventListener('click', () => exportCSV(b.dataset.scope)));
  }
  function openHistEdit(id) {
    const h = id ? (state.history || []).find(x => x.id === id) : null;
    const accs = state.accounts.slice();
    const kinds = ['変動費', '固定費', '1回のみ', 'その他'];
    const def = h || { date: (histMonth && histMonth !== isoToday().slice(0, 7) ? histMonth + '-01' : isoToday()), name: '', account: '', amount: null, kind: '変動費' };
    const m = $('#modal');
    m.innerHTML = '<div class="sheet form xsheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">' + (h ? '記録を直す' : '記録を追加') + '</h2>' +
      '<label>項目名<input class="text" id="hr-name" autocomplete="off" value="' + esc(def.name) + '" placeholder="例：クレジットカード"></label>' +
      '<label>引き落とされた金額<input class="amount wide" id="hr-amt" inputmode="numeric" enterkeyhint="done" autocomplete="off" value="' + yenTxt(def.amount) + '" placeholder="未入力"></label>' +
      '<div class="two"><label>日付<input class="text" type="date" id="hr-date" value="' + esc(def.date) + '"></label>' +
      '<label>種類<select id="hr-kind">' + kinds.map(k => '<option' + (k === def.kind ? ' selected' : '') + '>' + k + '</option>').join('') + '</select></label></div>' +
      '<label>口座<select id="hr-acc">' + (def.account ? '' : '<option value="" selected>選ぶ</option>') + accs.concat(def.account && !accs.includes(def.account) ? [def.account] : []).map(a => '<option' + (a === def.account ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label>' +
      '<div class="btnrow">' + (h ? '<button class="danger" id="hr-del">削除</button>' : '') + '<button id="mCancel">やめる</button><button id="mOk" class="primary">保存</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close; m.onclick = e => { if (e.target === m) close(); };
    if (h) $('#hr-del').onclick = () => { state.history = state.history.filter(x => x.id !== h.id); save(); close(); renderKeep(); toast('記録を削除しました'); };
    $('#mOk').onclick = () => {
      const name = $('#hr-name').value.trim(), v = parseAmount($('#hr-amt').value), date = $('#hr-date').value, acc = $('#hr-acc').value, kind = $('#hr-kind').value;
      if (!name) { toast('項目名を入力してください'); return; }
      if (Number.isNaN(v)) { toast('金額は数字で入力してください'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('日付を選んでください'); return; }
      if (!acc) { toast('口座を選んでください'); return; }
      if (h) Object.assign(h, { name, amount: v, date, account: acc, kind, edited: true });
      else (state.history = state.history || []).push({ id: uid('h'), date, name, account: acc, amount: v, kind, src: null, auto: false, edited: false });
      state.history.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
      histMonth = ymOf(date); save(); close(); renderKeep(); toast(h ? '記録を直しました' : '記録を追加しました');
    };
    $('#hr-name').focus();
  }
  async function exportCSV(scope) {
    const rows = (state.history || []).filter(h => scope === 'all' || ymOf(h.date) === histMonth).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    if (!rows.length) { toast('書き出す記録がありません'); return; }
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const book = curBook() ? curBook().name : '';
    const text = '\ufeff' + ['日付,項目,種類,口座,金額,帳簿'].concat(rows.map(h => [h.date, h.name, h.kind, h.account, h.amount == null ? '' : h.amount, book].map(q).join(','))).join('\r\n');
    const name = '引き落とし記録_' + book + '_' + (scope === 'all' ? '全部' : histMonth) + '.csv';
    if (N.isNative) { try { await N.shareFile(name, text); } catch (e) { toast('書き出せませんでした'); } return; }
    const file = new File([text], name, { type: 'text/csv' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
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
      '<div class="two"><label>引落日' + (kind === 'once' ? '<input class="text" type="date" id="as-date" value="' + (meta.qdate || isoOf(today())) + '">' : daySelect('as-day', day, meta.qnm, true)) + '</label>' +
      '<label>引落口座<select id="as-acc">' + (acc ? '' : '<option value="" selected>選ぶ</option>') + accs.map(a => '<option' + (a === acc ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label></div>' +
      (kind === 'variable' ? '<label>何月分の引落か' + monthSelect('as-month', { month: (() => { const T = today(); const n = C.addMonth(T.y, T.m, T.d > 10 ? 1 : 0); return n.y + '-' + String(n.m).padStart(2, '0'); })(), day: null }) + '</label>' : '') +
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
      const msel = $('#as-month'); if (kind === 'variable' && msel && msel.value) it.month = msel.value;
      if (kind === 'once') {
        const dv = $('#as-date').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(dv)) { toast('引落日を選んでください'); return false; }
        it.date = dv; meta.qdate = dv;
      } else {
        const dv = $('#as-day').value; setDay(it, dv); meta.qday = it.day; meta.qnm = it.nm ? 1 : 0;
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
  const PAGES = ['prep', 'variable', 'fixed', 'income', 'history', 'settings'];
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

  /* ---------- 表示の明るさ（自動・ライト・ダーク） ---------- */
  const THEMES = [['light', 'ライト', 'いつも明るい表示（標準）'], ['dark', 'ダーク', 'いつも暗い表示'], ['auto', '自動', '端末の設定に合わせる']];
  function themeOf() { return ['auto', 'dark'].includes(meta.theme) ? meta.theme : 'light'; } // 標準はライト
  function applyTheme() {
    const t = themeOf(); const root = document.documentElement;
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    const col = proActive() ? colorOf() : 'blue';
    if (col === 'blue') root.removeAttribute('data-color'); else root.setAttribute('data-color', col);
    const bi = document.querySelector('.brand-img'); if (bi && col !== 'blue') bi.setAttribute('src', 'icon-' + col + '-180.png');
    // Webアプリ版：ホーム画面に追加するときのアイコンも、選んだ色にする（追加し直すと反映）
    const ti = document.querySelector('link[rel="apple-touch-icon"]'); if (ti) ti.setAttribute('href', col === 'blue' ? 'apple-touch-icon-v3.png' : 'icon-' + col + '-180.png');
    const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const TC = { blue: ['#E3EEFB', '#13213A'], pink: ['#F7CFDD', '#3A1D2E'], green: ['#C9EBD9', '#173327'], purple: ['#D9CEF7', '#241E3D'], orange: ['#F8D3B8', '#382315'] }[col];
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.setAttribute('content', TC[dark ? 1 : 0]); m.removeAttribute('media'); });

  }
  function openTheme() {
    const t = themeOf(); const m = $('#modal');
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">表示の明るさ</h2>' +
      '<div class="theme-seg">' + THEMES.map(x => '<button data-theme-pick="' + x[0] + '" class="' + (x[0] === t ? 'on' : '') + '">' + x[1] + '</button>').join('') + '</div>' +
      '<p class="sub" style="margin:0">' + THEMES.map(x => x[1] + '：' + x[2]).join('　') + '</p>' +
      '<div class="btnrow"><button id="mCancel">閉じる</button></div></div>';
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    $('#mCancel').onclick = close; m.onclick = e => { if (e.target === m) close(); };
    m.querySelectorAll('[data-theme-pick]').forEach(b => b.addEventListener('click', () => {
      meta.theme = b.dataset.themePick; saveMeta(); applyTheme();
      m.querySelectorAll('[data-theme-pick]').forEach(x => x.classList.toggle('on', x === b));
    }));
  }
  $('#setBtn').addEventListener('click', () => { if (!state) return; meta.page = 'settings'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); });
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch (e) { /* 古い端末 */ }
  const fabTop = $('#fabTop'), fabAdd = $('#fabAdd');
  const syncFab = () => {
    fabTop.hidden = !state || window.scrollY < 500;
    const pg = meta.page;
    fabAdd.hidden = !state || !(pg === 'variable' || pg === 'fixed');
    if (!fabAdd.hidden) fabAdd.textContent = pg === 'fixed' ? '＋ 固定費' : '＋ 変動費';
  };
  window.addEventListener('scroll', () => { cancelAnimationFrame(syncFab._r); syncFab._r = requestAnimationFrame(() => { syncFab(); syncPill(); }); }, { passive: true });
  $('#bookPill').addEventListener('click', openBookSwitch);
  fabTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  fabAdd.addEventListener('click', () => openAddSheet(meta.page === 'fixed' ? 'fixed' : 'variable'));
  $('#books').addEventListener('click', e => {
    const b = e.target.closest('[data-book]'); if (b) { switchBook(b.dataset.book); return; }
    if (e.target.closest('[data-act="book-add"]')) { meta.page = 'settings'; meta.stab = 'books'; meta.reorder = null; saveMeta(); renderAll(); window.scrollTo(0, 0); const n = $('#booknew'); if (n) n.focus(); }
  });

  /* ---------- 起動 ---------- */
  /* ---------- 金額欄の「×」（タップで消す） ---------- */
  // 金額欄が作られるたびに自動で「×」を付ける（描き直し・確認画面の中も）
  function addClear(inp) {
    if (inp._clr || !inp.isConnected) return;
    inp._clr = true;
    const wrap = document.createElement('span'); wrap.className = 'amtwrap';
    // 幅の指定は入れ物に引き継ぐ
    if (inp.classList.contains('wide')) wrap.classList.add('wide');
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'clr'; btn.setAttribute('aria-label', '金額を消す'); btn.textContent = '×';
    wrap.appendChild(btn);
    const sync = () => wrap.classList.toggle('has', inp.value !== '');
    inp.addEventListener('input', sync); sync();
    btn.addEventListener('pointerdown', e => e.preventDefault()); // 入力中のキーボードを閉じない
    btn.addEventListener('click', () => {
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true })); // 保存・計算は通常の入力と同じ流れ
      inp.dispatchEvent(new Event('blur'));
      sync(); inp.focus();
    });
  }
  function scanAmounts(root) { (root || document).querySelectorAll('input.amount').forEach(addClear); }
  try {
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches('input.amount')) addClear(n); else if (n.querySelectorAll) scanAmounts(n); } })
      .observe(document.body, { childList: true, subtree: true });
  } catch (e) { /* 古い端末では「×」なし */ }

  function boot() {
  load();
  applyTheme();
  setTimeout(() => scanAmounts(), 0);
  renderAll();
  if (state) $('#saved').textContent = '保存済み';
  // 日付が変わったら確認日と集計を更新（入力中は邪魔しない）
  const tick = () => { if (keyOf(today()) !== todayKey && !(document.activeElement && document.activeElement.matches('input,select'))) renderKeep(); };
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); syncTyping(); } });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!N.isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (N.isNative) {
    refreshPro(); refreshIcon();
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
