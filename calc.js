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

  /** 「○月分」を指定した項目は、その月の引落にだけ金額を使う（ほかの月は未入力） */
  function amountFor(it, o) {
    if (!it.month) return it.amount;
    const n = o.orig || o;
    const ym = n.y + '-' + String(n.m).padStart(2, '0');
    return ym === it.month ? it.amount : null;
  }

  /** 終了月（"2026-12" など）を過ぎた月の引落は数えない */
  function activeIn(item, y, m) {
    if (Array.isArray(item.months) && item.months.length && !item.months.includes(m)) return false; // 年に数回（例：6月・12月）
    if (!item.end) return true;
    const [ey, em] = String(item.end).split('-').map(Number);
    if (!ey || !em) return true;
    return y * 12 + m <= ey * 12 + em;
  }

  /**
   * 集計期間（重複なし・確認日から連続）
   * 締め日は設定で変更できる（初期値：毎月10日・休日なら翌営業日）
   *  次の締め日が今月中   : ①確認日〜締め日（判定に使う）  ②締め日の翌日〜その月末（参考）
   *  次の締め日が翌月以降 : ①確認日〜今月末（判定に使う）  ②翌月1日〜締め日（判定に使う）
   */
  /**
   * 期限は2つまで自由に設定できる（期限1は不足・余りの判定に使う締め日）
   * 初期値：期限1＝毎月10日（休日なら後ろ）、期限2＝月末（ずらさない）
   */
  function validDayVal(v, def) { return v === 'end' || (Number.isInteger(v) && v >= 1 && v <= 28) ? v : def; }
  function closeSettings(data) {
    const s = (data && data.settings) || {};
    const d1 = { day: validDayVal(s.closeDay, 10), shift: SHIFTS.includes(s.closeShift) ? s.closeShift : 'after' };
    // 期限2は「追加」したときだけ使う（初期は締め日1つ）
    const d2 = s.close2On ? { day: validDayVal(s.close2Day, 'end'), shift: SHIFTS.includes(s.close2Shift) ? s.close2Shift : 'none' } : null;
    const d2saved = { day: validDayVal(s.close2Day, 'end'), shift: SHIFTS.includes(s.close2Shift) ? s.close2Shift : 'none' };
    return { d1, d2, d2saved, day: d1.day, shift: d1.shift };
  }
  function nominalClosing(y, m, cs) { return { y, m, d: cs.day === 'end' ? lastDay(y, m) : cs.day }; }
  function closingOf(y, m, cs) { cs = cs || { day: 10, shift: 'after' }; const n = nominalClosing(y, m, cs); const a = shiftDate(n, cs.shift); return serial(a) === serial(n) ? n : Object.assign({ nominal: n }, a); }
  function nextClosing(T, cs) {
    let best = null;
    for (let i = -1; i <= 2; i++) {
      const ym = addMonth(T.y, T.m, i); const c = closingOf(ym.y, ym.m, cs);
      if (serial(c) >= serial(T) && (!best || serial(c) < serial(best))) best = c;
    }
    return best;
  }
  function deadlineLabel(dl, c, T) {
    const n = c.nominal || c; const next = n.y * 12 + n.m > T.y * 12 + T.m;
    return (next ? '翌' : '') + (dl.day === 'end' ? '月末まで' : dl.day + '日まで');
  }
  /**
   * 集計期間（重複なし・確認日から連続）
   *  ①確認日〜次に来る期限  ②その翌日〜その次の期限
   *  判定（inClose）は、期限1（締め日）の次の到来日までの期間
   */
  function windows(T, cs) {
    cs = cs && cs.d1 ? cs : { d1: cs || { day: 10, shift: 'after' }, d2: null };
    if (!cs.d2) {
      // 締め日1つ：確認日〜次の締め日
      const c = nextClosing(T, cs.d1);
      return [{ key: 'w1', which: 1, label: deadlineLabel(cs.d1, c, T), from: T, to: { y: c.y, m: c.m, d: c.d }, nominal: c.nominal || null, inClose: true }];
    }
    const c1 = nextClosing(T, cs.d1), c2 = nextClosing(T, cs.d2);
    const firstIs1 = serial(c1) <= serial(c2);
    const first = firstIs1 ? c1 : c2, firstDl = firstIs1 ? cs.d1 : cs.d2;
    const s = addDays(first, 1);
    const n1 = nextClosing(s, cs.d1), n2 = nextClosing(s, cs.d2);
    const secondIs1 = serial(n1) <= serial(n2);
    const second = secondIs1 ? n1 : n2, secondDl = secondIs1 ? cs.d1 : cs.d2;
    const plain = x => ({ y: x.y, m: x.m, d: x.d });
    const W = [
      { key: 'w1', which: firstIs1 ? 1 : 2, label: deadlineLabel(firstDl, first, T), from: T, to: plain(first), nominal: first.nominal || null },
      { key: 'w2', which: secondIs1 ? 1 : 2, label: deadlineLabel(secondDl, second, T), from: s, to: plain(second), nominal: second.nominal || null }
    ];
    for (const w of W) w.inClose = serial(w.to) <= serial(c1);
    if (W[0].label === W[1].label) W[1].label = '翌' + W[1].label.replace(/^翌/, '');
    return W;
  }

  /** 期間内の引落（1項目につき月1回。休日でずれて月をまたぐ分も拾うため前後1か月も見る） */
  /** 1回のみの項目（date: "YYYY-MM-DD"）の実際の日付 */
  function onceDate(item, isIncome) {
    const p = String(item.date || '').split('-').map(Number);
    if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return null;
    const o = { y: p[0], m: p[1], d: Math.min(p[2], lastDay(p[0], p[1])) };
    const a = shiftDate(o, shiftMode(item, isIncome));
    return serial(a) === serial(o) ? o : Object.assign({ orig: o }, a);
  }
  function occurrencesIn(item, from, to, isIncome) {
    if (item.date) { const a = onceDate(item, isIncome); return a && serial(a) >= serial(from) && serial(a) <= serial(to) ? [a] : []; }
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
    if (item.date) { const a = onceDate(item, isIncome); return a && serial(a) >= serial(T) ? a : null; }
    let best = null;
    for (let i = -1; i < 4; i++) {
      const ym = addMonth(T.y, T.m, i);
      if (!activeIn(item, ym.y, ym.m)) continue;
      const a = actual(item, ym.y, ym.m, isIncome);
      if (serial(a) >= serial(T) && (!best || serial(a) < serial(best))) best = a;
    }
    return best;
  }

  /**
   * 締め日から締め日までの1サイクルの収入・支出の合計
   * offset 0 = 確認日を含むサイクル（前回の締め日の翌日〜次の締め日）、-1 = 前、1 = 次
   */
  function cycle(data, T, offset) {
    const cs = closeSettings(data).d1;
    let c = nextClosing(T, cs);                    // 確認日以降の最初の締め日
    const nom = c.nominal || c;
    const ym = addMonth(nom.y, nom.m, offset || 0);
    const to0 = closingOf(ym.y, ym.m, cs);
    const p = addMonth(ym.y, ym.m, -1);
    const prev = closingOf(p.y, p.m, cs);
    const from = addDays({ y: prev.y, m: prev.m, d: prev.d }, 1), to = { y: to0.y, m: to0.m, d: to0.d };
    const hiddenAcc = new Set(data.hiddenAccounts || []);
    const kinds = [['variable', '変動費'], ['fixed', '固定費'], ['once', '1回のみ']];
    const out = { from, to, expense: 0, byKind: {}, unentered: 0, income: 0, incomeMissing: 0, incomeItems: [],
      startShift: prev.nominal ? { nominal: prev.nominal, actual: { y: prev.y, m: prev.m, d: prev.d } } : null,
      endShift: to0.nominal ? { nominal: to0.nominal, actual: to } : null };
    for (const [k, label] of kinds) {
      let sum = 0;
      for (const it of (data[k] || [])) {
        if (it.hidden || hiddenAcc.has(it.account) || !(data.accounts || []).includes(it.account)) continue;
        for (const o of occurrencesIn(it, from, to, false)) { const amt = amountFor(it, o); if (amt == null) out.unentered++; else sum += Number(amt); }
      }
      out.byKind[label] = sum; out.expense += sum;
    }
    for (const i of (data.income || [])) {
      if (i.hidden) continue;
      for (const o of occurrencesIn(i, from, to, true)) {
        out.incomeItems.push({ name: i.name, date: o, amount: i.amount });
        if (i.amount == null) out.incomeMissing++; else out.income += Number(i.amount);
      }
    }
    out.diff = out.income - out.expense;
    return out;
  }

  function compute(data, T) {
    const cs = closeSettings(data);
    const W = windows(T, cs);
    // 非表示の項目・口座・収入は計算に含めない
    const hiddenAcc = new Set(data.hiddenAccounts || []);
    const exclSurplus = new Set(data.excludeSurplus || []);
    const items = []
      .concat((data.variable || []).filter(x => !x.hidden).map(x => Object.assign({ kind: '変動費' }, x)))
      .concat((data.fixed || []).filter(x => !x.hidden).map(x => Object.assign({ kind: '固定費' }, x)))
      .concat((data.once || []).filter(x => !x.hidden).map(x => Object.assign({ kind: '1回のみ' }, x)));
    const banks = (data.accounts || []).filter(a => !hiddenAcc.has(a)).map(name => {
      const bal = (data.balances || {})[name] || {};
      const b = { name, sums: {}, lines: {}, unentered: 0, unenteredDue: 0, next: null, balance: bal.amount == null ? null : Number(bal.amount), balanceUpdatedAt: bal.updatedAt || null };
      for (const w of W) { b.sums[w.key] = 0; b.lines[w.key] = []; }
      for (const it of items) {
        if (it.account !== name) continue;
        for (const w of W) {
          for (const o of occurrencesIn(it, w.from, w.to)) {
            const amt = amountFor(it, o);
            if (amt == null) { b.unentered++; if (w.inClose) b.unenteredDue++; }
            else b.sums[w.key] += Number(amt);
            b.lines[w.key].push({ date: o, orig: o.orig || null, name: it.name + (it.month && amt == null ? '（' + Number(((o.orig || o).m)) + '月分は未入力）' : ''), amount: amt, kind: it.kind });
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
      b.excluded = exclSurplus.has(name); // 余りの合計に含めない口座
      // 表示している最後の期限（参考の期間）まで含めた場合
      b.shortAll = b.balance == null ? null : Math.max(0, b.total - b.balance);
      b.surplusAll = b.balance == null ? null : Math.max(0, b.balance - b.total);
      b.active = b.total > 0 || b.unentered > 0;
      // 直近で必要な日（期間内で金額が0でない最初の引落。未入力も含む）
      const need = W.flatMap(w => b.lines[w.key]).filter(l => l.amount !== 0).sort((x, y) => serial(x.date) - serial(y.date))[0];
      b.firstNeed = need ? need.date : null;
      b.dueActive = b.due > 0 || b.unenteredDue > 0;
      return b;
    });
    // 準備ページは直近で必要な口座から並べる（同じ日は設定の口座順）
    const order = new Map(banks.map((b, i) => [b.name, i]));
    banks.sort((x, y) => {
      const fx = x.firstNeed ? serial(x.firstNeed) : Infinity, fy = y.firstNeed ? serial(y.firstNeed) : Infinity;
      return fx - fy || order.get(x.name) - order.get(y.name);
    });
    const totals = {};
    for (const w of W) totals[w.key] = banks.reduce((s, b) => s + b.sums[w.key], 0);
    const entered = banks.filter(b => b.dueActive && b.balance != null);
    const closeWin = W.filter(w => w.inClose).pop();
    return {
      T, windows: W, banks, totals, closing: closeWin.to, closeDay: cs.day, closeShift: cs.shift,
      dueTotal: banks.reduce((s, b) => s + b.due, 0),
      dueCount: banks.filter(b => b.dueActive).length,
      grandTotal: banks.reduce((s, b) => s + b.total, 0),
      shortfallTotal: entered.reduce((s, b) => s + b.shortfall, 0),
      shortCount: entered.filter(b => b.shortfall > 0).length,
      // 余り：残高を入力した全口座（合計に含めない設定の口座を除く）。締めまで引落がなければ残高がそのまま余り
      surplusTotal: banks.filter(b => b.balance != null && !b.excluded).reduce((s, b) => s + b.surplus, 0),
      surplusCount: banks.filter(b => b.balance != null && !b.excluded && b.surplus > 0).length,
      excludedCount: banks.filter(b => b.excluded).length,
      endAll: W[W.length - 1].to,
      shortTotalAll: banks.filter(b => b.balance != null).reduce((s, b) => s + b.shortAll, 0),
      surplusTotalAll: banks.filter(b => b.balance != null && !b.excluded).reduce((s, b) => s + b.surplusAll, 0),
      activeCount: banks.filter(b => b.active).length,
      balanceMissing: banks.filter(b => b.dueActive && b.balance == null).length,
      income: (data.income || []).filter(i => !i.hidden).map(i => Object.assign({}, i, { next: nextDate(i, T, true) }))
        .sort((a, c) => serial(a.next) - serial(c.next))
    };
  }

  const api = { VERSION: '2026.11.08a', amountFor, cycle, onceDate, deadlineLabel, closeSettings, nextClosing, closingOf, holidays, holidayName, isBusinessDay, shiftDate, shiftMode, actual, addDays, WD, lastDay, serial, addMonth, weekday, fromDate, occurrence, activeIn, windows, occurrencesIn, nextDate, compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
