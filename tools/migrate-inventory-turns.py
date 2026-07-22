import argparse
import csv
import unicodedata
from pathlib import Path


TURN_COLUMNS = [
    ("Madrugada", "turno madrugadacf"),
    ("Mañana", "turno mananacf"),
    ("Tarde", "cantidad formulario"),
]


def normalize_header(value):
    text = str(value or "").strip().replace("_", " ").lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(char for char in text if not unicodedata.combining(char))
    return " ".join(text.split())


def read_csv(path):
    with Path(path).open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def pick(row, *names):
    normalized = {normalize_header(key): value for key, value in row.items()}
    for name in names:
        if normalize_header(name) in normalized:
            return str(normalized[normalize_header(name)] or "").strip()
    return ""


def build_turn_rows(inventory_rows, detail_rows):
    inventory_by_id = {
        pick(row, "Id_Inventario", "id_inventario"): row
        for row in inventory_rows
        if pick(row, "Id_Inventario", "id_inventario")
    }
    detail_by_inventory = {}
    for row in detail_rows:
        inventory_id = pick(row, "Id_Inventario", "id_inventario")
        if inventory_id:
            detail_by_inventory.setdefault(inventory_id, []).append(row)

    new_inventory = []
    new_detail = []
    next_inventory_id = 1
    next_detail_id = 1

    for old_inventory_id in sorted(inventory_by_id, key=lambda value: int(value) if value.isdigit() else value):
        source_inventory = inventory_by_id[old_inventory_id]
        source_details = detail_by_inventory.get(old_inventory_id, [])
        if not source_details:
            continue

        turn_groups = []
        for turn_label, turn_column in TURN_COLUMNS:
            turn_details = []
            for source_detail in source_details:
                quantity = pick(source_detail, turn_column)
                item_id = pick(source_detail, "Id_Item", "id_item")
                if quantity == "" or item_id == "":
                    continue
                turn_details.append((item_id, quantity))

            if turn_details:
                turn_groups.append((turn_label, turn_details))

        single_turn_day = len(turn_groups) == 1

        for turn_label, turn_details in turn_groups:
            new_inventory.append({
                "Id_Inventario": next_inventory_id,
                "Fecha": pick(source_inventory, "Fecha", "fecha"),
                "Turno": "Mañana" if single_turn_day else turn_label,
                "Id_Empleado": pick(source_inventory, "Id_Empleado", "id_empleado", "Empleado", "empleado"),
            })
            for item_id, quantity in turn_details:
                new_detail.append({
                    "Id_Detalle_Inventario": next_detail_id,
                    "Id_Inventario": next_inventory_id,
                    "Id_Item": item_id,
                    "Cantidad": quantity,
                })
                next_detail_id += 1

            next_inventory_id += 1

    return new_inventory, new_detail


def write_csv(path, rows, headers):
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Migra inventario por dia/turnos en columnas al formato inventario por turno.")
    parser.add_argument("--inventario", required=True, help="CSV viejo de Inventario.")
    parser.add_argument("--detalle", required=True, help="CSV viejo de Detalle_Inventario.")
    parser.add_argument("--salida", default="outputs/inventario_migrado", help="Carpeta de salida.")
    args = parser.parse_args()

    inventory_rows = read_csv(args.inventario)
    detail_rows = read_csv(args.detalle)
    new_inventory, new_detail = build_turn_rows(inventory_rows, detail_rows)
    output_dir = Path(args.salida)

    write_csv(
        output_dir / "Inventario_migrado.csv",
        new_inventory,
        ["Id_Inventario", "Fecha", "Turno", "Id_Empleado"],
    )
    write_csv(
        output_dir / "Detalle_Inventario_migrado.csv",
        new_detail,
        ["Id_Detalle_Inventario", "Id_Inventario", "Id_Item", "Cantidad"],
    )

    print(f"Inventario migrado: {len(new_inventory)} filas")
    print(f"Detalle inventario migrado: {len(new_detail)} filas")
    print(f"Salida: {output_dir.resolve()}")


if __name__ == "__main__":
    main()
