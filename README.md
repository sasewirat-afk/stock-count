# Stock Count — CCO / Crochet / MTP

PWA (Progressive Web App) สำหรับนับสต๊อกสินค้า + รับสินค้าเข้า + รวมผลการนับจากหลายเครื่อง

**v2.0.0 — Pure Local Architecture** — ข้อมูลทั้งหมดเก็บใน Browser (IndexedDB) ไม่มี Cloud sync ไม่ต้องตั้งค่าใดๆ ใช้งานเร็ว reliable

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

---

## ✨ ฟีเจอร์หลัก

| Feature | คำอธิบาย |
|---|---|
| 📋 **Stock Count** | Upload Excel ตั้งต้น → ยิง Barcode → ดูส่วนต่าง → Export |
| 📥 **Goods Receive** | รับสินค้าใหม่ — ยิง 1 ครั้ง = +1 ชิ้น Lookup จาก Master Auto |
| 🔀 **Merge Tool** | รวมไฟล์ Excel หลายเครื่อง → SUM ยอด + Detect Conflict |
| ✏️ **Edit Item** | แก้ Barcode + Qty Initial ของรายการได้ (กัน duplicate) |
| 📂 **Batch Import** | Upload Excel จดยอดนับ → Auto match + apply |
| 📷 **Camera Scan** | สแกน Barcode ด้วยกล้องมือถือ (HTTPS only) |
| 🔧 **Filter** | Type / Size / Color / Status + Search |
| 📥 **Excel Export** | 2 sheets (Stock Count + Summary) ครบทุก Status |

## 📦 รูปแบบ Barcode (สำคัญ)

ระบบนี้ **เก็บ Barcode เป็น Text เสมอ** ทุก layer ตามรายละเอียดใน [`docs/adr/0002-barcode-as-text-only.md`](../docs/adr/0002-barcode-as-text-only.md):

- ✅ รักษา leading zeros (`00012345` → `00012345`)
- ✅ ป้องกัน Scientific notation (`6941848248602` ไม่กลายเป็น `6.94E+12`)
- ✅ รับ Code-128 alphanumeric (`ABC-123`)
- ✅ Export ล็อก cell format เป็น Text (`@`) — Excel ไม่แปลงกลับ

---

## 🚀 Deploy บน Vercel ผ่าน GitHub (แนะนำ)

### 1) สร้าง GitHub Repository

```bash
# ในโฟลเดอร์ Stock_Count_App/
git init
git add .
git commit -m "Initial commit: Stock Count v2.0.0"

# สร้าง repo ใหม่บน github.com/new ก่อน เช่นชื่อ "stock-count"
git remote add origin https://github.com/YOUR_USERNAME/stock-count.git
git branch -M main
git push -u origin main
```

### 2) เชื่อม Vercel กับ GitHub

1. ไปที่ [vercel.com/new](https://vercel.com/new)
2. กด **Import Git Repository** → เลือก `stock-count`
3. **Framework Preset:** เลือก **Other** (เพราะเป็น static HTML)
4. **Build Command:** เว้นว่าง (ไม่ต้อง build)
5. **Output Directory:** เว้นว่าง (root)
6. กด **Deploy** — รอประมาณ 30 วินาที

หลังจากนั้นทุกครั้งที่ `git push` ใหม่ Vercel จะ Deploy อัตโนมัติ

---

## 🛠️ Deploy แบบอื่นๆ

### Option B: Drag-Drop บน Vercel (ไม่ต้อง Git)

1. ไปที่ [vercel.com/new](https://vercel.com/new)
2. ลากโฟลเดอร์ `Stock_Count_App/` ทั้งหมดวาง
3. กด Deploy

### Option C: Local HTTP Server (ทดสอบ)

```bash
cd Stock_Count_App
python -m http.server 8080
# เปิด http://localhost:8080
```

### Option D: USB / file:// (Offline 100%)

ดับเบิลคลิก `index.html` เลย
**ข้อจำกัด:** กล้องสแกนไม่ทำงาน + Service Worker ปิด ใช้ USB scanner เท่านั้น

---

## 📁 โครงสร้างไฟล์

```
Stock_Count_App/
├── index.html              # HTML shell + CSS
├── app.js                  # Application logic (Pure Local)
├── service-worker.js       # PWA offline cache
├── manifest.json           # PWA manifest
├── icon-192.png            # PWA icon
├── icon-512.png            # PWA icon
├── vercel.json             # Vercel configuration
├── .gitignore
├── LICENSE
└── README.md
```

---

## 🧰 Tech Stack

| Library | Use |
|---|---|
| [Dexie](https://dexie.org) v3.2.4 | IndexedDB wrapper |
| [SheetJS](https://sheetjs.com) (xlsx) v0.18.5 | Excel read/write |
| [html5-qrcode](https://github.com/mebjas/html5-qrcode) v2.3.8 | Camera barcode scanning |

ทั้งหมดโหลดจาก CDN (jsdelivr) Service Worker cache สำหรับ offline

---

## 📚 เอกสารเพิ่มเติม

- [`CONTEXT.md`](../CONTEXT.md) — Domain glossary
- [`docs/adr/0001-pure-local-architecture.md`](../docs/adr/0001-pure-local-architecture.md) — ทำไมไม่ใช้ Cloud
- [`docs/adr/0002-barcode-as-text-only.md`](../docs/adr/0002-barcode-as-text-only.md) — Barcode text invariant
- [`../Change_Log.xlsx`](../Change_Log.xlsx) — Version history

---

## 🔧 Troubleshooting

### กล้องไม่เปิด
- ใช้ HTTPS (Vercel auto-HTTPS) — file:// และ http:// browser block getUserMedia
- อนุญาต permission ครั้งแรก
- ใช้ USB scanner แทน

### Service Worker ไม่ทำงาน
- เปิดผ่าน http(s):// (file:// ไม่รองรับ)
- Hard refresh: `Ctrl+Shift+R` (Windows) / `Cmd+Shift+R` (Mac)

### Excel import บางคอลัมน์ผิด
- ตรวจหัวคอลัมน์ — ต้องมีอย่างน้อย `Barcode` หรือ `SKU`
- รองรับ Shopify Export (Variant Barcode, Variant SKU, Option1 Value, Vendor, Title)

### Barcode กลายเป็น Scientific Notation
- v2.0+ ไม่มีปัญหานี้แล้ว — ระบบใช้ raw cell value + lock cell format
- ถ้ายังเจอ: ตรวจ source Excel — ตั้ง Format Cells → Text สำหรับคอลัมน์ Barcode ก่อน save

---

## 📝 License

MIT — ดู [LICENSE](LICENSE)

---

## 🤝 Contributing

ภายในทีม CCO / Crochet / MTP เท่านั้น สำหรับ feature request / bug report — Issue บน GitHub repo
