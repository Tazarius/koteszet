# Kötészet – jegyzet Claude-nak

Telepíthető webapp (PWA), ami könyvoldal-fotókból kereshető képes PDF-et és EPUB-ot készít, magyar OCR-rel (tesseract.js), teljesen a telefonon.

- Terv, döntések, ütemterv: https://claude.ai/artifact/MuZL3CEhvnQuRjv25yfjH9 (Claude Docs, „Kötészet – terv és leírás”). Munka előtt olvasd el, munka után frissítsd a „Jelenlegi állapot” és „Ütemterv” részt.
- Élő app: https://tazarius.github.io/koteszet/ (GitHub Pages, main ág, gyökér).
- Nincs build: `index.html` + `clean.js` (a kiolvasott szöveg szűrése, Node-ban is tesztelhető) + `app.js` + `sw.js`. Kiadáskor emeld a `VERSION` értékét az `sw.js`-ben és az `APP_VERSION`-t az `app.js`-ben (ez látszik a könyvtár alján), különben a telepített appok nem frissülnek.
- Minden adat a készüléken (IndexedDB `koteszet`), szerver nincs. Könyvszkenneket soha ne tegyél a repóba.
- A felhasználó (Péter) magyarul kommunikál; a felület szövegei magyarok.
- Tesztelés: helyi `python3 -m http.server` + Playwright Chromium (`/opt/pw-browsers/chromium`), valós fotókkal.
