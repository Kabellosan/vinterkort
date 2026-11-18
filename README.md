# Vinterkort

Phone web app for winter salting rounds: open a work-order PDF (map screenshot with coloured areas), calibrate it once against a satellite map, and see your live GPS position on it. Works offline after the first visit. PDFs are stored only on the phone (IndexedDB); nothing is uploaded.

Open: https://kabellosan.github.io/vinterkort/

- `index.html`, `app.js`: the app
- `sw.js`, `manifest.webmanifest`: offline support, install, Android "share to"
- `lib/`: Leaflet 1.9.4 and pdf.js 3.11.174 (vendored)

Satellite imagery: Esri World Imagery. Address search: OpenStreetMap Nominatim.
