# Test fixture provenance

Every file here is a **synthetic contract fixture**, written by hand for tests. None is a captured
upstream response or a real record. Names, UENs and IDs are invented (UENs use the impossible year
"99", e.g. `T99SY0001A`; links use the reserved `example.org`).

| File | Shaped after | Not verified |
|---|---|---|
| `acra-contract.csv` | Field IDs observed in the data.gov.sg `datastore_search` sample (packet [4]): `uen, issuance_agency_desc, uen_status_desc, entity_name, entity_type_desc, uen_issue_date, reg_street_name, reg_postal_code` | Real CSV column order, quoting style, line endings, BOM presence, status/type vocabularies |
| `os-contract.ndjson` | FtM line-delimited entities as documented (packet [2], [3]): `id, schema, caption, datasets, referents, first_seen, last_change, properties{...}` with string arrays | Context-schema property names (`Sanction.entity`, `Family.person`, `Occupancy.post`, ...) come from the FtM model, not the packet |

Generated benchmark data (`tools/bench.ts`) is also synthetic and is never committed.
