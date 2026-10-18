'use strict';

// 解説ページ: ゲームと同じデータから表を作る
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TRAPS = ['ecrIf', 'natSingle', 'prodSpot'];

  // 登場人物
  const SAMPLE = {
    sre: '（プレイヤー）施策を選ぶのはあなた。',
    cfo: '「Savings Plans の契約を承認した。コミット額は 1 年間固定になる。」',
    po: '「ピーク時に API がメモリ不足で再起動して、利用者から問い合わせが来た。」',
    pm: '「1 四半期に使える工数は 6（2 名 × 3 か月）。順番を決めて進めよう。」',
    tl: '「Spot を使うなら、止められたときの振る舞い（SIGTERM）を先に確認したい。」',
  };
  $('#guide-people').innerHTML = Object.entries(CHARACTERS).map(([id, c]) => `
    <article class="gp">
      <img src="${c.img}" alt="${esc(c.role)} ${esc(c.name)}のイラスト">
      <div>
        <div class="person-role">${esc(c.role)}</div>
        <div class="person-name">${esc(c.name)}</div>
        <p>${esc(c.desc)}</p>
        <dl><dt>関心</dt><dd>${esc(c.focus)}</dd><dt>発言の例</dt><dd>${esc(SAMPLE[id])}</dd></dl>
      </div>
    </article>`).join('');

  // 信頼性スコア
  const relRow = (r) => `<tr><td>${esc(r.when)}</td><td class="num ${r.delta > 0 ? 'down' : 'up'}">${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}</td><td>${esc(r.timing)}</td><td>${esc(r.example)}</td></tr>`;
  $('#rel-down-table').innerHTML = RELIABILITY_RULES.filter((r) => r.delta < 0).map(relRow).join('');
  $('#rel-up-table').innerHTML = RELIABILITY_RULES.filter((r) => r.delta > 0).map(relRow).join('');
  $('#rank-table').innerHTML = RANKS.map((r) => `<tr><td><b>${r.rank}</b></td><td class="num">${r.achieve ? Math.round(r.achieve * 100) + '% 以上' : '—'}</td><td class="num">${r.rel ? r.rel + ' 以上' : '—'}</td></tr>`).join('');

  // 施策の分類
  const pfs = Object.values(PLATFORMS);
  $('#category-tables').innerHTML = CATEGORIES.map((cat, i) => {
    const list = MEASURES.filter((m) => m.cat === cat.id);
    const notes = [];
    const rows = list.map((m) => {
      const cells = pfs.map((pf) => {
        const na = measureNa(m, pf.id);
        if (na && !(m.only && !m.only.includes(pf.id))) notes.push(`${measureName(m, pf.id)}（${pf.name}）: ${na}`);
        return `<td class="num">${na ? '—' : '○'}</td>`;
      }).join('');
      return `<tr><td><div class="mname">${esc(measureName(m, 'ecs'))}${TRAPS.includes(m.id) ? ' <span class="trap-mark">注意</span>' : ''}</div>
        <div class="mdesc">${esc(measureDesc(m, 'ecs'))}</div><div class="mref">${m.refs.map((r) => `<span>${esc(r)}</span>`).join('')}</div></td>
        <td class="num">${m.effort}</td>${cells}</tr>`;
    }).join('');
    return `<div class="cat" id="cat-${cat.id}">
      <h3>5-${i + 1}. ${esc(cat.name)} <span class="cat-ref">${esc(cat.ref)}</span></h3>
      <p>${esc(cat.desc)}</p>
      <table class="tbl"><thead><tr><th>施策</th><th class="num">工数</th>${pfs.map((pf) => `<th class="num">${esc(pf.name.split(' ')[0])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      ${notes.length ? `<ul class="small muted">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('');

  // プラットフォーム別の試算
  $('#platform-table').innerHTML = pfs.map((pf) => {
    const b = costOf(pf.id, []).total;
    const a = costOf(pf.id, DOC_PLAN[pf.id]).total;
    return `<tr><td>${esc(pf.name)}</td><td class="num">${fmtUsd(b)}</td><td class="num">${fmtUsd(a)}</td><td class="num">${((1 - a / b) * 100).toFixed(1)}%</td><td class="num">${fmtUsd(pf.docBefore)} → ${fmtUsd(pf.docAfter)}</td></tr>`;
  }).join('');
})();
