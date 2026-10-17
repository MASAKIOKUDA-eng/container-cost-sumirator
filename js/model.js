// コストモデル
// 単価・前提は「AWS コンテナサービスのコスト削減（Well-Architected 準拠）」の
// コスト試算（東京リージョン・利用ユーザー 1,000 名規模）に基づく。
'use strict';

const PRICE = {
  H: 730,             // 1 か月の時間
  H_SCHED: 220,       // 平日 10 時間 × 22 日
  fgX86: { vcpu: 0.05056, gb: 0.00553 },
  fgArm: { vcpu: 0.04045, gb: 0.00442 },
  m6iXl: 0.248, m6iL: 0.124, m7gXl: 0.2108, m7gL: 0.1054, m5Xl: 0.248,
  ebsNode: 4.8,       // 50GB gp3 × $0.096
  eksCluster: 0.10, eksExtended: 0.60,
  rosaCluster: 0.25, rosaWorker: 0.171, rosaWorker1y: 1000 / 12,
  rosaProdOther: 86.5, rosaNodeOther: 28.8333,
  nat: 0.062, natGb: 0.062, ipv4: 0.005,
  alb: 0.0243, albLcu: 8.2,
  ecrGb: 0.10, azGb: 0.02, inetGb: 0.114,
  ifEndpoint: 0.014, ifEndpointGb: 0.01,
  spRate: 0.8,        // Compute Savings Plans 20% 割引（Fargate 上限 50% より控えめ）
  spotRate: 0.4,      // Spot 60% 割引（Fargate Spot 上限 70% より控えめ）
  usdJpy: 150,
};

const TRAFFIC = { natOtherGb: 100, imageGb: 300, azGb: 200, inetGb: 300, ecrStoreGb: 300 };

const PLATFORMS = {
  ecs: {
    id: 'ecs', name: 'ECS on Fargate', icon: 'ecs', computeIcon: 'fargate',
    blurb: 'サーバーレスなコンテナ実行。コントロールプレーン料金なし。',
    docBefore: 987.6, docAfter: 366.4,
  },
  eks: {
    id: 'eks', name: 'EKS on EC2', icon: 'eks', computeIcon: 'ec2-instance',
    blurb: 'Kubernetes。クラスタ料金 $0.10/時とワーカーノード（EC2）。',
    docBefore: 1967.7, docAfter: 611.1,
  },
  rosa: {
    id: 'rosa', name: 'ROSA (HCP)', icon: 'rosa', computeIcon: 'ec2-instance',
    blurb: 'Red Hat OpenShift。クラスタ料金とワーカーのサービス料金が固定でかかる。',
    docBefore: 4007.4, docAfter: 2039.1,
  },
};

const COST_ITEMS = [
  { id: 'cp', name: 'コントロールプレーン' },
  { id: 'prod', name: '本番コンピュート' },
  { id: 'nonprod', name: '非本番コンピュート' },
  { id: 'nat', name: 'NAT ゲートウェイ（時間・処理・IPv4）' },
  { id: 'alb', name: 'ALB' },
  { id: 'ecr', name: 'ECR（イメージ保存）' },
  { id: 'endpoint', name: 'インターフェイス VPC エンドポイント' },
  { id: 'az', name: 'AZ 間転送' },
  { id: 'inet', name: 'インターネット向け転送' },
];

// 本番コンピュートのオンデマンド相当額（Savings Plans 適用前）
function prodUsage(p, has) {
  const H = PRICE.H;
  let c;
  if (p === 'ecs') {
    const vcpu = has('rightsize') ? 4 : 6;
    const u = has('graviton') ? PRICE.fgArm : PRICE.fgX86;
    c = H * (vcpu * u.vcpu + vcpu * 2 * u.gb);
  } else if (p === 'eks') {
    const node = has('rightsize')
      ? (has('graviton') ? PRICE.m7gL : PRICE.m6iL)
      : (has('graviton') ? PRICE.m7gXl : PRICE.m6iXl);
    c = 3 * node * H;
  } else {
    c = 3 * PRICE.m5Xl * H;
  }
  if (has('prodSpot')) c *= PRICE.spotRate;
  return c;
}

function computeCost(state) {
  const p = state.platform;
  const has = (id) => state.applied.has(id);
  const H = PRICE.H;
  const items = {};
  const clusters = has('consolidate') ? 2 : 3;

  // コントロールプレーン
  if (p === 'ecs') items.cp = 0;
  else if (p === 'eks') items.cp = clusters * PRICE.eksCluster * H + (state.eksExtended ? clusters * (PRICE.eksExtended - PRICE.eksCluster) * H : 0);
  else items.cp = clusters * PRICE.rosaCluster * H;

  // 本番コンピュート
  const usage = prodUsage(p, has);
  let prod = usage;
  if (has('sp')) {
    const base = state.spCommit ?? usage;
    prod = usage <= base ? PRICE.spRate * base : PRICE.spRate * base + (usage - base);
  }
  if (p === 'eks') prod += 3 * PRICE.ebsNode;
  if (p === 'rosa') {
    prod += has('rosaContract') ? 3 * PRICE.rosaWorker1y : 3 * PRICE.rosaWorker * H;
    prod += PRICE.rosaProdOther;
  }
  items.prod = prod;

  // 非本番コンピュート（ステージング＋開発）
  const hours = has('schedule') ? PRICE.H_SCHED : H;
  const spot = has('spotNonprod') ? PRICE.spotRate : 1;
  if (p === 'ecs') {
    const vcpu = has('rightsize') ? 2 : 3;
    const u = has('graviton') ? PRICE.fgArm : PRICE.fgX86;
    items.nonprod = 2 * hours * (vcpu * u.vcpu + vcpu * 2 * u.gb) * spot;
  } else if (p === 'eks') {
    const nodes = has('rightsize') ? 2 : 4;
    const node = has('rightsize')
      ? (has('graviton') ? PRICE.m7gL : PRICE.m6iL)
      : (has('graviton') ? PRICE.m7gXl : PRICE.m6iXl);
    items.nonprod = nodes * node * hours * spot + nodes * PRICE.ebsNode;
  } else {
    const nodes = has('consolidate') ? 2 : 6;
    items.nonprod = nodes * ((PRICE.m5Xl + PRICE.rosaWorker) * H + PRICE.rosaNodeOther);
  }

  // NAT ゲートウェイ
  const natCount = natGatewayCount(has);
  const imageViaNat = (has('s3gw') || has('ecrIf')) ? 0 : TRAFFIC.imageGb;
  items.nat = natCount * (PRICE.nat + PRICE.ipv4) * H + (TRAFFIC.natOtherGb + imageViaNat) * PRICE.natGb;

  items.alb = (has('consolidate') ? 2 : 3) * PRICE.alb * H + PRICE.albLcu;
  items.ecr = TRAFFIC.ecrStoreGb * (has('ecrLifecycle') ? 0.2 : 1) * (has('imageSlim') ? 0.25 : 1) * PRICE.ecrGb;
  items.endpoint = has('ecrIf')
    ? 4 * PRICE.ifEndpoint * H + (has('s3gw') ? 0 : TRAFFIC.imageGb * PRICE.ifEndpointGb)
    : 0;
  items.az = TRAFFIC.azGb * (has('azOpt') ? 0.4 : 1) * PRICE.azGb;
  items.inet = TRAFFIC.inetGb * PRICE.inetGb;

  const total = Object.values(items).reduce((a, b) => a + b, 0);
  return { items, total, usage };
}

function natGatewayCount(has) {
  if (has('natSingle')) return 1;
  if (has('natReduce')) return 3;
  return 6;
}

// 資料の推奨施策（テクニカルリードレビュー反映後）
const DOC_PLAN = {
  ecs: ['visibility', 'ecrLifecycle', 's3gw', 'sigterm', 'rightsize', 'schedule', 'spotNonprod', 'consolidate', 'natReduce', 'graviton', 'imageSlim', 'sp', 'azOpt'],
  eks: ['visibility', 'ecrLifecycle', 's3gw', 'eksUpgrade', 'sigterm', 'rightsize', 'schedule', 'spotNonprod', 'consolidate', 'natReduce', 'graviton', 'imageSlim', 'sp', 'azOpt'],
  rosa: ['visibility', 'ecrLifecycle', 's3gw', 'consolidate', 'natReduce', 'imageSlim', 'sp', 'rosaContract', 'azOpt'],
};

function costOf(platform, ids, extra = {}) {
  return computeCost({ platform, applied: new Set(ids), spCommit: null, eksExtended: false, ...extra });
}

const fmtUsd = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtJpy = (v) => '約 ' + (v * PRICE.usdJpy / 10000).toFixed(1) + ' 万円';
