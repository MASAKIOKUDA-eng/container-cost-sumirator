'use strict';

// 1 年間を四半期（3 か月）ごとに 4 回に分けて進める
const QUARTERS = 4;
const EFFORT_PER_QUARTER = 6; // 2 名 × 3 か月
const ICON = (name) => `assets/icons/${name}.svg`;
const qName = (q) => `第${q}四半期`;
const qRange = (q) => `${(q - 1) * 3 + 1}〜${q * 3}か月目`;

let S = null; // ゲーム状態

function newGame(platform) {
  S = {
    platform,
    quarter: 1,
    applied: new Set(),
    appliedAt: {},
    pending: new Set(),
    spCommit: null,
    spReported: null,
    eksExtended: false,
    reliability: 100,
    shutdownIncidents: false,
    briefing: [],
    log: [],
    history: [],
  };
  S.baseline = computeCost(S).total;
  S.history.push({ label: '開始', total: S.baseline });
  show('game');
  quarterBriefing();
  render();
}

function quarterBriefing() {
  const q = S.quarter;
  const p = S.platform;
  const b = [];
  if (q === 1) {
    b.push({ who: 'cfo', text: `先月のコンテナ基盤の請求は ${fmtUsd(S.baseline)}（${fmtJpy(S.baseline)}）。1 年かけてでいいので、きちんと下げてほしい。` });
    b.push({ who: 'pm', text: `1 四半期に使える工数は ${EFFORT_PER_QUARTER}（2 名 × 3 か月）。全部はできないから、順番を決めて進めよう。` });
    b.push({ who: 'po', text: 'コストを下げるのは賛成。ただ、利用者に迷惑がかかる障害だけは避けてほしい。' });
  } else if (q === 2) {
    if (p === 'eks') b.push({ who: 'pm', text: 'EKS の現行バージョンは、この四半期の終わりで標準サポートが切れる。更新を計画に入れておいて。' });
    b.push({ who: 'po', text: 'ステージングと開発が、夜間も休日も 24 時間動いていると聞いた。誰も使っていない時間は止められない？' });
  } else if (q === 3) {
    b.push({ who: 'tl', text: 'Spot やオートスケーリングを使うなら、タスクが止められたときの振る舞い（SIGTERM）を先に確認したい。' });
    if (hasApplied('visibility')) b.push({ who: 'cfo', text: '内訳が見えるようになって助かる。効果の大きいところから手を付けてほしい。' });
    else b.push({ who: 'cfo', text: '請求書には合計しか載っていない。何にいくらかかっているのか、説明できるようにしてほしい。' });
  } else {
    b.push({ who: 'cfo', text: '来年度の予算は、この四半期末の月額で決める。' });
    b.push({ who: 'pm', text: '最後の四半期。工数は今期で使い切ろう。' });
  }
  S.briefing = b;
  b.forEach((m) => pushLog('info', m.text, 0, m.who));
}

// ---- 状態の問い合わせ ----
const hasApplied = (id) => S.applied.has(id);
const hasAny = (id) => S.applied.has(id) || S.pending.has(id);
const effortUsed = () => [...S.pending].reduce((a, id) => a + MEASURE_BY_ID[id].effort, 0);
const current = () => computeCost(S);

function availability(m) {
  const p = S.platform;
  const na = measureNa(m, p);
  if (na) return { ok: false, reason: na };
  if (hasApplied(m.id)) return { ok: false, reason: `${qName(S.appliedAt[m.id])}に導入済み`, done: true };
  if (m.excludes && m.excludes.some(hasAny)) return { ok: false, reason: `「${measureName(MEASURE_BY_ID[m.excludes[0]], p)}」と同時に選べない` };
  if (m.requires && !m.requires.every(hasAny)) return { ok: false, reason: `前提: ${m.requires.map((r) => measureName(MEASURE_BY_ID[r], p)).join('、')}` };
  if (!S.pending.has(m.id) && effortUsed() + m.effort > EFFORT_PER_QUARTER) return { ok: false, reason: 'この四半期の工数が足りない' };
  return { ok: true };
}

// 現在の状態（この四半期の選択を含む）に施策を 1 つ加えたときの月額差
function estimateDelta(id) {
  const withPending = new Set([...S.applied, ...S.pending]);
  const base = { ...S, applied: withPending };
  if (withPending.has('sp') && S.spCommit === null) base.spCommit = prodUsage(S.platform, (x) => withPending.has(x));
  const before = computeCost(base).total;
  const next = new Set(withPending);
  if (next.has(id)) next.delete(id); else next.add(id);
  const alt = { ...base, applied: next };
  if (id === 'sp' && !withPending.has('sp')) alt.spCommit = prodUsage(S.platform, (x) => next.has(x));
  const after = computeCost(alt).total;
  return withPending.has(id) ? before - after : after - before;
}

// ---- 操作 ----
function togglePending(id) {
  if (S.pending.has(id)) {
    S.pending.delete(id);
    // 前提を失った施策も外す
    for (const pid of [...S.pending]) {
      const m = MEASURE_BY_ID[pid];
      if (m.requires && !m.requires.every(hasAny)) S.pending.delete(pid);
    }
  } else if (availability(MEASURE_BY_ID[id]).ok) {
    S.pending.add(id);
  }
  render();
}

function endQuarter() {
  const q = S.quarter;
  const p = S.platform;
  const before = current().total;
  const leftover = EFFORT_PER_QUARTER - effortUsed();
  const newly = [...S.pending];
  newly.forEach((id) => { S.applied.add(id); S.appliedAt[id] = q; });
  S.pending.clear();
  const events = [];
  let drop = 0;
  const ev = (who, kind, text, rel = 0) => {
    if (rel < 0) drop += rel;
    if (rel) {
      const prev = S.reliability;
      S.reliability = Math.min(100, Math.max(0, S.reliability + rel));
      rel = S.reliability - prev; // 上限・下限で丸めた実際の増減
    }
    events.push({ who, kind, text, rel });
  };
  const isNew = (id) => newly.includes(id);

  if (newly.length === 0) ev('pm', 'info', 'この四半期は何も導入しなかった。工数は翌期に持ち越せない。');
  else if (leftover > 0) ev('pm', 'info', `工数が ${leftover} 余った。工数は翌期に持ち越せない。`);

  if (isNew('sp')) {
    S.spCommit = prodUsage(p, hasApplied);
    S.spReported = S.spCommit;
    ev('cfo', 'info', `Savings Plans の契約を承認した。コミット額は今の本番利用額 ${fmtUsd(S.spCommit)}/月 の 80%（${fmtUsd(S.spCommit * PRICE.spRate)}/月）で 1 年間固定になる。`);
  }
  if (isNew('visibility')) {
    const it = current().items;
    const top = COST_ITEMS.map((c) => ({ ...c, v: it[c.id] })).sort((a, b) => b.v - a.v).slice(0, 2);
    ev('cfo', 'good', `内訳が見えるようになった。大きいのは「${top[0].name}」${fmtUsd(top[0].v)} と「${top[1].name}」${fmtUsd(top[1].v)} だね。`);
  }
  if (isNew('rightsize') && !hasApplied('visibility')) {
    ev('po', 'bad', 'ピーク時に API がメモリ不足で再起動して、利用者から問い合わせが来た。サイズはメトリクスを見て決めてほしい（COST06）。', RELIABILITY.noMetricsRightsize);
  }
  if (isNew('prodSpot')) {
    ev('po', 'bad', '本番まで Spot にしたの？ 中断が重なったら本番の処理能力が落ちる。Spot は中断に強いバッチや開発・ステージング向けのはず。', RELIABILITY.prodSpot);
  }
  if (isNew('natSingle')) {
    ev('tl', 'bad', 'NAT ゲートウェイが 1 台だと、その AZ が落ちたら本番も外に出られない。資料の試算でも本番は 2 台で冗長性を残している。', RELIABILITY.natSingle);
  }
  if (isNew('ecrIf')) {
    const d = computeCost(S).items.endpoint;
    ev('cfo', 'bad', `エンドポイントの請求が ${fmtUsd(d)}/月 増えている。時間料金が AZ 単位でかかるので、NAT 経由が月約 790GB を超えるまでは NAT の方が安いらしい。` +
      (hasApplied('s3gw') ? ' イメージ取得はすでに S3 ゲートウェイエンドポイントで NAT から外れている。' : ''));
  }
  if (isNew('azOpt')) {
    ev('tl', 'info', `AZ 間転送は月 ${fmtUsd(TRAFFIC.azGb * 0.6 * PRICE.azGb)} 減った。この規模だと効果は小さいので、品質上の理由がなければ後回しでもよかった。`);
  }
  if (isNew('consolidate')) {
    ev('pm', 'good', '非本番環境を集約できた。共有 VPC になったので、NAT ゲートウェイの台数も見直せる。');
  }
  if (isNew('sigterm') && S.shutdownIncidents) {
    S.shutdownIncidents = false;
    ev('tl', 'good', 'SIGTERM を受けたら処理を終えてから止まるようにした。中断やスケールインで処理が切れる障害は、これで止まるはず。', RELIABILITY.sigtermFix);
  }

  if (hasApplied('spotNonprod') && !hasApplied('sigterm')) {
    S.shutdownIncidents = true;
    ev('tl', 'bad', 'Spot の中断通知（2 分前）を処理できず、ステージングのジョブが途中で落ちた。SIGTERM 対応が前提（CONTAINER_BUILD_COST_05）。', RELIABILITY.spotNoSigterm);
  }
  if (hasApplied('prodSpot') && !hasApplied('sigterm')) {
    S.shutdownIncidents = true;
    ev('po', 'bad', '本番タスクが Spot の中断で強制終了して、処理中のリクエストが失敗した。', RELIABILITY.prodSpotNoSigterm);
  }
  if (hasApplied('rightsize') && !hasApplied('sigterm')) {
    S.shutdownIncidents = true;
    ev('po', 'bad', 'スケールインのたびに、処理中のリクエストが切断されている。', RELIABILITY.scaleInNoSigterm);
  }

  if (p === 'eks') {
    if (q === 2 && !hasApplied('eksUpgrade')) {
      S.eksExtended = true;
      const n = hasApplied('consolidate') ? 2 : 3;
      ev('cfo', 'bad', `EKS が延長サポート（$0.60/時）に切り替わって、${n} クラスタで月 ${fmtUsd(n * 0.5 * PRICE.H)} 増えた。どういうこと？`);
    } else if (S.eksExtended && hasApplied('eksUpgrade')) {
      S.eksExtended = false;
      ev('tl', 'good', 'バージョンを更新して、標準サポート料金に戻した。');
    } else if (isNew('eksUpgrade')) {
      ev('pm', 'good', '標準サポートが切れる前にバージョンを更新できた。延長サポート料金を回避。');
    }
  }

  if (hasApplied('sp') && !isNew('sp')) {
    const usage = prodUsage(p, hasApplied);
    if (usage < S.spReported - 0.5) {
      const waste = (S.spCommit - usage) * PRICE.spRate;
      ev('cfo', 'bad', `本番の利用額は ${fmtUsd(usage)}/月 に下がったのに、Savings Plans は購入時の ${fmtUsd(S.spCommit)}/月 基準のまま。月 ${fmtUsd(waste)} 分のコミットが余っている。サイズを先に見直すべきだった。`);
      S.spReported = usage;
    }
  }

  if (drop === 0 && S.reliability < 100) {
    ev('po', 'good', `この四半期は障害がなかった。振り返りと改善が進んで、運用が安定してきた。`, RELIABILITY.quietQuarter);
  }

  const after = current().total;
  S.history.push({ label: `Q${q}`, total: after });
  events.forEach((e) => pushLog(e.kind, e.text, e.rel, e.who));
  const summary = `月額 ${fmtUsd(before)} → ${fmtUsd(after)}（${after <= before ? '−' : '+'}${fmtUsd(Math.abs(before - after))}）　信頼性スコア ${S.reliability}`;

  showDialog(`${qName(q)}（${qRange(q)}）の結果`, summary, events, () => {
    if (q >= QUARTERS) { showResult(); return; }
    S.quarter += 1;
    quarterBriefing();
    render();
  });
  render();
}

function pushLog(kind, text, rel = 0, who = null) {
  S.log.unshift({ quarter: S.quarter, kind, text, rel, who });
}

// ---- 描画 ----
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const relText = (rel) => (rel ? ` <b class="${rel > 0 ? 'plus' : ''}">信頼性 ${rel > 0 ? '+' : ''}${rel}</b>` : '');

function avatar(who, size = 'md') {
  if (!who) return '';
  const c = CHARACTERS[who];
  return `<img class="avatar ${size}" src="${c.img}" alt="${esc(c.role)} ${esc(c.name)}">`;
}

function show(screen) {
  for (const id of ['title', 'game', 'result', 'shared']) $('#' + id).hidden = id !== screen;
  document.body.dataset.screen = screen;
  window.scrollTo(0, 0);
}

function render() {
  const pf = PLATFORMS[S.platform];
  const c = current();
  const reduction = 1 - c.total / S.baseline;
  $('#hdr-platform').innerHTML = `<img src="${ICON(pf.icon)}" alt=""> ${esc(pf.name)}`;
  $('#hdr-quarter').textContent = `${qName(S.quarter)}（${qRange(S.quarter)}）`;
  $('#m-total').textContent = fmtUsd(c.total);
  $('#m-total-sub').textContent = fmtJpy(c.total) + ' / 月';
  $('#m-red').textContent = (reduction * 100).toFixed(1) + '%';
  $('#m-red-sub').textContent = `開始時 ${fmtUsd(S.baseline)}`;
  $('#m-rel').textContent = S.reliability;
  $('#m-rel').className = 'metric-value ' + (S.reliability >= 90 ? '' : S.reliability >= 70 ? 'warn' : 'bad');
  $('#m-effort').textContent = `${EFFORT_PER_QUARTER - effortUsed()} / ${EFFORT_PER_QUARTER}`;
  $('#m-period').textContent = `${S.quarter} / ${QUARTERS}`;
  renderTimeline();
  renderBriefing();
  renderDiagram();
  renderBreakdown(c);
  renderHistory();
  renderMeasures();
  renderLog();
  $('#btn-end').textContent = S.quarter >= QUARTERS ? `${qName(S.quarter)}を終えて 1 年間の結果を見る` : `${qName(S.quarter)}を終える`;
  $('#pending-note').textContent = S.pending.size
    ? `選択中 ${S.pending.size} 件・工数 ${effortUsed()} / ${EFFORT_PER_QUARTER}`
    : '施策が選ばれていません';
}

function renderTimeline() {
  $('#timeline').innerHTML = Array.from({ length: QUARTERS }, (_, i) => {
    const q = i + 1;
    const st = q < S.quarter ? 'past' : q === S.quarter ? 'now' : '';
    return `<li class="${st}" ${q === S.quarter ? 'aria-current="step"' : ''}><span class="tq">Q${q}</span><span class="tr">${qRange(q)}</span></li>`;
  }).join('');
}

function renderBriefing() {
  $('#briefing').innerHTML = S.briefing.map((m) => `
    <li class="say">${avatar(m.who)}
      <div class="bubble"><div class="who">${esc(charLabel(m.who))}</div><p>${esc(m.text)}</p></div>
    </li>`).join('');
}

function renderBreakdown(c) {
  const visible = hasApplied('visibility');
  const base = costOf(S.platform, []).items;
  const max = Math.max(...COST_ITEMS.map((i) => Math.max(base[i.id], c.items[i.id])), 1);
  const rows = COST_ITEMS.filter((i) => base[i.id] > 0 || c.items[i.id] > 0).map((i) => {
    if (!visible) return `<tr><td>${esc(i.name)}</td><td class="num muted">—</td><td></td></tr>`;
    const v = c.items[i.id];
    const b = base[i.id];
    const cls = v > b + 0.05 ? 'up' : v < b - 0.05 ? 'down' : '';
    return `<tr><td>${esc(i.name)}</td><td class="num ${cls}">${fmtUsd(v)}</td>
      <td class="barcell"><div class="bar base" style="width:${(b / max) * 100}%"></div><div class="bar now ${cls}" style="width:${(v / max) * 100}%"></div></td></tr>`;
  }).join('');
  $('#breakdown').innerHTML = `
    ${visible ? '' : '<p class="notice">請求書には合計額しか載っていない。内訳を見るには「Cost Explorer / CUR でコストを可視化」を導入する。</p>'}
    <table class="tbl"><thead><tr><th>項目</th><th class="num">月額</th><th>${visible ? '<span class="lg base"></span>開始時 <span class="lg now"></span>現在' : ''}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>合計</td><td class="num">${fmtUsd(c.total)}</td><td></td></tr></tfoot></table>`;
}

function renderHistory() {
  const h = S.history;
  const W = 320, Hh = 120, pad = 28;
  const max = Math.max(...h.map((x) => x.total)) * 1.1;
  const bw = (W - pad) / (QUARTERS + 1);
  const bars = Array.from({ length: QUARTERS + 1 }, (_, i) => {
    const x = pad + i * bw + bw * 0.2;
    const lbl = i === 0 ? '開始' : `Q${i}末`;
    const it = h[i];
    if (!it) return `<text x="${x + bw * 0.3}" y="${Hh - 4}" class="ax" text-anchor="middle">${lbl}</text>`;
    const bh = (it.total / max) * (Hh - 24);
    return `<rect x="${x}" y="${Hh - 16 - bh}" width="${bw * 0.6}" height="${bh}" class="${i === 0 ? 'hb0' : 'hb'}"/>
      <text x="${x + bw * 0.3}" y="${Hh - 20 - bh}" class="val" text-anchor="middle">${Math.round(it.total).toLocaleString()}</text>
      <text x="${x + bw * 0.3}" y="${Hh - 4}" class="ax" text-anchor="middle">${lbl}</text>`;
  }).join('');
  $('#history').innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="月額の推移"><line x1="${pad}" x2="${W}" y1="${Hh - 16}" y2="${Hh - 16}" class="axis"/>${bars}<text x="0" y="12" class="ax">USD/月</text></svg>`;
}

function renderMeasures() {
  const p = S.platform;
  const visible = hasApplied('visibility');
  let html = '';
  CATEGORIES.forEach((cat, ci) => {
    const list = MEASURES.filter((m) => m.cat === cat.id && (!m.only || m.only.includes(p)));
    if (!list.length) return;
    html += `<tbody><tr class="phase"><th colspan="5">${ci + 1}. ${esc(cat.name)}<span>${esc(cat.ref)}</span></th></tr>`;
    for (const m of list) {
      const av = availability(m);
      const sel = S.pending.has(m.id);
      const na = measureNa(m, p);
      let est = '';
      if (na) est = '';
      else if (av.done) est = '<span class="muted">導入済み</span>';
      else if (!visible) est = '<span class="muted">不明</span>';
      else {
        const d = estimateDelta(m.id);
        est = Math.abs(d) < 0.05 ? '<span class="muted">±$0</span>'
          : d < 0 ? `<span class="down">−${fmtUsd(-d)}</span>` : `<span class="up">+${fmtUsd(d)}</span>`;
      }
      const disabled = !sel && !av.ok;
      html += `<tr class="m ${sel ? 'sel' : ''} ${av.done ? 'done' : ''} ${na ? 'na' : ''}" data-id="${m.id}" ${disabled ? 'aria-disabled="true"' : 'tabindex="0"'}>
        <td class="chk"><input type="checkbox" ${sel || av.done ? 'checked' : ''} ${disabled || av.done ? 'disabled' : ''} aria-label="${esc(measureName(m, p))}"></td>
        <td class="ic"><img src="${ICON(m.icon)}" alt=""></td>
        <td><div class="mname">${esc(measureName(m, p))}</div>
          <div class="mdesc">${esc(measureDesc(m, p))}</div>
          <div class="mref">${m.refs.map((r) => `<span>${esc(r)}</span>`).join('')}${!av.ok && !av.done ? `<em>${esc(av.reason)}</em>` : ''}</div></td>
        <td class="num effort">${m.effort}</td>
        <td class="num est">${est}</td></tr>`;
    }
    html += '</tbody>';
  });
  $('#measures').innerHTML = `<thead><tr><th></th><th></th><th>施策</th><th class="num">工数</th><th class="num">試算（月）</th></tr></thead>${html}`;
  $('#measures').querySelectorAll('tr.m').forEach((tr) => {
    if (tr.getAttribute('aria-disabled') === 'true' || tr.classList.contains('done')) return;
    tr.addEventListener('click', () => togglePending(tr.dataset.id));
    tr.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePending(tr.dataset.id); } });
  });
}

function renderLog() {
  $('#log').innerHTML = S.log.slice(0, 40).map((l) =>
    `<li class="${l.kind}"><span class="ls">Q${l.quarter}</span>${avatar(l.who, 'sm')}<span class="lt">${l.who ? `<span class="lw">${esc(CHARACTERS[l.who].role)}</span>` : ''}${esc(l.text)}${relText(l.rel)}</span></li>`).join('');
}

// 構成図
function renderDiagram() {
  const p = S.platform;
  const pf = PLATFORMS[p];
  const has = hasApplied;
  const cons = has('consolidate');
  const nat = has('natSingle') ? 1 : has('natReduce') ? 3 : 6;
  const node = (icon, label, extra = '') => `<div class="node ${extra}"><img src="${ICON(icon)}" alt=""><span>${label}</span></div>`;
  const tag = (t, cls = '') => `<span class="tag ${cls}">${t}</span>`;

  const prodCompute = (() => {
    const tags = [];
    if (has('graviton')) tags.push(tag('ARM'));
    if (has('rightsize')) tags.push(tag('Auto Scaling'));
    if (has('sp')) tags.push(tag('Savings Plans'));
    if (has('rosaContract')) tags.push(tag('1 年契約'));
    if (has('prodSpot')) tags.push(tag('Spot', 'risk'));
    let label;
    if (p === 'ecs') label = has('rightsize') ? 'Web 2・API 2〜4・Worker 1<br>平均 4vCPU / 8GB' : 'Web 2・API 4・Worker 2<br>6vCPU / 12GB';
    else if (p === 'eks') label = (has('graviton') ? 'm7g' : 'm6i') + (has('rightsize') ? '.large' : '.xlarge') + ' × 3';
    else label = 'm5.xlarge × 3';
    return node(pf.computeIcon, label) + `<div class="tags">${tags.join('')}</div>`;
  })();

  const npCompute = (envLabel, share) => {
    const tags = [];
    if (has('schedule')) tags.push(tag('平日 10h のみ'));
    if (has('spotNonprod')) tags.push(tag('Spot'));
    if (has('graviton')) tags.push(tag('ARM'));
    let label;
    if (p === 'ecs') label = `${has('rightsize') ? 2 : 3}vCPU / ${has('rightsize') ? 4 : 6}GB` + (share ? ' × 2 環境' : '');
    else if (p === 'eks') label = (has('graviton') ? 'm7g' : 'm6i') + (has('rightsize') ? '.large × 1' : '.xlarge × 2') + (share ? ' × 2 環境' : '');
    else label = cons ? 'm5.xlarge × 2（単一 AZ）' : 'm5.xlarge × 3';
    const icon = has('spotNonprod') ? 'spot-instance' : pf.computeIcon;
    return node(icon, label, has('schedule') ? 'sleep' : '') + `<div class="tags">${tags.join('')}</div>`;
  };

  const clusterTag = () => {
    if (p === 'ecs') return '';
    if (p === 'eks' && S.eksExtended) return `<div class="cluster ext">${node('eks', 'EKS 延長サポート $0.60/時')}</div>`;
    return `<div class="cluster">${node(pf.icon, p === 'eks' ? 'EKS クラスタ' : 'ROSA クラスタ')}</div>`;
  };

  const vpc = (title, natN, compute, opts = {}) => `
    <div class="grp vpc ${opts.cls || ''}">
      <div class="grp-h"><img src="${ICON('group-vpc')}" alt=""> ${title}</div>
      <div class="vpc-row">
        <div class="sub pub"><div class="sub-h">Public subnet</div>
          <div class="nodes">${node('alb', opts.albLabel || 'ALB')}${natN ? Array.from({ length: natN }, () => node('nat-gateway', 'NAT')).join('') : '<span class="muted small">NAT なし</span>'}</div>
        </div>
        <div class="sub priv"><div class="sub-h">Private subnet</div>
          ${clusterTag()}
          <div class="nodes col">${compute}</div>
          <div class="nodes">${has('s3gw') ? node('vpc-endpoints', 'S3 GW EP') : ''}${has('ecrIf') ? node('vpc-endpoints', 'ECR IF EP × 2', 'warn') : ''}</div>
        </div>
      </div>
    </div>`;

  let vpcs;
  if (cons) {
    const prodNat = nat === 1 ? 1 : 2;
    const npNat = nat === 1 ? 0 : nat === 3 ? 1 : 4;
    vpcs = vpc('本番 VPC（2AZ）', prodNat, prodCompute) +
      vpc('非本番 VPC（ステージング＋開発で共有）', npNat, npCompute('', true), { albLabel: 'ALB（ホスト名で共有）', cls: has('schedule') ? 'dim' : '' });
  } else {
    vpcs = vpc('本番 VPC（2AZ）', 2, prodCompute) +
      vpc('ステージング VPC', 2, npCompute('stg'), { cls: has('schedule') ? 'dim' : '' }) +
      vpc('開発 VPC', 2, npCompute('dev'), { cls: has('schedule') ? 'dim' : '' });
  }

  const ecrGb = Math.round(TRAFFIC.ecrStoreGb * (has('ecrLifecycle') ? 0.2 : 1) * (has('imageSlim') ? 0.25 : 1));
  const tools = [];
  if (has('visibility')) tools.push(node('cost-explorer', 'Cost Explorer'), node('cur', 'CUR'));
  if (has('sp')) tools.push(node('savings-plans', 'Savings Plans'));

  $('#diagram').innerHTML = `
    <div class="grp cloud">
      <div class="grp-h"><img src="${ICON('group-aws-cloud')}" alt=""> AWS Cloud</div>
      <div class="cloud-top">
        ${node('users', '利用者 1,000 名')}
        ${tools.length ? `<div class="tools">${tools.join('')}</div>` : ''}
      </div>
      <div class="grp region">
        <div class="grp-h"><img src="${ICON('group-region')}" alt=""> 東京リージョン ap-northeast-1</div>
        <div class="region-top">
          ${node('ecr', `ECR ${ecrGb}GB`)}${node('s3', 'S3（レイヤー配信）')}
          ${has('sigterm') ? node('ecs-task', 'SIGTERM 対応済み') : ''}
          ${has('imageSlim') || has('graviton') ? node('codebuild', has('graviton') ? 'マルチアーキビルド' : '軽量イメージ') : ''}
        </div>
        <div class="vpcs ${cons ? 'two' : 'three'}">${vpcs}</div>
      </div>
    </div>`;
}

// ---- ダイアログ ----
function showDialog(title, summary, events, onClose) {
  const d = $('#dialog');
  $('#dlg-title').textContent = title;
  $('#dlg-summary').textContent = summary;
  $('#dlg-body').innerHTML = events.length
    ? events.map((e) => `<li class="say ${e.kind}">${avatar(e.who)}
        <div class="bubble"><div class="who">${esc(charLabel(e.who))}</div><p>${esc(e.text)}${relText(e.rel)}</p></div></li>`).join('')
    : '<li class="quiet">特に報告はなかった。</li>';
  $('#dlg-ok').textContent = S.quarter >= QUARTERS ? '1 年間の結果を見る' : `${qName(S.quarter + 1)}へ`;
  $('#dlg-ok').onclick = () => { d.close(); onClose(); };
  d.showModal();
}

// ---- 結果 ----
function showResult() {
  const p = S.platform;
  const pf = PLATFORMS[p];
  const c = current();
  const ref = costOf(p, DOC_PLAN[p]);
  const saved = S.baseline - c.total;
  const refSaved = S.baseline - ref.total;
  const achieve = saved / refSaved;
  const rel = S.reliability;
  const rank = rankOf(achieve, rel);
  const comment = {
    S: { who: 'cfo', text: rel >= 100 ? '資料の推奨プランと同じ水準まで下がった。しかも障害なし。来年度の予算はこれでいこう。' : '資料の推奨プランと同じ水準まで下がった。途中の障害も立て直せたね。来年度の予算はこれでいこう。' },
    A: { who: 'cfo', text: 'かなり下がった。順番や前提条件を見直せば、まだ伸ばせそうだね。' },
    B: { who: 'po', text: 'コストは下がったけれど、効果の大きい施策の取りこぼしか、障害の影響が気になる。' },
    C: { who: 'pm', text: '削減が足りないか、障害が多すぎた。次は可視化から順番に進めよう。' },
  }[rank];

  const done = DOC_PLAN[p].map((id) => {
    const m = MEASURE_BY_ID[id];
    const at = S.appliedAt[id];
    return `<tr><td>${esc(measureName(m, p))}</td><td>${esc(CATEGORY_BY_ID[m.cat].name)}</td><td class="num">${at ? 'Q' + at : '<span class="up">未導入</span>'}</td></tr>`;
  }).join('');
  const extras = [...S.applied].filter((id) => !DOC_PLAN[p].includes(id)).map((id) =>
    `<tr><td>${esc(measureName(MEASURE_BY_ID[id], p))}</td><td class="num">Q${S.appliedAt[id]}</td></tr>`).join('');

  $('#result-body').innerHTML = `
    <div class="result-head">
      <div class="rank rank-${rank}">${rank}</div>
      <div><h2>${esc(pf.name)}・1 年間の結果</h2>
        <div class="say inline">${avatar(comment.who)}<div class="bubble"><div class="who">${esc(charLabel(comment.who))}</div><p>${esc(comment.text)}</p></div></div>
      </div>
    </div>
    <table class="tbl kv">
      <tr><th>開始時の月額</th><td class="num">${fmtUsd(S.baseline)}</td><td>${fmtJpy(S.baseline)}</td></tr>
      <tr><th>1 年後の月額</th><td class="num">${fmtUsd(c.total)}</td><td>${fmtJpy(c.total)}</td></tr>
      <tr><th>削減率</th><td class="num">${((saved / S.baseline) * 100).toFixed(1)}%</td><td>年間 ${fmtUsd(saved * 12)}（${fmtJpy(saved * 12)}）</td></tr>
      <tr><th>資料の推奨プラン</th><td class="num">${fmtUsd(ref.total)}</td><td>削減率 ${((refSaved / S.baseline) * 100).toFixed(1)}%（資料の試算: ${fmtUsd(pf.docBefore)} → ${fmtUsd(pf.docAfter)}）</td></tr>
      <tr><th>推奨プラン比の達成率</th><td class="num">${(achieve * 100).toFixed(0)}%</td><td></td></tr>
      <tr><th>信頼性スコア</th><td class="num">${rel}</td><td>${rel >= 90 ? '問題なし' : '障害や冗長性の低下が発生した'}（<a href="guide.html#reliability" target="_blank" rel="noopener">スコアの説明</a>）</td></tr>
    </table>
    <h3>資料の推奨施策と導入した四半期</h3>
    <table class="tbl"><thead><tr><th>施策</th><th>分類</th><th class="num">導入</th></tr></thead><tbody>${done}</tbody></table>
    ${extras ? `<h3>推奨プラン外で導入した施策</h3><table class="tbl"><tbody>${extras}</tbody></table>` : ''}
    <p class="small">施策ごとの解説と、この規模での判断ポイントは <a href="guide.html#points" target="_blank" rel="noopener">解説ページ</a> にまとめている。</p>`;
  $('#share-text').value = shareText({ platformId: p, rank, before: S.baseline, after: c.total, rel });
  updateShareCount();
  show('result');
}

// ---- X でポスト ----
const PUBLIC_URL = 'https://masakiokuda-eng.github.io/container-cost-sumirator/';

function gameUrl() {
  const local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local ? PUBLIC_URL : location.origin + location.pathname;
}

// 結果ページの URL（開くとその結果が表示される）
function resultUrl(r) {
  const q = new URLSearchParams({ p: r.platformId, rank: r.rank, b: r.before.toFixed(1), a: r.after.toFixed(1), rel: String(r.rel) });
  return gameUrl() + '?' + q.toString();
}

const shareRate = (r) => (((r.before - r.after) / r.before) * 100).toFixed(1);
const shareYearMan = (r) => Math.round(((r.before - r.after) * 12 * PRICE.usdJpy) / 10000).toLocaleString();

// ポストの文面（ここを書き換えると文面が変わる）
function shareText(r) {
  return [
    '💰🦈コンテナコスト削減シミュレーター🦈💰',
    '',
    `コンテナコスト削減シミュレーターで ${PLATFORMS[r.platformId].name} に挑戦しました。`,
    `ランク ${r.rank}｜月額 ${fmtUsd(r.before)} → ${fmtUsd(r.after)}（${shareRate(r)}% 削減）`,
    `年間 約${shareYearMan(r)}万円の削減、信頼性スコア ${r.rel}`,
    resultUrl(r),
    '',
    '#jawsug #jawsug_sre',
  ].join('\n');
}

// 共有された結果ページ（?p=ecs&rank=S&b=987.7&a=366.4&rel=100）
function parseSharedResult() {
  const q = new URLSearchParams(location.search);
  const r = { platformId: q.get('p'), rank: q.get('rank'), before: Number(q.get('b')), after: Number(q.get('a')), rel: Number(q.get('rel')) };
  if (!PLATFORMS[r.platformId] || !['S', 'A', 'B', 'C'].includes(r.rank)) return null;
  if (![r.before, r.after, r.rel].every(Number.isFinite) || r.before <= 0 || r.after < 0 || r.rel < 0 || r.rel > 100) return null;
  return r;
}

function showSharedResult(r) {
  const pf = PLATFORMS[r.platformId];
  $('#shared-body').innerHTML = `
    <div class="result-head">
      <div class="rank rank-${r.rank}">${r.rank}</div>
      <div><h2>${esc(pf.name)} に挑戦した結果</h2><p>コンテナコスト削減シミュレーターのプレイ結果です。</p></div>
    </div>
    <table class="tbl kv">
      <tr><th>月額</th><td class="num">${fmtUsd(r.before)} → ${fmtUsd(r.after)}</td><td>${shareRate(r)}% 削減</td></tr>
      <tr><th>年間の削減額</th><td class="num">約${shareYearMan(r)}万円</td><td>1 ドル = 150 円で換算</td></tr>
      <tr><th>信頼性スコア</th><td class="num">${r.rel}</td><td>100 から開始</td></tr>
    </table>`;
  document.title = `ランク ${r.rank}｜${pf.name}｜コンテナコスト削減シミュレーター`;
  show('shared');
}

// X の文字数（全角は 2、URL は 23 として数える）
function weightedLength(text) {
  const noUrl = text.replace(/https?:\/\/\S+/g, '');
  const urls = (text.match(/https?:\/\/\S+/g) || []).length;
  let n = urls * 23;
  for (const ch of noUrl) {
    const cp = ch.codePointAt(0);
    n += (cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) ? 1 : 2;
  }
  return n;
}

function updateShareCount() {
  const n = weightedLength($('#share-text').value);
  $('#share-count').textContent = `${n} / 280`;
  $('#share-count').classList.toggle('up', n > 280);
}

function postToX() {
  const url = 'https://x.com/intent/post?text=' + encodeURIComponent($('#share-text').value);
  window.open(url, '_blank', 'noopener,noreferrer,width=600,height=520');
}

async function copyShareText() {
  const btn = $('#btn-copy');
  try {
    await navigator.clipboard.writeText($('#share-text').value);
    btn.textContent = 'コピーしました';
  } catch {
    $('#share-text').select();
    btn.textContent = '選択しました（Ctrl+C でコピー）';
  }
  setTimeout(() => { btn.textContent = '文面をコピー'; }, 2000);
}

// ---- タイトル ----
function renderTitle() {
  const eks = costOf('eks', []);
  const eksRef = costOf('eks', DOC_PLAN.eks);
  const it = eks.items;
  const lines = [
    { icon: 'nat-gateway', name: 'NAT ゲートウェイ × 6', v: it.nat },
    { icon: 'eks', name: 'コントロールプレーン × 3', v: it.cp },
    { icon: 'ec2-instance', name: '本番コンピュート', v: it.prod },
    { icon: 'ec2-instance', name: '非本番コンピュート（24 時間稼働）', v: it.nonprod },
    { icon: 'alb', name: 'ALB × 3', v: it.alb },
    { icon: 'ecr', name: 'ECR・データ転送', v: it.ecr + it.az + it.inet + it.endpoint },
  ];
  $('#invoice-lines').innerHTML = lines.map((l) =>
    `<li><img src="${ICON(l.icon)}" alt=""><span>${esc(l.name)}</span><span class="num">${fmtUsd(l.v)}</span></li>`).join('');
  $('#invoice-total').textContent = fmtUsd(eks.total);
  $('#hero-bill').textContent = fmtUsd(eks.total);
  $('#invoice-target').textContent = `−${Math.round((1 - eksRef.total / eks.total) * 100)}%`;

  $('#people').innerHTML = Object.values(CHARACTERS).map((c) => `
    <article class="person">
      <img src="${c.img}" alt="${esc(c.role)} ${esc(c.name)}のイラスト">
      <div><div class="person-role">${esc(c.role)}</div><div class="person-name">${esc(c.name)}</div></div>
      <p>${esc(c.desc)}</p>
      <div class="person-focus"><span>関心: ${esc(c.focus)}</span></div>
    </article>`).join('');

  $('#platforms').innerHTML = Object.values(PLATFORMS).map((pf) => `
    <article class="pf">
      <div class="pf-head"><img src="${ICON(pf.icon)}" alt=""><h3>${esc(pf.name)}</h3></div>
      <p>${esc(pf.blurb)}</p>
      <div class="pf-cost"><span>開始時の月額</span><b>${fmtUsd(costOf(pf.id, []).total)}</b></div>
      <button type="button" class="btn dark" data-p="${pf.id}">このプラットフォームで始める</button>
    </article>`).join('');
  document.querySelectorAll('#platforms [data-p]').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.p)));
}

document.addEventListener('DOMContentLoaded', () => {
  renderTitle();
  $('#btn-end').addEventListener('click', endQuarter);
  const relItem = (r) => `<li>${esc(r.when)}: ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}（${r.timing}）</li>`;
  $('#rel-down').innerHTML = RELIABILITY_RULES.filter((r) => r.delta < 0).map(relItem).join('');
  $('#rel-up').innerHTML = RELIABILITY_RULES.filter((r) => r.delta > 0).map(relItem).join('');
  $('#rel-help-link').addEventListener('click', () => { $('#rel-help').open = true; });
  $('#btn-quit').addEventListener('click', () => { if (confirm('タイトルに戻りますか？進行状況は失われます。')) show('title'); });
  $('#btn-retry').addEventListener('click', () => newGame(S.platform));
  $('#btn-title').addEventListener('click', () => show('title'));
  $('#btn-post').addEventListener('click', postToX);
  $('#btn-copy').addEventListener('click', copyShareText);
  $('#share-text').addEventListener('input', updateShareCount);
  $('#btn-play').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    document.title = 'コンテナコスト削減シミュレーター';
    show('title');
  });
  const shared = parseSharedResult();
  if (shared) showSharedResult(shared); else show('title');
});
