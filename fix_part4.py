import json

with open("studio-aether-engine/master_tool_manifest.json", "r", encoding="utf-8-sig") as f:
    manifest = json.load(f)

items = list(manifest.items())[300:400]
sql_statements = []

for t_id, m in items:
    tool_type = m.get("type", "NATIVE")
    name = m.get("name", "")
    desc = m.get("description", "").replace("'", "''")
    args = json.dumps(m.get("args", [])).replace("'", "''")
    file_path = m.get("file_path", "").replace("\\", "/")
    
    sql = f"INSERT OR REPLACE INTO tools_manifest (tool_id, tool_type, name, description, args_json, file_path) VALUES ('{t_id}', '{tool_type}', '{name}', '{desc}', '{args}', '{file_path}');"
    sql_statements.append(sql)

with open("studio-aether-engine/seed_part_4_clean.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(sql_statements) + "\n")

print("Generated seed_part_4_clean.sql successfully!")
