# ランドリー商圏ナビ

住所を入れると、コインランドリー出店候補地の第1・第2商圏の人口・世帯数と、周辺のコインランドリーを地図と一覧で表示するWebアプリです。

公開URL: https://fuchi0624.github.io/laundry-shoken/

- 人口・世帯数: 総務省統計局「令和2年国勢調査」地域メッシュ統計（500m）を `tools_convert.py` で `data/mesh/` に変換
- 住所検索: 国土地理院 住所検索API
- 地図・他社店舗: Google Maps JavaScript API / Places API (New)（`config.js` のキーは fuchi0624.github.io にリファラ制限）
