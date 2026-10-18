'use strict';

// 登場人物
const CHARACTERS = {
  sre: {
    name: 'あなた', role: 'SRE（プレイヤー）', img: 'assets/characters/sre.svg', focus: 'コストと信頼性の両立',
    desc: 'コンテナ基盤の運用担当。四半期ごとにチームの工数を使って、導入する施策を決める。',
  },
  cfo: {
    name: '小林', role: '財務部長', img: 'assets/characters/cfo.svg', focus: '月額コスト',
    desc: '「来期までにコンテナ基盤の費用を下げてほしい」と依頼してきた人。請求額の増減と契約（Savings Plans など）に反応する。',
  },
  po: {
    name: '高橋', role: 'プロダクトオーナー', img: 'assets/characters/po.svg', focus: '信頼性・利用者体験',
    desc: '利用者 1,000 名の体験と機能開発を守りたい。障害や性能劣化が起きると真っ先に連絡が来る。',
  },
  pm: {
    name: '中村', role: 'プロジェクトマネージャー', img: 'assets/characters/pm.svg', focus: '工数と順番',
    desc: 'チームの工数を四半期ごとに配分する（2 名 × 3 か月 = 工数 6）。期限のある作業や施策の順番を気にかける。',
  },
  tl: {
    name: '山本', role: 'テックリード', img: 'assets/characters/techlead.svg', focus: '前提条件・技術的な妥当性',
    desc: 'アプリとビルドの改修を担う。SIGTERM 対応、Graviton 移行、イメージ軽量化、ネットワーク構成の相談相手。',
  },
};

const charLabel = (id) => `${CHARACTERS[id].role} ${CHARACTERS[id].name}`;
