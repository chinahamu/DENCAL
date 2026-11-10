CREATE TABLE IF NOT EXISTS master_item_catalog_details (
    item_id INTEGER PRIMARY KEY REFERENCES master_items(id),
    search_text TEXT NOT NULL,
    icd10 TEXT NOT NULL,
    unit TEXT NOT NULL,
    drug_form TEXT NOT NULL,
    price_code TEXT NOT NULL,
    selectable INTEGER NOT NULL CHECK (selectable IN (0, 1))
);
