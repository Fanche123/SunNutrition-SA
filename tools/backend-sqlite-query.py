import json
import math
import re
import sqlite3
import sys


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|replace|attach|detach|pragma|vacuum|reindex)\b",
    re.IGNORECASE,
)


def main():
    request = json.load(sys.stdin)
    sql = str(request.get("sql") or "").strip()
    cache_file = request.get("cacheFile")
    max_rows = int(request.get("maxRows") or 5000)

    validate_readonly_sql(sql)

    with open(cache_file, "r", encoding="utf-8-sig") as handle:
        cache = json.load(handle)

    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.set_progress_handler(lambda: 0, 100_000)
    try:
        load_backend_cache(connection, cache)
        cursor = connection.execute(sql)
        columns = [description[0] for description in cursor.description or []]
        rows = [dict(row) for row in cursor.fetchmany(max_rows + 1)]
        limited = len(rows) > max_rows
        if limited:
            rows = rows[:max_rows]
        print(json.dumps({
            "ok": True,
            "engine": "sqlite",
            "table": "consulta_sql",
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "totalRows": len(rows),
            "limited": limited,
        }, ensure_ascii=False))
    except sqlite3.Error as error:
        raise SystemExit(str(error))
    finally:
        connection.close()


def validate_readonly_sql(sql):
    if not sql:
        raise SystemExit("Escribi una consulta SQL.")
    if not re.match(r"^(select|with)\s+", sql, re.IGNORECASE):
        raise SystemExit("Solo se permiten consultas SELECT o WITH.")
    if WRITE_WORDS.search(sql):
        raise SystemExit("La consola SQL es solo de lectura.")
    if has_multiple_statements(sql):
        raise SystemExit("Ejecuta una sola consulta por vez.")


def has_multiple_statements(sql):
    stripped = sql.strip()
    if stripped.endswith(";"):
        stripped = stripped[:-1].strip()
    in_quote = ""
    for char in stripped:
        if in_quote:
            if char == in_quote:
                in_quote = ""
            continue
        if char in ("'", '"'):
            in_quote = char
            continue
        if char == ";":
            return True
    return False


def load_backend_cache(connection, cache):
    tables = cache.get("tables") or {}
    for table_name, table in tables.items():
        rows = table.get("rows") or []
        columns = table_columns(table, rows)
        if not columns:
            continue
        column_types = infer_column_types(rows, columns)
        create_sql = "CREATE TABLE {table} ({columns})".format(
            table=quote_identifier(table_name),
            columns=", ".join(
                f"{quote_identifier(column)} {column_types[column]}" for column in columns
            ),
        )
        connection.execute(create_sql)
        insert_rows(connection, table_name, columns, rows, column_types)


def table_columns(table, rows):
    columns = []
    for header in table.get("headers") or []:
        if isinstance(header, dict):
            key = header.get("key") or header.get("label")
        else:
            key = header
        key = str(key or "").strip()
        if key and key not in columns and key != "_rowNumber":
            columns.append(key)
    for row in rows:
        for key in row.keys():
            if key and key not in columns and key != "_rowNumber":
                columns.append(key)
    return columns


def infer_column_types(rows, columns):
    types = {}
    for column in columns:
        values = [
            row.get(column)
            for row in rows
            if row.get(column) not in ("", None)
        ]
        if values and all(to_number(value) is not None for value in values):
            types[column] = "REAL"
        else:
            types[column] = "TEXT"
    return types


def insert_rows(connection, table_name, columns, rows, column_types):
    placeholders = ", ".join("?" for _ in columns)
    insert_sql = "INSERT INTO {table} ({columns}) VALUES ({placeholders})".format(
        table=quote_identifier(table_name),
        columns=", ".join(quote_identifier(column) for column in columns),
        placeholders=placeholders,
    )
    values = []
    for row in rows:
        values.append([
            normalize_value(row.get(column), column_types[column])
            for column in columns
        ])
    if values:
        connection.executemany(insert_sql, values)


def normalize_value(value, column_type):
    if value in ("", None):
        return None
    if column_type == "REAL":
        number = to_number(value)
        return number if number is not None else None
    return str(value)


def to_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value).strip()
    if not text:
        return None
    clean = text.replace("$", "").replace(" ", "")
    if re.match(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$", clean):
        clean = clean.replace(".", "").replace(",", ".")
    elif re.match(r"^-?\d+,\d+$", clean):
        clean = clean.replace(",", ".")
    try:
        return float(clean)
    except ValueError:
        return None


def quote_identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


if __name__ == "__main__":
    main()
