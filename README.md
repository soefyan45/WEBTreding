# AI Trading Signal — XAUUSD M15

Chrome/Brave extension (MV3) yang menganalisa chart **XAUUSD M15** di Exness
WebTerminal, meminta verdict dari LLM melalui pipeline **debat 2 tahap**
(analis → pendebat kontrarian), lalu menampilkan sinyal, level S/R, tren, dan
rencana posisi — lengkap dengan visual di chart.

> **Eksekusi manual.** Extension tidak pernah mengirim order sendiri. Ia hanya
> menyiapkan panel order; kamu yang menekan Buy/Sell + Confirm. Trailing stop
> juga hanya jalan saat tombol ditekan.

> **Tujuan & etika penggunaan.** Extension ini murni alat bantu analisa: ia
> **membaca data yang sudah tampil di halaman** (harga pada judul tab, posisi
> pada DOM) lalu mengolahnya dengan indikator teknikal dan LLM/AI model agar
> user lebih mudah menganalisa — bukan untuk mengeksploitasi, mem-bypass
> proteksi, atau merusak platform. Tidak ada scraping tersembunyi, tidak ada
> manipulasi order, dan tidak ada akses di luar yang diizinkan WebTerminal
> sendiri kepada usernya. Pertanggungjawaban kepatuhan terhadap ToS broker
> tetap di tangan pengguna.

## Fitur

- **Candle builder M15** — sampling tick harga dari halaman WebTerminal,
  disimpan di `chrome.storage.local` (+ backfill riwayat candle).
- **Indikator teknikal** — SMA9/SMA21, RSI14, ATR14, Bollinger Bands, MACD
  histogram, slope SMA9 (hint arah tren).
- **Level S/R + breakout** — deteksi support/resistance dari candle, bisa
  digambar ke chart (garis + label touches).
- **Pipeline debat 2 tahap** —
  1. *Analis*: LLM menghasilkan sinyal + confidence + trend + target price +
     `keyRisks`.
  2. *Pendebat kontrarian*: LLM kedua mencoba membantah pakai data yang sama;
     kalau menolak dan punya sinyal alternatif, verdict final dihitung di JS
     (`decideFinal`).
  Prosesnya transparan — 3 baris debat tampil di side panel (blok collapsible),
  tersimpan di `lastSignal.process`.
- **Visual pro di chart** — garis tren historis + panah/target prediksi
  (hanya untuk sinyal non-WAIT), rencana posisi (entry/SL/TP) digambar sebagai
  overlay.
- **Side panel kontrol penuh** — Analyze Now, backfill, gambar/hapus S/R &
  posisi & tren, trailing stop, export CSV log sinyal, dan **Settings**.
- **Settings runtime** — volume, SL/TP default, min SL, trailing, loop interval,
  model, **LLM Base URL + API key** (kosong = fallback ke `config.js`).
- **Loop otomatis** — `chrome.alarms` menjalankan analisa tiap
  `loopIntervalMin` menit (default 15), tahan SW MV3 tetap hidup.

## Struktur

```
extension/
  manifest.json        MV3, side panel, content script Exness
  background.js        SW: router pesan, pipeline analisa, LLM, chart drawing
  content.js           MAIN-world bridge: tick harga, overlay, order panel
  panel.js             controller bersama popup & side panel
  indicators.js        hitung indikator + slope + ringkasan 5 candle
  candle-builder.js    agregasi tick → candle M15
  sr.js                deteksi level S/R
  settings.js          defaults + sanitize + storage.sync
  config.js            nilai live — GIT-IGNORED, jangan commit
  config.example.js    template — cp ke config.js lalu isi
  sidepanel.html       UI side panel
  popup.html           UI popup (subset panel)
dev/
  launch-brave.sh      Brave + remote debugging 9222 + load extension
  watch-reload.mjs     watcher: save file → reload SW + tab Exness
  cdp.mjs              helper CDP (eval, console, sniff, panel, sw)
```

> `prd.md` (spesifikasi asli + catatan keputusan) ada di repo tapi
> **git-ignored** — dokumen internal, tidak ikut dilacak.

## Setup

### 1. Config LLM

```bash
cd extension
cp config.example.js config.js
# edit config.js — isi LLM_BASE_URL + LLM_API_KEY milikmu
```

`config.js` ada di `.gitignore` — secret tidak pernah masuk repo. Semua nilai
(Base URL, API key, model) juga bisa dioverride runtime dari **Settings** di
side panel; nilai kosong di settings = pakai default `config.js`.

### 2. Load extension

**Cara dev (recommended):**

```bash
./dev/launch-brave.sh
```

Meluncurkan Brave (auto-detect `brave-origin-stable`) dengan profile dev
terpisah (`~/.brave-trading-dev`), remote debugging di port 9222, dan extension
ter-preload. Login Exness cukup sekali per profile.

**Cara manual:** `chrome://extensions` → Developer mode → Load unpacked →
pilih folder `extension/`.

### 3. Dev loop

```bash
node dev/watch-reload.mjs   # terminal 1 (opsional)
```

Simpan file di `extension/` → service worker + tab Exness auto-reload.
Watcher menemukan port CDP dari `BRAVE_DEV_PORT`, file `DevToolsActivePort`
di profile Brave, atau default 9222.

Debug helper:

```bash
node dev/cdp.mjs eval "document.title"      # eval di tab Exness
node dev/cdp.mjs console                    # dump log console
node dev/cdp.mjs sniff                      # capture network 8s
```

> Catatan MV3: service worker yang dormant hilang dari daftar target CDP — itu
> normal, bukan crash. Reload tab Exness untuk membangunkannya.

## Cara pakai

1. Buka Exness WebTerminal di browser dev, login.
2. Klik ikon extension → side panel terbuka (atau buka `sidepanel.html`).
3. **Analyze Now** → pipeline berjalan (~45–120s, 2 panggilan LLM + retry):
   - indikator + level dihitung dari candle tersimpan,
   - analis menghasilkan verdict,
   - pendebat mencoba membantah,
   - final verdict + debat tampil di panel, visual digambar ke chart.
4. **Gambar S/R** / **Gambar Posisi** untuk overlay visual; pasangkan tombol
   Clear untuk menghapus.
5. **Isi Order** menyiapkan panel order di WebTerminal sesuai sinyal terakhir —
   **kamu tetap yang konfirmasi**.
6. **Trail SL** menggeser SL semua posisi mengikuti harga.
7. Settings (gear): volume, SL/TP, trailing, interval loop, model, LLM
   endpoint/key. Save untuk persist (chrome.storage.sync).

## Arsitektur singkat

```
content.js (Exness page)          background.js (SW, ES module)
  ├─ PRICE_TICK ──────────────────▶ candle builder → storage
  ├─ REQUEST_SIGNAL ◀────────────▶ runAnalysis():
  │                                  computeIndicators → computeLevels
  │                                  → askAnalyst  (LLM #1)
  │                                  → askDebater  (LLM #2, kontrarian)
  │                                  → decideFinal (JS)
  ├─ DRAW_SR / DRAW_POSITION /     → scripting.inject, gambar di chart
  │   DRAW_TREND (+CLEAR_*)
  ├─ PREPARE_ORDER                 → isi panel order (tanpa submit)
  └─ TRAIL_STOPS                   → modify SL posisi terbuka
```

- `chrome.storage.local` — candle, sinyal, posisi, state analisa.
- `chrome.storage.sync` — settings (ikut akun Chrome).
- `chrome.alarms` — loop analisa otomatis; alarm selamat dari SW restart.

## Keamanan & batasan

- **Tidak ada auto-trade.** Order selalu butuh klik manual; extension hanya
  menyiapkan panel.
- **`config.js` git-ignored.** API key hanya hidup di mesinmu (atau override
  via Settings panel, tersimpan di `chrome.storage.sync` akun Chrome).
- Guard anti-double-run (`analyzing` + `analysisAt` di storage) — tombol
  Analyze recover sendiri kalau SW mati di tengah analisa.
- LLM proxy bisa flaky (SSE terpotong, reasoning model jawab di
  `reasoning_content`) — `readLLMBody`/`parseLLMJson` toleran + retry 3×.
- Kegagalan stage debat bersifat non-fatal; kegagalan analis jatuh ke
  fallback heuristik.
- **Demo first.** Dirancang untuk diuji di akun demo dulu.

## Dependensi

**Nol dependency eksternal** — tidak ada `package.json`, tidak ada library,
tidak ada build step. Semua kode JavaScript ES2022 native.

API platform yang dipakai:

| API | Pakai untuk |
|---|---|
| `chrome.storage` (local/sync) | candle, sinyal, settings |
| `chrome.alarms` | loop analisa otomatis |
| `chrome.scripting` + `chrome.sidePanel` | injeksi chart, side panel |
| `fetch` / `WebSocket` (dev) | LLM proxy, kalender, CDP |

Service eksternal:

| Service | Fungsi |
|---|---|
| LLM proxy (OpenAI-compatible, user-own) | analisa + debat |
| [FXMacroData](https://api.fxmacrodata.com) | kalender ekonomi USD high-impact (gratis, no key) |
| Exness WebTerminal | sumber harga, chart, posisi, order |

## Roadmap (dari PRD)

| Item | Status |
|---|---|
| Price sampling + candle M15 + indikator | ✅ |
| Analisa LLM + pipeline debat 2 tahap | ✅ |
| Overlay visual (S/R, posisi, tren) | ✅ |
| Side panel + settings runtime | ✅ |
| Trailing stop (manual trigger) | ✅ |
| Eksekusi order via rtapi Exness | ⏳ router ada (`EXECUTE_ORDER`), logika belum |
| Multi-symbol / broker lain | ❌ out of scope — Exness-only by design |
| Auto-execute tanpa konfirmasi | ❌ tidak akan pernah, by design |

Prinsip desain: Linux native, zero cost, zero install, transparan (user lihat
indikator + alasan + debat LLM), token session dibaca fresh tanpa disimpan,
manual confirm selalu.

## Disclaimer

Proyek ini **tidak berafiliasi dengan Exness**, TradingView, maupun penyedia
LLM yang dipakai. Semua merek adalah milik pemiliknya.

- **Tidak menjanjikan profit.** Apapun output LLM-nya — sinyal, confidence,
  target price — itu bukan jaminan apa pun. Extension ini hanya memindahkan
  kerja analisa ke AI; hasilnya tetap bisa salah, dan pasar bisa melawan
  sinyal terbaik sekalipun.
- **Bukan alat "auto-cuan".** Yang extension ini berikan cuma satu hal:
  kamu bisa pakai LLM yang terintegrasi langsung dengan WebTerminal — data
  chart nyata masuk ke prompt, verdict kembali ke chart. Selebihnya (kapan
  entry, risk, disiplin) tetap keputusan dan tanggung jawabmu.
- **Sinyal LLM bukan nasihat keuangan.** Trading emas berisiko tinggi, uji
  di akun demo dulu, tanggung jawab sepenuhnya milik pengguna.

## Lisensi

[MIT](LICENSE) — kode 100% original, zero dependency, bebas dipakai/modifikasi.
