import json, re

with open("studio-aether-engine/master_tool_manifest.json", "r", encoding="utf-8-sig") as f:
    manifest = json.load(f)

items = list(manifest.items())[300:400]
sql_statements = []

for idx, (t_id, m) in enumerate(items):
    tool_type = m.get("type", "NATIVE")
    name = m.get("name", "")
    
    # Strip non-alphanumeric chars or strictly escape single quotes
    raw_desc = m.get("description", "")
    desc = raw_desc.replace("'", "''")
    
    args = json.dumps(m.get("args", [])).replace("'", "''")
    file_path = m.get("file_path", "").replace("\\", "/")
    
    sql = f"INSERT OR REPLACE INTO tools_manifest (tool_id, tool_type, name, description, args_json, file_path) VALUES ('{t_id}', '{tool_type}', '{name}', '{desc}', '{args}', '{file_path}');"
    sql_statements.append(sql)

with open("studio-aether-engine/seed_part_4_final.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(sql_statements) + "\n")

print("Generated seed_part_4_final.sql cleanly!")
