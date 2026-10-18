# container-cost-sumirator
2026.10.20 JAWS-UG SRE支部用アプリ（コンテナコスト削減体験ゲーム）

AWS のコンテナ基盤（ECS on Fargate / EKS on EC2 / ROSA）のコスト削減を、Well-Architected フレームワークに沿って体験するブラウザゲームです。

## 遊び方

1 年間を 3 か月ごとの 4 つの四半期に分けて進めます。

1. プラットフォームを選ぶ（ECS on Fargate / EKS on EC2 / ROSA HCP）
2. 四半期ごとに、工数 6（2 名 × 3 か月）の範囲で施策を選び、「第 N 四半期を終える」を押す
3. 第 4 四半期終了時（1 年後）の月額と信頼性スコアでランク（S〜C）が決まる

遊び方・登場人物・信頼性スコア・施策の分類の詳しい説明は、解説ページ（`guide.html`、ゲームから別タブで開く）にあります。

### 登場人物

| 人物 | 関心 |
| --- | --- |
| あなた（SRE） | 施策を選ぶプレイヤー |
| 財務部長 小林 | 月額コスト |
| プロダクトオーナー 高橋 | 信頼性・利用者体験 |
| プロジェクトマネージャー 中村 | 工数と順番 |
| テックリード 山本 | 前提条件・技術的な妥当性 |

### 信頼性スコア

100 から始まり、障害や冗長性の低下で下がり、障害のない四半期（+5）や SIGTERM 対応による障害の解消（+10）で回復します。増減のルールは `js/model.js` の `RELIABILITY_RULES` にまとめています。

### 施策の分類

Well-Architected コスト最適化の柱の領域でそろえています: 可視化（COST08-BP01）／料金モデル・契約（COST07）／リソースの適正化と需要管理（COST06・COST09）／ネットワーク・データ転送（COST08）／コンテナイメージ・ビルド（Container Build Lens）。

### ゲームの仕掛け

- **可視化するまで内訳が見えない**: 「Cost Explorer / CUR でコストを可視化」（COST08-BP01）を導入するまで、コスト内訳と各施策の試算額は表示されない
- **順番と前提条件**
  - メトリクスなしのライトサイジング → OOM で信頼性低下（COST06）
  - SIGTERM 対応なしの Spot・オートスケーリング → 中断やリクエスト断（CONTAINER_BUILD_COST_05）
  - ライトサイジング前の Savings Plans 購入 → コミットが余る
  - EKS のバージョン更新を第 2 四半期末までに行わないと延長サポート料金（$0.60/時）が発生
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
index.html          タイトル・ゲーム・結果
guide.html          解説ページ
css/style.css
js/model.js         単価・コスト計算・信頼性スコアとランクのルール
js/measures.js      施策の定義と分類（Well-Architected の参照つき）
js/characters.js    登場人物
js/game.js          ゲーム進行・イベント・描画・X ポスト
js/guide.js         解説ページの表
assets/icons/       AWS Architecture Icons（Light BG 版、2026-07-31 版ツールキットより抽出）
assets/characters/  登場人物のイラスト（SVG）
```

## 参考

- AWS Well-Architected Framework コスト最適化の柱（COST05〜COST09）
- Container Build Lens（CONTAINER_BUILD_COST_01〜08）
- EKS Best Practices Guide - Cost Optimization
- Amazon ECS clusters for Fargate（Fargate Spot）

タイトル画面のデザインは Claude Design で作成しました。

AWS アイコンは [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) を使用しています。金額は概算で、実際の請求額とは異なります。
