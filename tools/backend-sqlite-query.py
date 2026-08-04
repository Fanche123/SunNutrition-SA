import json
import math
import re
import sqlite3
import sys
import time


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
    max_time_ms = int(request.get("maxTimeMs") or 4000)
    max_progress_callbacks = int(request.get("maxProgressCallbacks") or 20000)
    progress_operations = int(request.get("progressOperations") or 10000)

    try:
        validate_readonly_sql(sql)
    except QueryError as error:
        emit_error(error.code, str(error))
        return 2

    if request.get("validateOnly") is True:
        return validate_schema_only(sql, request.get("schema") or {})

    try:
        with open(cache_file, "r", encoding="utf-8-sig") as handle:
            cache = json.load(handle)
    except (OSError, ValueError):
        emit_error("SQL_EXECUTION_ERROR", "No se pudo preparar la fuente de consulta.")
        return 2

    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    budget = QueryBudget(max_time_ms, max_progress_callbacks)
    connection.set_progress_handler(budget.progress, progress_operations)
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
    except sqlite3.Error:
        if budget.exceeded == "time":
            emit_error("SQL_TIMEOUT", "La consulta supero el tiempo maximo permitido.")
        elif budget.exceeded == "callbacks":
            emit_error("SQL_BUDGET_EXCEEDED", "La consulta supero el presupuesto de operaciones permitido.")
        else:
            emit_error("SQL_EXECUTION_ERROR", "No se pudo ejecutar la consulta SQL.")
        return 2
    finally:
        connection.close()
    return 0


def validate_readonly_sql(sql):
    if not sql:
        raise QueryError("SQL_INVALID", "Escribi una consulta SQL.")
    if not re.match(r"^(select|with)\s+", sql, re.IGNORECASE):
        raise QueryError("SQL_FORBIDDEN", "Solo se permiten consultas SELECT o WITH.")
    if WRITE_WORDS.search(sql):
        raise QueryError("SQL_FORBIDDEN", "La consola SQL es solo de lectura.")
    if has_multiple_statements(sql):
        raise QueryError("SQL_INVALID", "Ejecuta una sola consulta por vez.")


def validate_schema_only(sql, schema):
    connection = sqlite3.connect(":memory:")
    try:
        for table in schema.get("tables") or []:
            table_name = str(table.get("name") or "").strip()
            columns = table.get("columns") or []
            if not table_name or not columns:
                continue
            definitions = []
            for column in columns:
                column_name = str(column.get("name") or "").strip()
                if not column_name:
                    continue
                declared_type = str(column.get("type") or "text").lower()
                sqlite_type = "REAL" if declared_type == "number" else "INTEGER" if declared_type in ("integer", "boolean") else "TEXT"
                definitions.append(f"{quote_identifier(column_name)} {sqlite_type}")
            if definitions:
                connection.execute(
                    f"CREATE TABLE {quote_identifier(table_name)} ({', '.join(definitions)})"
                )
        connection.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall()
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return 0
    except sqlite3.Error:
        emit_error("SQL_INVALID", "La propuesta no es una consulta SQLite válida para el esquema disponible.")
        return 2
    finally:
        connection.close()


class QueryError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class QueryBudget:
    def __init__(self, max_time_ms, max_callbacks):
        self.deadline = time.monotonic() + max(max_time_ms, 1) / 1000
        self.max_callbacks = max(max_callbacks, 1)
        self.callbacks = 0
        self.exceeded = ""

    def progress(self):
        self.callbacks += 1
        if time.monotonic() >= self.deadline:
            self.exceeded = "time"
            return 1
        if self.callbacks >= self.max_callbacks:
            self.exceeded = "callbacks"
            return 1
        return 0


def emit_error(code, message):
    print(json.dumps({
        "ok": False,
        "code": code,
        "error": message,
    }, ensure_ascii=False))


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
    raise SystemExit(main())
