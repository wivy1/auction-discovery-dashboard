# Offline ZIP-coordinate data

`us-zcta-centroids-2025.json` is a compact, deterministic derivative of the
U.S. Census Bureau's **2025 ZIP Code Tabulation Areas Gazetteer File**:

- Source archive:
  `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip`
- Retrieved: 2026-07-14
- Source SHA-256:
  `51516a4283bab5cd2376eec75609ddc4b363a18297e8adeeaac7b03cf7c84dbe`
- Source member: `2025_Gaz_zcta_national.txt`
- Records: 33,791, sorted by five-digit `GEOID`
- Coordinates: `INTPTLAT` and `INTPTLONG`, encoded as signed integer
  microdegrees (`scale = 1,000,000`)

The compact JSON fields are: vintage (`v`), record count (`n`), coordinate
scale (`s`), concatenated sorted five-character ZCTA codes (`z`), and
interleaved latitude/longitude integers (`c`). No names, areas, boundaries, or
other source columns are retained.

ZCTAs are generalized Census representations of USPS ZIP service areas, and
the Census Bureau explicitly notes that not every valid USPS ZIP has a ZCTA.
Consequently, a missing lookup is never treated as nearby and is not by itself
a geographic exclusion. The local proximity estimator may next use one exact
unique Census place; otherwise it records `unknown_location`. The dataset is a
rough geographic reference, not USPS address validation.

The Census Bureau publishes these files as public open data. Retain this
provenance and citation when updating or redistributing the derivative.

## State envelopes

`us-state-envelopes-2025.json` is a compact derivative of the U.S. Census
Bureau's **2025 TIGER/Line State and Equivalent Entity National Shapefile**:

- Source archive:
  `https://www2.census.gov/geo/tiger/TIGER2025/STATE/tl_2025_us_state.zip`
- Retrieved: 2026-07-22
- Source SHA-256:
  `59a220888a8d9be8117c4fcd38f542bd02d81abf0d198c78113595ad540dd957`
- Source members: `tl_2025_us_state.shp` and `tl_2025_us_state.dbf`
- Records: 56, sorted by `STUSPS`
- Coordinates: each polygon record's complete WGS84
  `[minimum longitude, minimum latitude, maximum longitude, maximum latitude]`
  bounding envelope

The compact JSON fields are the vintage (`v`), record count (`n`), and ordered
envelopes (`b`). The runtime computes the minimum spherical separation to the
entire rectangle, so the result is a lower bound to every point in the state.
Only a lower bound strictly above the existing 1,000-mile terminal threshold
may exclude a listing. Unknown countries, states, origins, and unsupported
postal codes fail open to the remaining local evidence hierarchy. If no
supported point exists after one bounded detail-location opportunity, the
listing remains explicitly unknown.

## Active incorporated-place envelopes

`us-place-envelopes-2025.json` is a compact derivative of the U.S. Census
Bureau's **2025 TIGER/Line PLACE Shapefiles**. That release has no national
`tl_2025_us_place.zip`; Census publishes one archive for each state or
territory instead:

- Source directory:
  `https://www2.census.gov/geo/tiger/TIGER2025/PLACE/`
- Exact archive pattern: `tl_2025_{STATEFP}_place.zip`
- Retrieved: 2026-07-22
- Source archives: 56, totaling 145,663,387 bytes
- Aggregate manifest SHA-256:
  `582483fcd6967566f3af2ed477240d44147b68284334b0b069cc9838fad5e219`
- Manifest definition: the SHA-256 of sorted
  `filename<TAB>size<TAB>archive-sha256<LF>` records
- State-FIPS lookup source:
  `https://www2.census.gov/geo/tiger/TIGER2025/STATE/tl_2025_us_state.zip`
- Derived JSON SHA-256:
  `68d933e72486ff52c44fdad93f4f17ce5ecade4f530402147bbfdca52c38a9dc`

All 32,629 DBF/SHP records were read in record order; none was deleted and none
had a null shape. The per-state PLACE DBFs contain `STATEFP`, `NAME`, and
`NAMELSAD`, but no `STUSPS` or `BASENAME`, so `STATEFP` is mapped through the
official state archive and `NAME` is the only matchable base label. Names use
Unicode NFC, trimmed/collapsed whitespace, and lowercase. Punctuation and
qualifiers are never removed or rewritten.

The derivative retains 19,396 records only when the normalized
`STUSPS + NAME` key occurs exactly once across the complete corpus and the sole
record has active-government `FUNCSTAT=A`. It omits 212 ambiguous keys spanning
436 records and 12,797 unique CDP, statistical, inactive, or otherwise
non-active records. Unknown, ambiguous, qualified differently, unincorporated,
and unmatched card labels therefore remain unresolved rather than being
guessed.

The compact JSON fields are the vintage (`v`), retained record count (`n`), and
state map (`b`). Each state value is an ordered array of
`[normalized NAME, minimum longitude, minimum latitude, maximum longitude,
maximum latitude]`. The conservative prefilter applies this envelope only
after exact ZIP and complete-state checks. A resolved exact ZIP remains
authoritative. Otherwise, an exact unique place may supply the envelope center
to the approximate estimator, while an envelope minimum strictly above the
existing 1,000-mile terminal threshold may still avoid unnecessary downstream
work.
