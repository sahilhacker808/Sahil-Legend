# 🤖 SAHIL 804 BOT — No Firebase Edition

**Firebase مکمل ہٹا دی گئی — سب کچھ Local JSON Files میں store ہوتا ہے**

## ✅ Changes Made
- Firebase Admin SDK removed from dependencies
- All data stored in `/data/` folder (JSON files)
- WhatsApp sessions stored in `/src/auth_info_baileys/`
- No internet connection needed for database operations

## 🚀 Setup

```bash
# 1. Dependencies install کریں
npm install

# 2. .env file بنائیں
cp .env.example .env

# 3. .env میں یہ values ضرور بھریں:
SESSION_SECRET=your_random_32_char_string
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD=YourStrongPassword@123

# 4. Bot چلائیں
npm start
```

## 📁 Data Storage

| پرانا (Firebase) | نیا (Local) |
|-----------------|------------|
| Firestore users | `/data/users/*.json` |
| Firestore sessions | `/data/sessions/*.json` |
| Firestore subscriptions | `/data/subscriptions/*.json` |
| RTDB whatsapp_sessions | `/src/auth_info_baileys/` |

## ⚙️ Optional API Keys (in .env)
```
RAPIDAPI_KEY=     # YouTube, TikTok, Facebook, Instagram downloads
OMDB_API_KEY=     # Movie info (.movie command)
OPENWEATHER_KEY=  # Weather (.weather2 command)
```

## 👑 Owner: Legend Sahil Hacker 804
