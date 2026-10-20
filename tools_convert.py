# e-Stat 500mメッシュ(T001141)の zip/txt を、アプリ用の軽い JSON (data/mesh/<1次メッシュ>.json) に変換する
import csv, io, json, os, sys, zipfile
SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
KEYS = [lambda s: s == "人口（総数）", lambda s: s == "世帯総数", lambda s: s.startswith("１人世帯数"),
        lambda s: s.startswith("６歳未満世帯員のいる世帯数"), lambda s: s.startswith("６５歳以上世帯員のいる世帯数")]
def num(s):
    try: return int(float(s))
    except ValueError: return 0
for f in sorted(os.listdir(SRC)):
    p = os.path.join(SRC, f)
    if f.endswith(".zip"):
        z = zipfile.ZipFile(p); raw = z.read([n for n in z.namelist() if n.endswith(".txt")][0])
    elif f.endswith(".txt"): raw = open(p, "rb").read()
    else: continue
    rows = list(csv.reader(io.StringIO(raw.decode("cp932"))))
    lab = [l.replace("　", "").strip() for l in rows[1]]
    cols = [next(i for i, l in enumerate(lab) if k(l)) for k in KEYS]
    m = []
    for r in rows[2:]:
        if r and len(r[0].strip()) == 9:
            v = [num(r[c]) for c in cols]
            if any(v): m.append([int(r[0])] + v)
    code = str(m[0][0])[:4] if m else None
    if code:
        json.dump({"m": m}, open(os.path.join(OUT, code + ".json"), "w"), separators=(",", ":"))
print("ok", len(os.listdir(OUT)))
