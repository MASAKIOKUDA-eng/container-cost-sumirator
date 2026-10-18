'use strict';

const SPRINTS = 4;
const EFFORT_PER_SPRINT = 6;
const ICON = (name) => `assets/icons/${name}.svg`;

let S = null; // ゲーム状態

function newGame(platform) {
  S = {
    platform,
    sprint: 1,
    applied: new Set(),
    appliedAt: {},
    pending: new Set(),
    spCommit: null,
    spReported: null,
    eksExtended: false,
    reliability: 100,
    log: [],
    history: [],
  };
  S.baseline = computeCost(S).total;
  S.history.push({ label: '開始', total: S.baseline });
  show('game');
  pushLog('info', `月額 ${fmtUsd(S.baseline)} の請求が届いた。CFO から「来期までにコンテナ基盤の費用を下げてほしい」と依頼があった。`);
  sprintIntro();
  render();
}

function sprintIntro() {
  const p = S.platform;
  const msg = {
    1: '1 スプリントで使える工数は 6。全部の施策は入らないので、優先順位を決めて進める。',
    2: p === 'eks'
      ? 'EKS の現行バージョンは、このスプリントの終了時点で標準サポートが終わる。'
      : 'ステージングと開発の環境が、夜間と休日も 24 時間稼働していることに気づいた。',
    3: '開発チームから「Spot を使うなら中断時の振る舞いを確認したい」と相談があった。',
    4: '最終スプリント。次の四半期の予算はこのスプリント終了時点の月額で決まる。',
  }[S.sprint];
  pushLog('info', msg);
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
  if (hasApplied(m.id)) return { ok: false, reason: `Sprint ${S.appliedAt[m.id]} で導入済み`, done: true };
  if (m.excludes && m.excludes.some(hasAny)) return { ok: false, reason: `「${measureName(MEASURE_BY_ID[m.excludes[0]], p)}」と同時に選べない` };
  if (m.requires && !m.requires.every(hasAny)) return { ok: false, reason: `前提: ${m.requires.map((r) => measureName(MEASURE_BY_ID[r], p)).join('、')}` };
  if (!S.pending.has(m.id) && effortUsed() + m.effort > EFFORT_PER_SPRINT) return { ok: false, reason: '今スプリントの工数が足りない' };
  return { ok: true };
}

// 現在の状態（今スプリントの選択を含む）に施策を 1 つ加えたときの月額差
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

function endSprint() {
  const s = S.sprint;
  const p = S.platform;
  const before = current().total;
  const newly = [...S.pending];
  newly.forEach((id) => { S.applied.add(id); S.appliedAt[id] = s; });
  S.pending.clear();
  const events = [];
  const ev = (kind, text, rel = 0) => {
    if (rel) S.reliability = Math.max(0, S.reliability + rel);
    events.push({ kind, text, rel });
  };
  const isNew = (id) => newly.includes(id);

  if (isNew('sp')) {
    S.spCommit = prodUsage(p, hasApplied);
    S.spReported = S.spCommit;
    ev('info', `Savings Plans を購入した。コミット額は現在の本番利用額 ${fmtUsd(S.spCommit)}/月 の 80%（${fmtUsd(S.spCommit * PRICE.spRate)}/月）。`);
  }
  if (isNew('visibility')) {
    const it = current().items;
    const top = COST_ITEMS.map((c) => ({ ...c, v: it[c.id] })).sort((a, b) => b.v - a.v).slice(0, 2);
    ev('good', `コストの内訳が見えるようになった。大きい項目は「${top[0].name}」${fmtUsd(top[0].v)} と「${top[1].name}」${fmtUsd(top[1].v)}。`);
  }
  if (isNew('rightsize') && !hasApplied('visibility')) {
    ev('bad', 'メトリクスを見ずにサイズを縮小したため、ピーク時に API タスクがメモリ不足で再起動した。COST06 はデータとメトリクスに基づく選定を求めている。', -15);
  }
  if (isNew('prodSpot')) {
    ev('bad', '本番に Spot を入れた。中断が重なると本番の処理能力が落ちる。Spot は中断に強いバッチや開発・ステージング向け。', -15);
  }
  if (isNew('natSingle')) {
    ev('bad', 'NAT ゲートウェイを 1 台にした結果、本番が単一 AZ に依存する構成になった。資料の試算でも本番は 2 台で冗長性を維持している。', -20);
  }
  if (isNew('ecrIf')) {
    const d = computeCost(S).items.endpoint;
    ev('bad', `インターフェイスエンドポイントの時間料金（AZ 単位で課金）で ${fmtUsd(d)}/月 かかるようになった。NAT 経由の転送が月約 790GB を超えるまでは NAT の方が安い。` +
      (hasApplied('s3gw') ? ' イメージ取得はすでに S3 ゲートウェイエンドポイントで NAT から外れている。' : ''));
  }
  if (isNew('azOpt')) {
    ev('info', `AZ 間転送が月 ${fmtUsd(TRAFFIC.azGb * 0.6 * PRICE.azGb)} 減った。この規模では効果が小さく、品質上の理由がなければ後回しでよい施策。`);
  }
  if (isNew('consolidate')) {
    ev('good', '非本番環境を集約した。共有 VPC になったので NAT ゲートウェイの台数も見直せる。');
  }

  if (hasApplied('spotNonprod') && !hasApplied('sigterm')) {
    ev('bad', 'Spot の中断通知（2 分前）を処理できず、ステージングのジョブが途中で終了した。SIGTERM 対応が前提（CONTAINER_BUILD_COST_05）。', -10);
  }
  if (hasApplied('prodSpot') && !hasApplied('sigterm')) {
    ev('bad', '本番タスクが Spot 中断で強制終了し、処理中のリクエストが失敗した。', -10);
  }
  if (hasApplied('rightsize') && !hasApplied('sigterm')) {
    ev('bad', 'スケールインのたびに処理中のリクエストが切断されている。', -5);
  }

  if (p === 'eks') {
    if (s === 2 && !hasApplied('eksUpgrade')) {
      S.eksExtended = true;
      const n = hasApplied('consolidate') ? 2 : 3;
      ev('bad', `EKS の標準サポートが終了し、延長サポート（$0.60/時）に移行した。${n} クラスタで月 ${fmtUsd(n * 0.5 * PRICE.H)} 増える。`);
    } else if (S.eksExtended && hasApplied('eksUpgrade')) {
      S.eksExtended = false;
      ev('good', 'バージョンを更新して標準サポート料金に戻った。');
    } else if (isNew('eksUpgrade')) {
      ev('good', '標準サポート終了の前にバージョンを更新した。延長サポート料金を回避。');
    }
  }

  if (hasApplied('sp') && !isNew('sp')) {
    const usage = prodUsage(p, hasApplied);
    if (usage < S.spReported - 0.5) {
      const waste = (S.spCommit - usage) * PRICE.spRate;
      ev('bad', `本番の利用額が ${fmtUsd(usage)}/月 に下がったが、Savings Plans のコミットは購入時の ${fmtUsd(S.spCommit)}/月 基準のまま。月 ${fmtUsd(waste)} 分のコミットが余っている。ライトサイジングを先に行うべきだった。`);
      S.spReported = usage;
    }
  }

  const after = current().total;
  S.history.push({ label: `S${s}`, total: after });
  events.unshift({ kind: 'summary', text: `月額 ${fmtUsd(before)} → ${fmtUsd(after)}（${after <= before ? '−' : '+'}${fmtUsd(Math.abs(before - after))}）` });
  events.forEach((e) => pushLog(e.kind, e.text, e.rel));

  showDialog(`Sprint ${s} の結果`, events, () => {
    if (s >= SPRINTS) { showResult(); return; }
    S.sprint += 1;
    sprintIntro();
    render();
  });
  render();
}

function pushLog(kind, text, rel = 0) {
  if (kind === 'summary') return;
  S.log.unshift({ sprint: S.sprint, kind, text, rel });
}

// ---- 描画 ----
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(screen) {
  for (const id of ['title', 'game', 'result', 'shared']) $('#' + id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function render() {
  const pf = PLATFORMS[S.platform];
  const c = current();
  const reduction = 1 - c.total / S.baseline;
  $('#hdr-platform').innerHTML = `<img src="${ICON(pf.icon)}" alt=""> ${esc(pf.name)}`;
  $('#hdr-sprint').textContent = `Sprint ${S.sprint} / ${SPRINTS}`;
  $('#m-total').textContent = fmtUsd(c.total);
  $('#m-total-sub').textContent = fmtJpy(c.total) + ' / 月';
  $('#m-red').textContent = (reduction * 100).toFixed(1) + '%';
  $('#m-red-sub').textContent = `開始時 ${fmtUsd(S.baseline)}`;
  $('#m-rel').textContent = S.reliability;
  $('#m-rel').className = 'metric-value ' + (S.reliability >= 90 ? '' : S.reliability >= 70 ? 'warn' : 'bad');
  $('#m-effort').textContent = `${EFFORT_PER_SPRINT - effortUsed()} / ${EFFORT_PER_SPRINT}`;
  renderDiagram();
  renderBreakdown(c);
  renderHistory();
  renderMeasures();
  renderLog();
  $('#btn-end').textContent = S.sprint >= SPRINTS ? `Sprint ${S.sprint} を終了して結果を見る` : `Sprint ${S.sprint} を終了`;
  $('#pending-note').textContent = S.pending.size
    ? `選択中 ${S.pending.size} 件・工数 ${effortUsed()}`
    : '施策が選ばれていません';
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
  const bw = (W - pad) / (SPRINTS + 1);
  const bars = Array.from({ length: SPRINTS + 1 }, (_, i) => {
    const x = pad + i * bw + bw * 0.2;
    const lbl = i === 0 ? '開始' : `S${i}`;
    const it = h[i];
    if (!it) return `<text x="${x + bw * 0.3}" y="${Hh - 4}" class="ax" text-anchor="middle">${lbl}</text>`;
    const bh = (it.total / max) * (Hh - 24);
    return `<rect x="${x}" y="${Hh - 16 - bh}" width="${bw * 0.6}" height="${bh}" class="${i === 0 ? 'hb0' : 'hb'}"/>
      <text x="${x + bw * 0.3}" y="${Hh - 20 - bh}" class="val" text-anchor="middle">${Math.round(it.total).toLocaleString()}</text>
      <text x="${x + bw * 0.3}" y="${Hh - 4}" class="ax" text-anchor="middle">${lbl}</text>`;
  }).join('');
  $('#history').innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="月額の推移"><line x1="${pad}" x2="${W}" y1="${Hh - 16}" y2="${Hh - 16}" class="axis"/>${bars}<text x="0" y="12" class="ax">USD</text></svg>`;
}

function renderMeasures() {
  const p = S.platform;
  const visible = hasApplied('visibility');
  let html = '';
  for (const ph of [1, 2, 3, 4]) {
    const list = MEASURES.filter((m) => m.phase === ph && (!m.only || m.only.includes(p)));
    html += `<tbody><tr class="phase"><th colspan="5">${ph}. ${PHASES[ph]}</th></tr>`;
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
  }
  $('#measures').innerHTML = `<thead><tr><th></th><th></th><th>施策</th><th class="num">工数</th><th class="num">試算（月）</th></tr></thead>${html}`;
  $('#measures').querySelectorAll('tr.m').forEach((tr) => {
    if (tr.getAttribute('aria-disabled') === 'true' || tr.classList.contains('done')) return;
    tr.addEventListener('click', () => togglePending(tr.dataset.id));
    tr.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePending(tr.dataset.id); } });
  });
}

function renderLog() {
  $('#log').innerHTML = S.log.slice(0, 30).map((l) =>
    `<li class="${l.kind}"><span class="ls">S${l.sprint}</span><span class="lt">${esc(l.text)}${l.rel ? ` <b>信頼性 ${l.rel}</b>` : ''}</span></li>`).join('');
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
function showDialog(title, events, onClose) {
  const d = $('#dialog');
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = events.map((e) =>
    `<li class="${e.kind}">${esc(e.text)}${e.rel ? ` <b>信頼性 ${e.rel}</b>` : ''}</li>`).join('');
  $('#dlg-ok').textContent = S.sprint >= SPRINTS ? '結果を見る' : `Sprint ${S.sprint + 1} へ`;
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
  let rank;
  if (achieve >= 0.95 && rel >= 90) rank = 'S';
  else if (achieve >= 0.8 && rel >= 75) rank = 'A';
  else if (achieve >= 0.6 && rel >= 60) rank = 'B';
  else rank = 'C';
  const rankText = {
    S: '資料の推奨プランと同等の削減を、信頼性を落とさずに達成した。',
    A: '大きな削減を実現した。順番や前提条件を見直せばさらに伸ばせる。',
    B: '一定の削減はできたが、効果の大きい施策の取りこぼしか、信頼性の低下がある。',
    C: '削減が不十分か、信頼性の低下が大きい。可視化から順に進めてみよう。',
  }[rank];

  const done = DOC_PLAN[p].map((id) => {
    const m = MEASURE_BY_ID[id];
    const at = S.appliedAt[id];
    return `<tr><td>${esc(measureName(m, p))}</td><td>${m.refs.map(esc).join('<br>')}</td><td class="num">${at ? 'S' + at : '<span class="up">未導入</span>'}</td></tr>`;
  }).join('');
  const extras = [...S.applied].filter((id) => !DOC_PLAN[p].includes(id)).map((id) =>
    `<tr><td>${esc(measureName(MEASURE_BY_ID[id], p))}</td><td class="num">S${S.appliedAt[id]}</td></tr>`).join('');

  $('#result-body').innerHTML = `
    <div class="result-head">
      <div class="rank rank-${rank}">${rank}</div>
      <div><h2>${esc(pf.name)} の結果</h2><p>${rankText}</p></div>
    </div>
    <table class="tbl kv">
      <tr><th>開始時の月額</th><td class="num">${fmtUsd(S.baseline)}</td><td>${fmtJpy(S.baseline)}</td></tr>
      <tr><th>最終の月額</th><td class="num">${fmtUsd(c.total)}</td><td>${fmtJpy(c.total)}</td></tr>
      <tr><th>削減率</th><td class="num">${((saved / S.baseline) * 100).toFixed(1)}%</td><td>年間 ${fmtUsd(saved * 12)}（${fmtJpy(saved * 12)}）</td></tr>
      <tr><th>資料の推奨プラン</th><td class="num">${fmtUsd(ref.total)}</td><td>削減率 ${((refSaved / S.baseline) * 100).toFixed(1)}%（資料の試算: ${fmtUsd(pf.docBefore)} → ${fmtUsd(pf.docAfter)}）</td></tr>
      <tr><th>推奨プラン比の達成率</th><td class="num">${(achieve * 100).toFixed(0)}%</td><td></td></tr>
      <tr><th>信頼性スコア</th><td class="num">${rel}</td><td>${rel >= 90 ? '問題なし' : '障害や冗長性の低下が発生した'}</td></tr>
    </table>
    <h3>資料の推奨施策と導入タイミング</h3>
    <table class="tbl"><thead><tr><th>施策</th><th>Well-Architected</th><th class="num">導入</th></tr></thead><tbody>${done}</tbody></table>
    ${extras ? `<h3>推奨プラン外で導入した施策</h3><table class="tbl"><tbody>${extras}</tbody></table>` : ''}
    <h3>この規模での判断ポイント（資料より）</h3>
    <ul class="points">
      <li>効果が大きい: 非本番環境の集約と夜間・休日停止、NAT ゲートウェイの台数削減、ECR ライフサイクルポリシー。</li>
      <li>効果が小さい: AZ 間転送の最適化（月 $2.4）。品質上の理由がなければ後回しでよい。</li>
      <li>入れない方がよい: ECR 用インターフェイス VPC エンドポイント。NAT 経由が月約 790GB を超えるまでは NAT の方が安い。</li>
      <li>NAT ゲートウェイの AZ ごと追加は、AZ 間転送が月約 2.3TB 以上ないと元が取れない（東京、追加 1 台 月約 $45）。</li>
      <li>割引率: EC2 Spot は最大 90%、Fargate Spot は最大 70%。Compute Savings Plans は最大 66%、Fargate には最大 50%。</li>
      <li>EKS はバージョン更新を先送りすると延長サポートで 1 クラスタ月約 $365 増える。</li>
      <li>パブリック IPv4 は 1 アドレス $0.005/時。プライベートサブネット化で削減できる。</li>
      <li>コスト面だけなら、この規模では ECS on Fargate が最も安い。ROSA は OpenShift が必要な理由がある場合に選ぶ。</li>
    </ul>
    <p class="muted small">単価は資料の前提（東京リージョン、1 ドル = 150 円）に基づく概算。「要確認」の単価は AWS Pricing Calculator で再計算すること。</p>`;
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
  $('#platforms').innerHTML = Object.values(PLATFORMS).map((pf) => {
    const b = costOf(pf.id, []).total;
    return `<button class="pf" data-p="${pf.id}">
      <img src="${ICON(pf.icon)}" alt="">
      <span class="pf-name">${esc(pf.name)}</span>
      <span class="pf-blurb">${esc(pf.blurb)}</span>
      <span class="pf-cost">開始時の月額 <b>${fmtUsd(b)}</b></span>
    </button>`;
  }).join('');
  document.querySelectorAll('.pf').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.p)));
}

document.addEventListener('DOMContentLoaded', () => {
  renderTitle();
  $('#btn-end').addEventListener('click', endSprint);
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
