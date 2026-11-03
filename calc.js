/* 家計の入金準備 — 計算ロジック（画面から独立。node でもテストできる） */
(function (root) {
  'use strict';

  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m: 1-12
  function serial(dt) { return Date.UTC(dt.y, dt.m - 1, dt.d); }
  function addMonth(y, m, n) { const t = (y * 12 + (m - 1)) + n; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
  function weekday(dt) { return new Date(Date.UTC(dt.y, dt.m - 1, dt.d)).getUTCDay(); }
  function fromDate(d) { return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }

  /** その月の引落日（月末・31日などは月の最終日に合わせる） */
  function occurrence(item, y, m) {
    const ld = lastDay(y, m);
    const d = item.day === 'end' ? ld : Math.min(Number(item.day), ld);
    return { y, m, d };
  }

  /* ---------- 休日（土日・祝日・振替休日・国民の休日・銀行の年末年始 12/31〜1/3） ---------- */
  function addDays(dt, n) { const t = new Date(Date.UTC(dt.y, dt.m - 1, dt.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  function nthMonday(y, m, n) { const w = weekday({ y, m, d: 1 }); return 1 + ((8 - w) % 7) + (n - 1) * 7; }
  const holidayCache = {};
  /** その年の祝日（祝日法による。1980〜2099年の春分・秋分の近似式） */
  function holidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    const h = {};
    const put = (m, d, name) => { h[m + '-' + d] = name; };
    put(1, 1, '元日'); put(1, nthMonday(y, 1, 2), '成人の日'); put(2, 11, '建国記念の日'); put(2, 23, '天皇誕生日');
    put(3, Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)), '春分の日');
    put(4, 29, '昭和の日'); put(5, 3, '憲法記念日'); put(5, 4, 'みどりの日'); put(5, 5, 'こどもの日');
    put(7, nthMonday(y, 7, 3), '海の日'); put(8, 11, '山の日'); put(9, nthMonday(y, 9, 3), '敬老の日');
    put(9, Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)), '秋分の日');
    put(10, nthMonday(y, 10, 2), 'スポーツの日'); put(11, 3, '文化の日'); put(11, 23, '勤労感謝の日');
    // 国民の休日（祝日にはさまれた平日）
    for (const k of Object.keys(h)) {
      const [m, d] = k.split('-').map(Number); const nx = addDays({ y, m, d }, 1), nx2 = addDays({ y, m, d }, 2);
      if (!h[nx.m + '-' + nx.d] && h[nx2.m + '-' + nx2.d] && nx2.y === y && weekday(nx) !== 0) h[nx.m + '-' + nx.d] = '国民の休日';
    }
    // 振替休日（日曜の祝日の後の、最初の祝日でない日）
    for (const k of Object.keys(h)) {
      const [m, d] = k.split('-').map(Number);
      if (weekday({ y, m, d }) !== 0) continue;
      let t = addDays({ y, m, d }, 1);
      while (h[t.m + '-' + t.d] && t.y === y) t = addDays(t, 1);
      if (t.y === y) h[t.m + '-' + t.d] = h[t.m + '-' + t.d] || '振替休日';
    }
    return (holidayCache[y] = h);
  }
  function holidayName(dt) { return holidays(dt.y)[dt.m + '-' + dt.d] || null; }
  /** 銀行が動く日か（土日・祝日・12/31〜1/3は休み） */
  function isBusinessDay(dt) {
    const w = weekday(dt);
    if (w === 0 || w === 6) return false;
    if ((dt.m === 12 && dt.d === 31) || (dt.m === 1 && dt.d <= 3)) return false;
    return !holidayName(dt);
  }
  const SHIFTS = ['after', 'before', 'none'];
  /** 休日の扱い：収入は前の営業日、支出は後の営業日が初期値 */
  function shiftMode(item, isIncome) { return SHIFTS.includes(item.shift) ? item.shift : (isIncome ? 'before' : 'after'); }
  function shiftDate(dt, mode) {
    if (mode === 'none' || isBusinessDay(dt)) return dt;
    let t = dt; const step = mode === 'before' ? -1 : 1;
    for (let i = 0; i < 15 && !isBusinessDay(t); i++) t = addDays(t, step);
    return t;
  }
  /** その月の実際の日付（休日なら設定どおりずらす）。orig に元の日付 */
  function actual(item, y, m, isIncome) {
    const o = occurrence(item, y, m);
    const a = shiftDate(o, shiftMode(item, isIncome));
    return serial(a) === serial(o) ? o : Object.assign({ orig: o }, a);
  }

  /** 終了月（"2026-12" など）を過ぎた月の引落は数えない */
  function activeIn(item, y, m) {
    if (!item.end) return true;
    const [ey, em] = String(item.end).split('-').map(Number);
    if (!ey || !em) return true;
    return y * 12 + m <= ey * 12 + em;
  }

  /**
   * 集計期間（重複なし・確認日から連続）
   * 締め日は毎月10日。10日が休日なら翌営業日まで延ばす（例：10/10(土)・10/12祝 → 10/13締め）
   *  確認日が締め日以前 : ①確認日〜当月の締め日  ②締め日の翌日〜月末
   *  確認日が締め日より後: ①確認日〜当月末      ②翌月1日〜翌月の締め日
   * 過不足は確認日から次の締め日までの引落で判定する（inClose）
   */
  function closingOf(y, m) { return shiftDate({ y, m, d: 10 }, 'after'); }
  function windows(T) {
    const ld = lastDay(T.y, T.m);
    const c = closingOf(T.y, T.m);
    if (T.d <= c.d) {
      return [
        { key: 'w10', label: '10日まで', from: T, to: c, inClose: true },
        { key: 'wEnd', label: '月末まで', from: addDays(c, 1), to: { y: T.y, m: T.m, d: ld }, inClose: false }
      ];
    }
    const n = addMonth(T.y, T.m, 1);
    return [
      { key: 'wEnd', label: '月末まで', from: T, to: { y: T.y, m: T.m, d: ld }, inClose: true },
      { key: 'w10', label: '翌10日まで', from: { y: n.y, m: n.m, d: 1 }, to: closingOf(n.y, n.m), inClose: true }
    ];
  }

  /** 期間内の引落（1項目につき月1回。休日でずれて月をまたぐ分も拾うため前後1か月も見る） */
  function occurrencesIn(item, from, to, isIncome) {
    const out = [];
    const span = (to.y * 12 + to.m) - (from.y * 12 + from.m);
    for (let i = -1; i <= span + 1; i++) {
      const ym = addMonth(from.y, from.m, i);
      if (!activeIn(item, ym.y, ym.m)) continue;
      const a = actual(item, ym.y, ym.m, isIncome);
      const s = serial(a);
      if (s >= serial(from) && s <= serial(to)) out.push(a);
    }
    return out;
  }

  /** 確認日以降で最初の日付（休日のずらしを反映） */
  function nextDate(item, T, isIncome) {
    let best = null;
    for (let i = -1; i < 4; i++) {
      const ym = addMonth(T.y, T.m, i);
      if (!activeIn(item, ym.y, ym.m)) continue;
      const a = actual(item, ym.y, ym.m, isIncome);
      if (serial(a) >= serial(T) && (!best || serial(a) < serial(best))) best = a;
    }
    return best;
  }

  function compute(data, T) {
    const W = windows(T);
    // 非表示の項目・口座・収入は計算に含めない
    const hiddenAcc = new Set(data.hiddenAccounts || []);
    const items = []
      .concat((data.variable || []).filter(x => !x.hidden).map(x => Object.assign({ kind: '変動費' }, x)))
      .concat((data.fixed || []).filter(x => !x.hidden).map(x => Object.assign({ kind: '固定費' }, x)));
    const banks = (data.accounts || []).filter(a => !hiddenAcc.has(a)).map(name => {
      const bal = (data.balances || {})[name] || {};
      const b = { name, sums: {}, lines: {}, unentered: 0, unenteredDue: 0, next: null, balance: bal.amount == null ? null : Number(bal.amount), balanceUpdatedAt: bal.updatedAt || null };
      for (const w of W) { b.sums[w.key] = 0; b.lines[w.key] = []; }
      for (const it of items) {
        if (it.account !== name) continue;
        for (const w of W) {
          for (const o of occurrencesIn(it, w.from, w.to)) {
            if (it.amount == null) { b.unentered++; if (w.inClose) b.unenteredDue++; }
            else b.sums[w.key] += Number(it.amount);
            b.lines[w.key].push({ date: o, orig: o.orig || null, name: it.name, amount: it.amount, kind: it.kind });
          }
        }
        if (it.amount !== 0) {
          const nd = nextDate(it, T);
          if (nd && (!b.next || serial(nd) < serial(b.next))) b.next = nd;
        }
      }
      for (const w of W) b.lines[w.key].sort((a, c) => serial(a.date) - serial(c.date));
      b.total = W.reduce((s, w) => s + b.sums[w.key], 0);
      b.due = W.filter(w => w.inClose).reduce((s, w) => s + b.sums[w.key], 0);
      b.shortfall = b.balance == null ? null : Math.max(0, b.due - b.balance);
      b.surplus = b.balance == null ? null : Math.max(0, b.balance - b.due);
      b.active = b.total > 0 || b.unentered > 0;
      b.dueActive = b.due > 0 || b.unenteredDue > 0;
      return b;
    });
    const totals = {};
    for (const w of W) totals[w.key] = banks.reduce((s, b) => s + b.sums[w.key], 0);
    const entered = banks.filter(b => b.dueActive && b.balance != null);
    const closeWin = W.find(w => w.key === 'w10');
    return {
      T, windows: W, banks, totals, closing: closeWin.to,
      dueTotal: banks.reduce((s, b) => s + b.due, 0),
      dueCount: banks.filter(b => b.dueActive).length,
      grandTotal: banks.reduce((s, b) => s + b.total, 0),
      shortfallTotal: entered.reduce((s, b) => s + b.shortfall, 0),
      shortCount: entered.filter(b => b.shortfall > 0).length,
      surplusTotal: entered.reduce((s, b) => s + b.surplus, 0),
      surplusCount: entered.filter(b => b.surplus > 0).length,
      activeCount: banks.filter(b => b.active).length,
      balanceMissing: banks.filter(b => b.dueActive && b.balance == null).length,
      income: (data.income || []).filter(i => !i.hidden).map(i => Object.assign({}, i, { next: nextDate(i, T, true) }))
        .sort((a, c) => serial(a.next) - serial(c.next))
    };
  }

  const api = { closingOf, holidays, holidayName, isBusinessDay, shiftDate, shiftMode, actual, addDays, WD, lastDay, serial, addMonth, weekday, fromDate, occurrence, activeIn, windows, occurrencesIn, nextDate, compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
