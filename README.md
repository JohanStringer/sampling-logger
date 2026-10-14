# Micro Sampling Logger

Field log for microscopy sampling. One web app (PWA) with two modes:

| Mode | Device | Does |
|---|---|---|
| **Phone** | Android (Chrome) | Excursions, locations with GPS, samples with photos, dictation. Data lives in the browser's storage on the phone. |
| **Laptop** | Windows (Edge or Chrome) | Library: view everything, correct text fields, maps. Data lives in a folder you choose, e.g. on the NAS. |

The mode is picked automatically (touch screen → phone, otherwise laptop) and can be changed under **Settings**.

## Getting it running (test environment)

The app needs HTTPS for GPS, the microphone, the camera and offline use. Any static host works:

1. **GitHub Pages (permanent, free):** create a repository, upload the contents of this folder, then *Settings → Pages → Deploy from branch → main / root*. The address becomes `https://<user>.github.io/<repo>/`.
2. **Netlify Drop (quickest try):** drag this folder onto https://app.netlify.com/drop. Without a Netlify account the site is removed after an hour.

On the phone, open the address in Chrome, then use the menu → *Add to Home screen* (or *Settings → Install as app*). On the laptop, open the same address in Edge and choose *Install app* in the address bar.

`index.html` from the file system (double-click) does **not** work: browsers block these features outside HTTPS.

## Phone → laptop

* Every change on the phone marks that excursion **Not sent** (the *dirty* flag).
* Home screen → **Send to laptop** builds one ZIP package with all dirty excursions, then *Share* (Google Drive, Synology Drive, email…) or *Save* (Downloads, copy over USB).
* The phone clears the flag when the package was shared or saved. It cannot see whether the laptop imported it; *Settings → Send all excursions* rebuilds a complete package at any time.
* Laptop → **Import from phone** → pick the ZIP. Each excursion in it **replaces** the laptop version completely. If you corrected that excursion on the laptop after the previous import, the laptop asks first.
* Corrections made on the laptop stay on the laptop; they do not flow back to the phone.

## Laptop library on a NAS

*Settings → Library folder → Choose folder.* For a NAS, map the share as a network drive in Windows first (Explorer → *This PC → Map network drive*, e.g. `Z:`) and pick a folder on it. Edge remembers the folder; after a restart it asks once for permission (one click).

## Data format (for the Swammerdam add-on and anything else)

The laptop library, a package ZIP, and an unzipped package all use the same layout:

```
<library or package root>/
  package.json                                  (packages only)
  2026-10-14_pond-walk-maaspoort_434c9292/      one folder per excursion: <date>_<slug>_<first 8 hex of id>
    excursion.json
    excursion.kml                               all located points, opens in Google Earth / My Maps
    photos/
      L01_location_1.jpg                        location photos
      L01_S01_container.jpg                     sample photos: L<location>_S<sample>_<kind>
      L01_S01_specimen.jpg
      L01_S01_context.jpg
```

`excursion.json`:

```json
{
  "format": "micro-sampling-logger",
  "version": 1,
  "app": "0.2.0",
  "saved": "2026-10-14T14:20:25.180Z",
  "library": { "importedAt": "…", "source": "msl-package_….zip", "laptopEdited": "…" },
  "excursion": {
    "id": "uuid", "title": "Pond walk Maaspoort", "goal": "Look for desmids",
    "created": "ISO-8601", "updated": "ISO-8601",
    "locations": [{
      "id": "uuid", "number": 1, "title": "Location 1", "description": "",
      "gps": { "lat": 51.7071, "lon": 5.3195, "acc": 5, "alt": null, "time": "ISO-8601", "manual": false },
      "created": "…", "updated": "…",
      "photos": ["photos/L01_location_1.jpg"],
      "samples": [{
        "id": "uuid", "number": 1, "title": "Sample 1", "notes": "Green film on stones",
        "created": "…", "updated": "…",
        "container": "photos/L01_S01_container.jpg",
        "specimen": "photos/L01_S01_specimen.jpg",
        "context": null
      }]
    }]
  }
}
```

Rules a reader can rely on:

* `id` values are stable UUIDs. Link microscope observations to `excursion.id` + `sample.id`, not to titles or folder names.
* Photo paths are relative to the excursion folder; `null` means no photo.
* `gps` is WGS84 decimal degrees; `acc` is the phone's accuracy estimate in metres (0 when typed in by hand, `manual: true`). `gps` itself may be `null`.
* `library` exists only in the laptop library. `laptopEdited` later than `importedAt` means someone corrected text on the laptop.
* A new import **deletes and rewrites** the excursion folder. An add-on should keep its own data outside these folders (or in a sibling file it owns), keyed by the ids above.
* Unknown fields may be added in later versions; `version` changes only for breaking changes.

## Texts and translations

* All UI text lives in `js/texts.js`, one entry per ID with a column per language (en, nl, fr, de).
* In the app: *Settings → Edit texts by tapping them*, then tap any label. Or *Settings → All texts* to search the full list.
* *Download spreadsheet* gives an .xlsx with `id` and one column per language. Edit it, then *Import spreadsheet*. A new column with a language code (e.g. `es`) adds that language.
* Edits are stored on that device only. *Download texts.json* exports the merged result; paste it into `js/texts.js` (after `const TEXTS =`) to make it the default everywhere.

## Files

```
index.html, manifest.webmanifest, sw.js (offline cache), icons/
css/app.css      design
js/texts.js      text repository
js/app.js        app logic
vendor/          Leaflet (map), JSZip (packages), SheetJS (spreadsheets), kept local for offline use
```

Maps use OpenStreetMap tiles; tiles you have viewed are cached for offline use. iPhone support (Safari) is untested; dictation and folder access behave differently there.
