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
  function sumWithin(r) {
    const t = [0, 0, 0, 0, 0];
    for (const c of cur.cells) {
      let n = 0; for (const d of c.d) if (d <= r) n++;
      if (!n) continue;
      const f = n / c.d.length;
      for (let k = 0; k < 5; k++) t[k] += c.v[k] * f;
    }
    return { pop: t[0], hh: t[1], single: t[2], kids: t[3], senior: t[4] };
  }
  const radii = () => [
    Math.min(10, Math.max(0.5, +$("#r1").value || CFG.r1 || 1)),
    Math.min(10, Math.max(0.5, +$("#r2").value || CFG.r2 || 3)),
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
  const LAUNDRY_NAME = /ランドリー|らんどりー|laundry|wash|ウォッシュ|ウオッシュ|コイン|洗濯|ざぶざぶ|アクア/i;

  async function compsGoogle(lat, lon, rKm) {
    const { Place } = await google.maps.importLibrary("places");
    // 半径に応じて範囲を分け、1回20件の上限で取りこぼさないようにする
    const n = rKm <= 2 ? 1 : rKm <= 5 ? 2 : 3;
    const dlat = rKm / 110.57, dlon = rKm / (111.32 * Math.cos(lat * Math.PI / 180));
    const jobs = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const s = lat - dlat + 2 * dlat * i / n, w = lon - dlon + 2 * dlon * j / n;
      jobs.push(Place.searchByText({
        textQuery: "コインランドリー",
        fields: ["id", "displayName", "formattedAddress", "location", "businessStatus", "googleMapsURI"],
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
      if (!LAUNDRY_NAME.test(name)) { excluded++; seen.set(p.id, null); continue; }
      const la = p.location.lat(), lo = p.location.lng();
      seen.set(p.id, {
        name, address: (p.formattedAddress || "").replace(/^日本、(〒\d{3}-\d{4} )?/, ""),
        lat: la, lon: lo, km: distKm(lat, lon, la, lo), url: p.googleMapsURI,
        closed: p.businessStatus === "CLOSED_TEMPORARILY",
      });
    }
    const comps = [...seen.values()].filter(Boolean).filter((c) => c.km <= rKm * 1.42);
    let note = "Googleマップで「コインランドリー」を検索した結果です。";
    if (excluded) note += `名前にランドリー等が入っていない${excluded}件（クリーニング店など）は除いています。`;
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
    $("#stats").innerHTML = [["第1商圏", r1, ""], ["第2商圏", r2, "dash"]].map(([label, r, cls]) => {
      const s = sumWithin(r), n = cur.comps.filter((c) => c.km <= r).length;
      const size = s.hh ? (s.pop / s.hh).toFixed(2) : "-";
      return `<article class="card stat">
        <div class="stat-top"><span class="ring-tag"><span class="swatch ${cls}"></span>${label}</span><span class="radius-pill">半径 ${r}km</span></div>
        <div class="hero-num"><span class="label">世帯数</span><span class="value">${fmt(s.hh)}</span><span class="unit">世帯</span></div>
        <div class="rival-bar"><span>他社のコインランドリー</span><b>${n}<small>店</small></b></div>
        <dl class="tiles">
          <div><dt>人口</dt><dd>${fmt(s.pop)}<small>人</small></dd></div>
          <div><dt>自店を含む1店あたり</dt><dd>${fmt(s.hh / (n + 1))}<small>世帯</small></dd></div>
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
    renderStats(); renderList(); map.draw(fit);
  }
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
    const el = $("#" + b.dataset.t); el.value = Math.min(10, Math.max(0.5, (+el.value || 0) + +b.dataset.d)); refresh(true);
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
