"""Initialize a fresh DENCAL SQLite database without overwriting an existing file."""

import argparse
from contextlib import closing
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, nargs="?", default=Path("data/dencal.sqlite3"))
    path = parser.parse_args().database
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.touch(exist_ok=False)
    except FileExistsError:
        parser.exit(1, f"既存DBの上書きを拒否しました。別のファイル名を指定してください。\n")
    try:
        with closing(sqlite3.connect(path)) as connection:
            connection.executescript(schema)
    except Exception:
        path.unlink()
        raise
    print(f"SQLite DBを初期化しました。 {path}")


if __name__ == "__main__":
    main()
