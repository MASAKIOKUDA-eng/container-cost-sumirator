# container-cost-sumirator
2026.10.20 JAWS-UG SRE支部用アプリ（コンテナコスト削減体験ゲーム）

AWS のコンテナ基盤（ECS on Fargate / EKS on EC2 / ROSA）のコスト削減を、Well-Architected フレームワークに沿って体験するブラウザゲームです。

## 遊び方

1. プラットフォームを選ぶ（ECS on Fargate / EKS on EC2 / ROSA HCP）
2. 1 スプリントの工数 6 の範囲で施策を選び、「Sprint を終了」を押す
3. 4 スプリント終了時の月額と信頼性スコアでランク（S〜C）が決まる

### ゲームの仕掛け

- **可視化するまで内訳が見えない**: 「Cost Explorer / CUR でコストを可視化」（COST08-BP01）を導入するまで、コスト内訳と各施策の試算額は表示されない
- **順番と前提条件**
  - メトリクスなしのライトサイジング → OOM で信頼性低下（COST06）
  - SIGTERM 対応なしの Spot・オートスケーリング → 中断やリクエスト断（CONTAINER_BUILD_COST_05）
  - ライトサイジング前の Savings Plans 購入 → コミットが余る
  - EKS のバージョン更新を Sprint 2 までに行わないと延長サポート料金（$0.60/時）が発生
- **この規模では逆効果・効果が小さい施策**
  - ECR 用インターフェイス VPC エンドポイント（NAT 経由が月約 790GB を超えるまでは NAT の方が安い）
  - AZ 間転送の最適化（月 $2.4）
  - NAT ゲートウェイ 1 台集約、本番への Spot（コストは下がるが信頼性が落ちる）

## シナリオとコストモデル

「AWS コンテナサービスのコスト削減（Well-Architected 準拠）」のコスト試算（東京リージョン、利用ユーザー 1,000 名規模、1 ドル = 150 円）をもとにしています。

| プラットフォーム | 開始時 | 資料の推奨プラン | 資料の試算 |
| --- | --- | --- | --- |
| ECS on Fargate | $987.7 | $366.4 | $987.6 → $366.4 |
| EKS on EC2 | $1,967.8 | $607.1 | $1,967.7 → $611.1 |
| ROSA (HCP) | $4,007.7 | $2,039.3 | $4,007.4 → $2,039.1 |

- 単価は `js/model.js` の `PRICE` にまとめています。資料で「要確認」とされた単価は AWS Pricing Calculator で確認してください。
- EKS の非本番コンピュートは、ノードの EBS の扱いの差で資料の試算と約 $4 ずれます。

## ローカルで動かす

ビルド不要の静的サイトです。

```bash
python -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます。

## GitHub Pages で公開する

リポジトリの Settings → Pages で、Source を「Deploy from a branch」、Branch を `main` / `(root)` にします。

## ファイル構成

```
index.html
css/style.css
js/model.js      単価・コスト計算
js/measures.js   施策の定義（Well-Architected の参照つき）
js/game.js       ゲーム進行・イベント・描画
assets/icons/    AWS Architecture Icons（Light BG 版、2026-07-31 版ツールキットより抽出）
```

## 参考

- AWS Well-Architected Framework コスト最適化の柱（COST05〜COST09）
- Container Build Lens（CONTAINER_BUILD_COST_01〜08）
- EKS Best Practices Guide - Cost Optimization
- Amazon ECS cluster capacity best practices

AWS アイコンは [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) を使用しています。金額は概算で、実際の請求額とは異なります。
