'use strict';

// phase: 1 可視化 / 2 すぐ効く施策 / 3 設計変更 / 4 ビルド改善
const PHASES = {
  1: '可視化',
  2: 'すぐ効く施策',
  3: '設計変更',
  4: 'ビルド改善',
};

const MEASURES = [
  {
    id: 'visibility', phase: 1, effort: 1, icon: 'cost-explorer',
    name: 'Cost Explorer / CUR でコストを可視化',
    refs: ['COST08-BP01', '設計原則: 支出の分析と帰属'],
    desc: '転送コストとコンピューティングコストを分解する。導入後は内訳と各施策の試算額が見えるようになる。',
  },
  {
    id: 'ecrLifecycle', phase: 2, effort: 1, icon: 'ecr',
    name: 'ECR ライフサイクルポリシー',
    refs: ['CONTAINER_BUILD_COST_01'],
    desc: '古いイメージを自動削除する。ECR は保存サイズで課金される。',
  },
  {
    id: 's3gw', phase: 2, effort: 1, icon: 'vpc-endpoints',
    name: 'S3 ゲートウェイエンドポイント',
    refs: ['COST08-BP03'],
    desc: 'ECR のイメージレイヤーは S3 から配信される。ゲートウェイ型は時間料金なしで、イメージ取得を NAT 経由から外せる。',
  },
  {
    id: 'sp', phase: 2, effort: 1, icon: 'savings-plans',
    name: 'Savings Plans を購入（本番）',
    nameBy: { rosa: 'EC2 Savings Plans を購入（本番）' },
    refs: ['COST07'],
    desc: '本番コンピュートを 1 年コミットで 20% 割引。購入時点の利用額でコミット額が決まる。',
  },
  {
    id: 'rosaContract', phase: 2, effort: 1, icon: 'rosa', only: ['rosa'],
    name: 'ROSA ワーカー料金を 1 年契約',
    refs: ['COST07', 'ROSA user guide'],
    desc: 'ワーカー料金 4vCPU あたり $0.171/時 を年 $1,000 の契約に切り替える。EC2 Savings Plans とは別枠の契約。',
  },
  {
    id: 'eksUpgrade', phase: 2, effort: 2, icon: 'eks', only: ['eks'],
    name: 'EKS バージョン更新（標準サポート維持）',
    refs: ['レビュー指摘 #7'],
    desc: '標準サポート $0.10/時。更新を怠ると延長サポート $0.60/時となり、1 クラスタ月約 $365 増える。',
  },
  {
    id: 'sigterm', phase: 3, effort: 2, icon: 'ecs-task',
    name: 'SIGTERM 対応（グレースフル終了）',
    refs: ['CONTAINER_BUILD_COST_05'],
    desc: 'オートスケーリングと Spot の前提条件。単体ではコストは下がらない。',
  },
  {
    id: 'rightsize', phase: 3, effort: 2, icon: 'auto-scaling', na: { rosa: 'このシナリオでは最小ノード構成のため対象外' },
    name: 'ライトサイジング＋オートスケーリング',
    refs: ['COST06-BP02', 'COST06-BP03', 'COST09-BP03'],
    descBy: {
      ecs: '本番をピーク固定 6vCPU から自動スケーリング平均 4vCPU へ。非本番は各 3vCPU → 2vCPU。',
      eks: '本番 m6i.xlarge×3 → large×3。非本番は 2 ノード/環境 → 1 ノード/環境。',
    },
  },
  {
    id: 'schedule', phase: 3, effort: 2, icon: 'cloudwatch', na: { rosa: 'ROSA は最小ノード数があるため停止しない' },
    name: '非本番の夜間・休日停止',
    refs: ['COST09-BP03'],
    desc: 'ステージング・開発を平日 10 時間 × 22 日のみ稼働させる（730h → 220h）。',
  },
  {
    id: 'spotNonprod', phase: 3, effort: 2, icon: 'spot-instance', na: { rosa: 'このシナリオでは対象外' },
    name: '非本番に Spot を適用',
    nameBy: { ecs: '非本番に Fargate Spot を適用' },
    refs: ['COST07', 'Amazon ECS cluster capacity'],
    desc: '60% 割引で試算（Fargate Spot の上限は 70%、EC2 Spot は 90%）。2 分前に中断通知が来る。',
  },
  {
    id: 'consolidate', phase: 3, effort: 3, icon: 'group-vpc',
    name: '非本番環境の集約（VPC・ALB・クラスタ共有）',
    refs: ['COST06', 'COST05'],
    descBy: {
      ecs: 'ステージングと開発で VPC と ALB を共有（ALB 3 → 2 台、ホスト名ルーティング）。',
      eks: 'ステージングと開発を 1 クラスタに集約（3 → 2 クラスタ）。VPC と ALB も共有。',
      rosa: 'ステージングと開発を 1 クラスタに集約（3 → 2）、非本番 6 ノード → 単一 AZ の 2 ノード。',
    },
  },
  {
    id: 'natReduce', phase: 3, effort: 1, icon: 'nat-gateway', requires: ['consolidate'], excludes: ['natSingle'],
    name: 'NAT ゲートウェイを 6 → 3 台',
    refs: ['COST08-BP03', 'レビュー指摘 #4'],
    desc: '本番は 2 台で冗長性を維持し、非本番は共有 1 台。非本番環境の集約が前提。',
  },
  {
    id: 'azOpt', phase: 3, effort: 2, icon: 'alb',
    name: 'AZ 間転送の最適化',
    nameBy: { eks: 'ip モード＋同一ゾーン優先ルーティング' },
    refs: ['COST08-BP02', 'EKS Best Practices - Networking'],
    desc: 'AWS Load Balancer Controller の ip モード、Traffic Distribution（PreferSameZone）で AZ 間通信を減らす。',
  },
  {
    id: 'graviton', phase: 4, effort: 3, icon: 'ec2', na: { rosa: 'このシナリオでは m5.xlarge を継続' },
    name: 'Graviton（ARM）へ移行',
    refs: ['CONTAINER_BUILD_COST_06'],
    desc: 'x86 と ARM のマルチアーキテクチャイメージを作り、Graviton で動かす。',
  },
  {
    id: 'imageSlim', phase: 4, effort: 2, icon: 'codebuild',
    name: 'イメージ軽量化',
    refs: ['CONTAINER_BUILD_COST_03', 'CONTAINER_BUILD_COST_04'],
    desc: '軽量ベースイメージ、マルチステージビルド、.dockerignore、RUN の連結。保存量と起動時間が減る。',
  },
  // 以下、資料のレビューで「この規模では入れない方がよい／注意」とされた施策
  {
    id: 'ecrIf', phase: 2, effort: 2, icon: 'vpc-endpoints',
    name: 'ECR 用インターフェイス VPC エンドポイント',
    refs: ['COST08-BP03', 'レビュー指摘 #3'],
    desc: 'ECR への接続を NAT ゲートウェイ経由からインターフェイスエンドポイント経由にする（2AZ × 2 エンドポイント）。',
  },
  {
    id: 'natSingle', phase: 3, effort: 1, icon: 'nat-gateway', requires: ['consolidate'], excludes: ['natReduce'],
    name: 'NAT ゲートウェイを全環境で 1 台に集約',
    refs: ['COST08-BP03'],
    desc: '本番も含めて NAT ゲートウェイを 1 台にまとめる。',
  },
  {
    id: 'prodSpot', phase: 3, effort: 1, icon: 'spot-instance', na: { rosa: 'このシナリオでは対象外' },
    name: '本番にも Spot を適用',
    refs: ['COST07'],
    desc: '本番のコンピュートも Spot にする。',
  },
];

const MEASURE_BY_ID = Object.fromEntries(MEASURES.map((m) => [m.id, m]));

function measureName(m, p) { return (m.nameBy && m.nameBy[p]) || m.name; }
function measureDesc(m, p) { return (m.descBy && m.descBy[p]) || m.desc; }
function measureNa(m, p) {
  if (m.only && !m.only.includes(p)) return 'このプラットフォームでは対象外';
  return (m.na && m.na[p]) || null;
}
