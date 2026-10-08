import json
import sqlite3

with open("studio-aether-engine/master_tool_manifest.json", "r", encoding="utf-8-sig") as f:
    manifest = json.load(f)

items = list(manifest.items())[300:400]

# Setup temporary in-memory database to test SQLite parsing
conn = sqlite3.connect(":memory:")
cursor = conn.cursor()
cursor.execute("""
    CREATE TABLE tools_manifest (
        tool_id TEXT PRIMARY KEY,
        tool_type TEXT,
        name TEXT,
        description TEXT,
        args_json TEXT,
        file_path TEXT
    );
""")

valid_sqls = []

for idx, (t_id, m) in enumerate(items):
    tool_type = m.get("type", "NATIVE")
    name = m.get("name", "")
    desc = m.get("description", "")
    args = json.dumps(m.get("args", []))
    file_path = m.get("file_path", "").replace("\\", "/")

    # Use parameterized SQL execution to generate safely escaped SQL literals
    try:
        # Test parameter insert first
        cursor.execute(
            "INSERT OR REPLACE INTO tools_manifest VALUES (?, ?, ?, ?, ?, ?)",
            (t_id, tool_type, name, desc, args, file_path)
        )
        
        # Build strict SQL string with proper quote escaping
        clean_tid = t_id.replace("'", "''")
        clean_ttype = tool_type.replace("'", "''")
        clean_name = name.replace("'", "''")
        clean_desc = desc.replace("'", "''")
        clean_args = args.replace("'", "''")
        clean_path = file_path.replace("'", "''")

        sql = f"INSERT OR REPLACE INTO tools_manifest (tool_id, tool_type, name, description, args_json, file_path) VALUES ('{clean_tid}', '{clean_ttype}', '{clean_name}', '{clean_desc}', '{clean_args}', '{clean_path}');"
        
        # Test raw SQL execution locally
        cursor.execute(sql)
        valid_sqls.append(sql)

    except Exception as e:
        print(f"Error on item {idx} ({t_id}): {e}")

with open("studio-aether-engine/seed_part_4_validated.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(valid_sqls) + "\n")

print(f"Validated and generated {len(valid_sqls)} clean SQL statements in seed_part_4_validated.sql!")
