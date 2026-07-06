# Boot Routeplanner Loosdrecht v15 - iPad PWA

Deze versie is bedoeld om als web-app op je iPad te gebruiken.

## Belangrijk
Een iPad kan deze zip niet rechtstreeks als echte iPadOS-app installeren. De praktische oplossing is een PWA: de app staat op een URL, je opent die een keer in Safari en zet hem daarna op je beginscherm.

## Aanbevolen route
1. Zet de inhoud van deze map online als statische website, bijvoorbeeld via GitHub Pages.
2. Open de website op je iPad in Safari.
3. Tik op Delen -> Zet op beginscherm.
4. Zet Open als webapp aan.
5. Tik op Voeg toe.

Daarna start hij als app-icoon. Na de eerste keer laden werkt de app grotendeels offline via de service worker.

## Eigen routes en bruggen bewaren
De editor slaat testdata op in Safari-opslag. Exporteer daarom regelmatig je custom_network.geojson en zet dat bestand terug in data/custom_network.geojson voordat je een nieuwe versie online zet.

## Bestanden
- index.html
- app.js
- styles.css
- manifest.json
- service-worker.js
- data/custom_network.geojson
- icons/
