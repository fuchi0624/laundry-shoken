(function () {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const USE_GOOGLE = !!CFG.googleApiKey;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Math.round(n).toLocaleString("ja-JP");
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  let cur = null;      // { lat, lon, matched, address, cells, comps }
  let active = -1;

  // ---------------------------------------------------------------- 計算
  function distKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, dlat = (lat2 - lat1) * r, dlon = (lon2 - lon1) * r;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dlon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }
  function meshBox(code) {
    code = String(code);
    const p = +code.slice(0, 2), u = +code.slice(2, 4), q = +code[4], v = +code[5], r = +code[6], w = +code[7], m = +code[8] - 1;
    return { s: p / 1.5 + q / 12 + r / 120 + Math.floor(m / 2) / 240, w: u + 100 + v / 8 + w / 80 + (m % 2) / 160, dl: 1 / 240, dn: 1 / 160 };
  }
  function primaryCodes(lat, lon, km) {
    const dlat = km / 111, dlon = km / (111 * Math.cos(lat * Math.PI / 180)), set = new Set();
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
      const la = lat - dlat + 2 * dlat * i / 6, lo = lon - dlon + 2 * dlon * j / 6;
      set.add(`${Math.floor(la * 1.5)}${Math.floor(lo - 100)}`);
    }
    return [...set];
  }
  const meshCache = {};
  async function loadMesh(code) {
    if (!(code in meshCache)) {
      meshCache[code] = fetch(`data/mesh/${code}.json`).then((r) => (r.ok ? r.json() : { m: [] })).catch(() => ({ m: [] }));
    }
    return meshCache[code];
  }
  async function buildCells(lat, lon) {
    const maxKm = 10.5, N = 8, cells = [];
    const sets = await Promise.all(primaryCodes(lat, lon, maxKm).map(loadMesh));
    const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
    for (const set of sets) for (const row of set.m) {
      const b = meshBox(row[0]);
      const x0 = (b.w - lon) * kx, y0 = (b.s - lat) * ky, wx = b.dn * kx, hy = b.dl * ky;
      if (Math.hypot(x0 + wx / 2, y0 + hy / 2) > maxKm + 0.5) continue;
      const d = [];
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d.push(Math.hypot(x0 + wx * (j + 0.5) / N, y0 + hy * (i + 0.5) / N));
      cells.push({ d, v: row.slice(1) });
    }
    return cells;
  }
  // 中心から rIn より外、rOut 以内（rIn=0 なら円の中すべて）の人口・世帯を数える
  function sumWithin(rOut, rIn = 0) {
    const t = [0, 0, 0, 0, 0];
    for (const c of cur.cells) {
      let n = 0; for (const d of c.d) if (d > rIn && d <= rOut) n++;
      if (!n) continue;
      const f = n / c.d.length;
      for (let k = 0; k < 5; k++) t[k] += c.v[k] * f;
    }
    return { pop: t[0], hh: t[1], single: t[2], kids: t[3], senior: t[4] };
  }
  const radii = () => [
    Math.min(10, Math.max(0.25, +$("#r1").value || CFG.r1 || 1)),
    Math.min(10, Math.max(0.25, +$("#r2").value || CFG.r2 || 2)),
  ];

  // ---------------------------------------------------------------- 住所検索（国土地理院）
  async function geocode(addr) {
    const r = await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(addr));
    const j = await r.json();
    if (!j.length) throw new Error("住所が見つかりませんでした。都道府県から入力してみてください。");
    const [lon, lat] = j[0].geometry.coordinates;
    return { lat, lon, matched: j[0].properties.title };
  }

  // ---------------------------------------------------------------- 他社店舗
  const CLEANING_NAME = /クリーニング|ｸﾘｰﾆﾝｸﾞ|cleaning|ドライ|白洋舎|ホワイト急便|うさちゃん|ポニー/i;
  const LAUNDRY_NAME = /ランドリー|らんどりー|laundry|wash|ウォッシュ|ウオッシュ|コイン|洗濯|ざぶざぶ|アクア/i;

  async function compsGoogle(lat, lon, rKm) {
    const { Place } = await google.maps.importLibrary("places");
    // 半径に応じて範囲を分け、1回20件の上限で取りこぼさないようにする
    const n = rKm <= 2 ? 1 : rKm <= 5 ? 2 : 3;
    const dlat = rKm / 110.57, dlon = rKm / (111.32 * Math.cos(lat * Math.PI / 180));
    // 2通りで探す: ①「コインランドリー」で検索 ②Googleが「ランドリー」に分類しているお店（店名は問わない）
    const queries = [
      { textQuery: "コインランドリー" },
      { textQuery: "コインランドリー 洗濯 乾燥", includedType: "laundry", useStrictTypeFiltering: true },
    ];
    const jobs = [];
    for (const q of queries) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const s = lat - dlat + 2 * dlat * i / n, w = lon - dlon + 2 * dlon * j / n;
      jobs.push(Place.searchByText({
        ...q,
        fields: ["id", "displayName", "formattedAddress", "location", "businessStatus", "googleMapsURI", "photos"],
        locationRestriction: { south: s, west: w, north: s + 2 * dlat / n, east: w + 2 * dlon / n },
        maxResultCount: 20, language: "ja", region: "jp",
      }).then((r) => r.places).catch(() => []));
    }
    const lists = await Promise.all(jobs);
    const full = lists.some((l) => l.length >= 20);
    const seen = new Map();
    let excluded = 0;
    for (const p of lists.flat()) {
      if (seen.has(p.id) || p.businessStatus === "CLOSED_PERMANENTLY") continue;
      const name = p.displayName || "";
      // 店名にランドリー等が無く「クリーニング」だけの店は、クリーニング専門店とみなして除く
      const named = LAUNDRY_NAME.test(name);
      if (!named && CLEANING_NAME.test(name)) { excluded++; seen.set(p.id, null); continue; }
      const la = p.location.lat(), lo = p.location.lng();
      seen.set(p.id, {
        name, address: (p.formattedAddress || "").replace(/^日本、(〒\d{3}-\d{4} )?/, ""),
        lat: la, lon: lo, km: distKm(lat, lon, la, lo), url: p.googleMapsURI,
        closed: p.businessStatus === "CLOSED_TEMPORARILY", unsure: !named,
        photo: p.photos && p.photos[0] ? {
          // 写真は印刷するときだけ読み込む（読み込むたびに料金がかかるため）
          src: () => p.photos[0].getURI({ maxWidth: 640 }),
          by: (p.photos[0].authorAttributions || []).map((a) => a.displayName).filter(Boolean).join("、"),
        } : null,
      });
    }
    const comps = [...seen.values()].filter(Boolean).filter((c) => c.km <= rKm * 1.42);
    let note = "Googleマップで「コインランドリー」を検索した結果と、Googleがランドリーに分類しているお店です。";
    if (comps.some((c) => c.unsure)) note += "店名にランドリー等が入っていないお店には「要確認」と付けています。";
    if (excluded) note += `店名が「クリーニング」だけのお店${excluded}件は除いています。`;
    if (full) note += "店が多い地域のため、一部の店が出ていない可能性があります。";
    return { comps, note };
  }

  async function compsOSM(lat, lon, rKm) {
    const q = `[out:json][timeout:25];nwr["shop"="laundry"](around:${Math.round(rKm * 1420)},${lat},${lon});out center tags;`;
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) });
    const j = await r.json();
    const comps = j.elements.map((e) => {
      const la = e.lat ?? e.center.lat, lo = e.lon ?? e.center.lon, t = e.tags || {};
      return {
        name: t.name || "（名前なし）",
        address: [t["addr:province"], t["addr:city"], t["addr:quarter"], t["addr:neighbourhood"], t["addr:block_number"], t["addr:housenumber"]].filter(Boolean).join("") || "",
        lat: la, lon: lo, km: distKm(lat, lon, la, lo), hours: t.opening_hours,
        photo: /^https:\/\//.test(t.image || "") ? { src: () => t.image, by: "" } : null,
      };
    });
    return { comps, note: "OpenStreetMap に登録されたお店です。登録されていない店が多いため、実際より少なく出ます。" };
  }

  // ---------------------------------------------------------------- 地図
  const map = {
    async init() {
      if (USE_GOOGLE) {
        await google.maps.importLibrary("maps");
        this.g = new google.maps.Map($("#map"), {
          center: { lat: 35.68, lng: 139.76 }, zoom: 13, mapTypeControl: false, streetViewControl: false,
          fullscreenControl: true, clickableIcons: false, gestureHandling: "greedy",
        });
        this.objs = [];
      } else {
        this.l = L.map("map", { zoomControl: true });
        L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
          maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
        }).addTo(this.l);
        this.layer = L.layerGroup().addTo(this.l);
      }
    },
    draw(fit) {
      const [r1, r2] = radii(), { lat, lon } = cur;
      const accent = "#e2621b", rival = "#2f5f9f", grey = "#8a7d72";
      if (USE_GOOGLE) {
        this.objs.forEach((o) => o.setMap(null)); this.objs = [];
        const G = google.maps, add = (o) => this.objs.push(o);
        add(new G.Circle({ map: this.g, center: { lat, lng: lon }, radius: r1 * 1000, strokeColor: accent, strokeWeight: 3, fillColor: accent, fillOpacity: 0.08, clickable: false }));
        add(new G.Circle({ map: this.g, center: { lat, lng: lon }, radius: r2 * 1000, strokeColor: accent, strokeWeight: 2, strokeOpacity: 0.9, fillOpacity: 0, clickable: false }));
        add(new G.Marker({ map: this.g, position: { lat, lng: lon }, zIndex: 999, title: "候補地",
          icon: { path: "M0,-11 L11,0 L0,11 L-11,0 Z", fillColor: "#e2621b", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2, scale: 1.2 } }));
        cur.comps.forEach((c, i) => {
          const m = new G.Marker({ map: this.g, position: { lat: c.lat, lng: c.lon }, zIndex: 500 - i, title: c.name,
            label: { text: String(i + 1), color: "#fff", fontSize: "11px", fontWeight: "700" },
            icon: { path: G.SymbolPath.CIRCLE, scale: i === active ? 14 : 11, fillColor: c.km <= r2 ? rival : grey, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } });
          m.addListener("click", () => select(i, true));
          add(m);
        });
        if (fit) {
          const dlat = r2 / 110.57 * 1.05, dlon = r2 / (111.32 * Math.cos(lat * Math.PI / 180)) * 1.05;
          this.g.fitBounds({ south: lat - dlat, north: lat + dlat, west: lon - dlon, east: lon + dlon }, 8);
        }
      } else {
        this.layer.clearLayers();
        L.circle([lat, lon], { radius: r1 * 1000, color: accent, weight: 3, fillOpacity: 0.08 }).addTo(this.layer);
        L.circle([lat, lon], { radius: r2 * 1000, color: accent, weight: 2, dashArray: "8 6", fill: false }).addTo(this.layer);
        L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<i class="pin-own"></i>', iconSize: [18, 18] }), zIndexOffset: 1000 }).addTo(this.layer);
        cur.comps.forEach((c, i) => {
          const cls = "pin" + (c.km <= r2 ? "" : " out") + (i === active ? " on" : "");
          L.marker([c.lat, c.lon], { icon: L.divIcon({ className: cls, html: String(i + 1), iconSize: [24, 24] }), zIndexOffset: 500 - i })
            .on("click", () => select(i, true)).addTo(this.layer);
        });
        if (fit) this.l.invalidateSize();
        if (fit) this.l.fitBounds(L.latLng(lat, lon).toBounds(r2 * 2100));
      }
    },
    focus(c) {
      if (USE_GOOGLE) this.g.panTo({ lat: c.lat, lng: c.lon }); else this.l.panTo([c.lat, c.lon]);
    },
  };

  // ---------------------------------------------------------------- 表示
  function renderStats() {
    const [r1, r2] = radii();
    // 第2商圏は第1商圏の外側（ドーナツ型）だけを数える
    const lo = Math.min(r1, r2);
    $("#stats").innerHTML = [["第1商圏", 0, r1, `半径 ${r1}km`, ""], ["第2商圏", lo, r2, `${lo}〜${r2}km`, "dash"]].map(([label, rIn, r, range, cls]) => {
      const s = sumWithin(r, rIn), inR = cur.comps.filter((c) => c.km > rIn && c.km <= r), n = inR.length, u = inR.filter((c) => c.unsure).length;
      const size = s.hh ? (s.pop / s.hh).toFixed(2) : "-";
      const per = rIn ? ["他社1店あたり", n ? `${fmt(s.hh / n)}<small>世帯</small>` : "他社なし"] : ["自店を含む1店あたり", `${fmt(s.hh / (n + 1))}<small>世帯</small>`];
      return `<article class="card stat">
        <div class="stat-top"><span class="ring-tag"><span class="swatch ${cls}"></span>${label}</span><span class="radius-pill">${range}</span></div>
        <div class="hero-num"><span class="label">世帯数</span><span class="value">${fmt(s.hh)}</span><span class="unit">世帯</span></div>
        <div class="rival-bar"><span>他社のコインランドリー</span><b>${n}<small>店${u ? `（うち要確認${u}）` : ""}</small></b></div>
        <dl class="tiles">
          <div><dt>人口</dt><dd>${fmt(s.pop)}<small>人</small></dd></div>
          <div><dt>${per[0]}</dt><dd>${per[1]}</dd></div>
          <div><dt>単身世帯</dt><dd>${fmt(s.single)}<small>世帯</small></dd></div>
          <div><dt>6歳未満の子がいる</dt><dd>${fmt(s.kids)}<small>世帯</small></dd></div>
          <div><dt>65歳以上がいる</dt><dd>${fmt(s.senior)}<small>世帯</small></dd></div>
          <div><dt>平均世帯人員</dt><dd>${size}<small>人</small></dd></div>
        </dl></article>`;
    }).join("");
  }
  function renderList() {
    const [r1, r2] = radii(), ol = $("#list");
    ol.textContent = "";
    if (!cur.comps.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "見つかりませんでした。"; ol.appendChild(li); return; }
    cur.comps.forEach((c, i) => {
      const ring = c.km <= r1 ? ["第1商圏", ""] : c.km <= r2 ? ["第2商圏", "r2"] : ["商圏外", "out"];
      const li = document.createElement("li");
      li.className = "item" + (ring[1] === "out" ? " out" : "") + (i === active ? " active" : "");
      li.dataset.i = i;
      li.innerHTML = `<span class="num">${i + 1}</span><div class="body">
        <div class="top"><span class="name"></span><span class="km">${c.km.toFixed(1)}km</span></div>
        <div class="small muted addr"></div>
        <div class="chips"><span class="chip ${ring[1]}">${ring[0]}</span></div>
        <div class="links"><a target="_blank" rel="noopener">Googleマップで見る</a></div></div>`;
      li.querySelector(".name").textContent = c.name;
      li.querySelector(".addr").textContent = c.address;
      const chips = li.querySelector(".chips");
      if (c.hours) { const s = document.createElement("span"); s.className = "small"; s.textContent = "営業 " + c.hours; chips.appendChild(s); }
      if (c.unsure) { const s = document.createElement("span"); s.className = "chip out"; s.textContent = "要確認（店名にランドリーなし）"; chips.appendChild(s); }
      if (c.closed) { const s = document.createElement("span"); s.className = "chip warn"; s.textContent = "臨時休業中"; chips.appendChild(s); }
      li.querySelector("a").href = c.url || `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`;
      ol.appendChild(li);
    });
  }
  function select(i, scroll) {
    active = i; map.draw(false); map.focus(cur.comps[i]);
    document.querySelectorAll(".item").forEach((li) => li.classList.toggle("active", +li.dataset.i === i));
    if (scroll) { const el = document.querySelector(`.item[data-i="${i}"]`); el && el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
  function refresh(fit) {
    if (!cur) return;
    store.set("radius", radii());
    renderStats(); renderList(); renderPrint(); map.draw(fit);
  }

  // ---------------------------------------------------------------- A4印刷用
  const NEAR = 3, TABLE_MAX = 10;
  function renderPrint() {
    const [r1, r2] = radii(), d = new Date();
    $("#pmeta").textContent = `候補地: ${cur.address}　｜　第1商圏 ${r1}km・第2商圏 ${r2}km　｜　作成日 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    $("#psrc").textContent = "人口・世帯数: 総務省統計局「令和2年国勢調査」500mメッシュを商圏の円で按分　｜　" + $("#srcnote").textContent;
    const ring = (c) => (c.km <= r1 ? "第1商圏" : c.km <= r2 ? "第2商圏" : "商圏外");
    const label = (c) => c.name + (c.unsure ? "（要確認）" : "") + (c.closed ? "（臨時休業中）" : "");
    // 近い順に3店を写真つきで
    const near = $("#pnear"); near.textContent = "";
    const h = document.createElement("h3"); h.textContent = "候補地から近い他社コインランドリー"; near.appendChild(h);
    const row = document.createElement("div"); row.className = "pnear-row"; near.appendChild(row);
    cur.comps.slice(0, NEAR).forEach((c, i) => {
      const card = document.createElement("article"); card.className = "pcard";
      card.innerHTML = `<div class="pphoto"><span>写真なし</span></div><div class="pbody"><p class="pname"><b>${i + 1}</b><span></span></p><p class="pinfo"></p><p class="paddr"></p><p class="pby"></p></div>`;
      card.querySelector(".pname span").textContent = label(c);
      card.querySelector(".pinfo").textContent = `${c.km.toFixed(2)}km・${ring(c)}`;
      card.querySelector(".paddr").textContent = c.address;
      if (c.photo) {
        const img = document.createElement("img"); img.alt = ""; img.dataset.idx = i;
        card.querySelector(".pphoto").replaceChildren(img);
        card.querySelector(".pby").textContent = c.photo.by ? `写真: ${c.photo.by}（Google）` : "";
      }
      row.appendChild(card);
    });
    if (!cur.comps.length) { const p = document.createElement("p"); p.textContent = "近くに他社のコインランドリーは見つかりませんでした。"; row.appendChild(p); }
    // 第2商圏までの一覧（多いときは先頭から）
    const t = $("#ptable"); t.textContent = "";
    const rows = cur.comps.map((c, i) => [i + 1, c]).filter(([, c]) => c.km <= r2);
    t.innerHTML = `<caption>第2商圏までの他社（${rows.length}店・番号は地図と同じ）</caption>
      <thead><tr><th>No.</th><th>店名</th><th>距離</th><th>商圏</th></tr></thead><tbody></tbody>`;
    const tb = t.querySelector("tbody");
    if (!rows.length) tb.innerHTML = '<tr><td colspan="4">第2商圏の中に他社は見つかりませんでした。</td></tr>';
    for (const [no, c] of rows.slice(0, TABLE_MAX)) {
      const tr = document.createElement("tr");
      [no, label(c), c.km.toFixed(2) + "km", ring(c).replace("商圏", "")]
        .forEach((v) => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tb.appendChild(tr);
    }
    if (rows.length > TABLE_MAX) tb.insertAdjacentHTML("beforeend", `<tr><td colspan="4" class="more">ほか ${rows.length - TABLE_MAX}店（アプリの一覧をご覧ください）</td></tr>`);
  }
  // 印刷の直前に写真を読み込み、読み終わるのを待つ（最大5秒）
  function loadPhotos() {
    const imgs = [...document.querySelectorAll("#pnear img")];
    return Promise.race([
      Promise.all(imgs.map((img) => new Promise((ok) => {
        if (!img.src) { try { img.src = cur.comps[+img.dataset.idx].photo.src(); } catch (e) { return ok(); } }
        if (img.complete) return ok();
        img.onload = img.onerror = () => ok();
      }))),
      new Promise((ok) => setTimeout(ok, 5000)),
    ]);
  }
  // 地図を印刷用の大きさにしてから印刷する（地図の読み込みを少し待つ）
  let printing = false;
  function enterPrint() {
    if (printing) return; printing = true;
    document.body.classList.add("printing"); map.draw(true);
  }
  function leavePrint() {
    if (!printing) return; printing = false;
    document.body.classList.remove("printing"); setTimeout(() => map.draw(true), 50);
  }
  $("#printBtn").addEventListener("click", async () => {
    enterPrint();
    await Promise.all([loadPhotos(), new Promise((ok) => setTimeout(ok, 1500))]);
    window.print();
  });
  window.addEventListener("beforeprint", () => { if (cur) enterPrint(); });
  window.addEventListener("afterprint", leavePrint);
  function msg(text, err) { const m = $("#msg"); m.textContent = text; m.classList.toggle("err", !!err); m.hidden = !text; }

  async function run(addr) {
    const btn = $("#go"); btn.disabled = true;
    try {
      msg("住所を調べています…");
      const g = await geocode(addr);
      msg("人口・世帯数と周辺のお店を調べています…");
      const r2 = radii()[1];
      const searchKm = Math.max(r2, 3);
      const [cells, cres] = await Promise.all([
        buildCells(g.lat, g.lon),
        (USE_GOOGLE ? compsGoogle : compsOSM)(g.lat, g.lon, searchKm).catch((e) => ({ comps: [], note: "他社店舗の検索に失敗しました。時間をおいてもう一度お試しください。" })),
      ]);
      cres.comps.sort((a, b) => a.km - b.km);
      cur = { ...g, address: addr, cells, comps: cres.comps, searchKm };
      active = -1;
      $("#compnote").textContent = cres.note + `（半径${searchKm}kmまで検索）`;
      $("#matched").textContent = `${g.matched}（緯度 ${g.lat.toFixed(5)} / 経度 ${g.lon.toFixed(5)}）`;
      $("#gmap").href = `https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lon}`;
      $("#result").hidden = false;
      await mapReady;
      if (!cells.length) msg("この場所の人口データが見つかりませんでした。", true); else msg("");
      refresh(true);
      const rec = (store.get("recent") || []).filter((a) => a !== addr); rec.unshift(addr); store.set("recent", rec.slice(0, 5));
      renderRecent();
    } catch (e) {
      msg(e.message || "うまく調べられませんでした。通信環境を確認して、もう一度お試しください。", true);
    } finally { btn.disabled = false; }
  }

  function renderRecent() {
    const box = $("#recent"); box.textContent = "";
    (store.get("recent") || []).forEach((a) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = a;
      b.onclick = () => { $("#addr").value = a; run(a); };
      box.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- 起動
  $("#form").addEventListener("submit", (e) => { e.preventDefault(); const a = $("#addr").value.trim(); if (a) run(a); });
  ["r1", "r2"].forEach((id) => $("#" + id).addEventListener("input", () => refresh(false)));
  document.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => {
    const el = $("#" + b.dataset.t); el.value = Math.min(10, Math.max(0.25, Math.round(((+el.value || 0) + +b.dataset.d) * 4) / 4)); refresh(true);
  }));
  $("#list").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const li = e.target.closest(".item"); if (li) { select(+li.dataset.i, false); $("#map").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  });
  const saved = store.get("radius");
  $("#r1").value = saved ? saved[0] : CFG.r1 || 1;
  $("#r2").value = saved ? saved[1] : CFG.r2 || 3;
  $("#srcnote").textContent = USE_GOOGLE ? "他社店舗・地図: Google マップ" : "他社店舗: OpenStreetMap";
  renderRecent();

  function loadGoogle() {
    return new Promise((resolve, reject) => {
      window.__gmReady = resolve;
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CFG.googleApiKey)}&v=weekly&language=ja&region=JP&loading=async&callback=__gmReady`;
      s.onerror = reject; document.head.appendChild(s);
    });
  }
  const mapReady = (USE_GOOGLE ? loadGoogle() : Promise.resolve()).then(() => map.init())
    .catch(() => msg("地図を読み込めませんでした。APIキーの設定を確認してください。", true));
})();
