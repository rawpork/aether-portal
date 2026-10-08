import ast
import os
import sys
import json
import subprocess

class SaaSManifestIngestor:
    def __init__(self, manifest_path: str = "master_tool_manifest.json", repos_dir: str = "./repos"):
        self.manifest_path = manifest_path
        self.repos_dir = repos_dir
        self.manifest = self._load_manifest()

    def _load_manifest(self):
        if os.path.exists(self.manifest_path):
            with open(self.manifest_path, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        return {}

    def parse_repository(self, repo_path: str, repo_name: str):
        tools = []
        for root, _, files in os.walk(repo_path):
            if "/." in root or "\\." in root or "venv" in root or "tests" in root:
                continue
            for file in files:
                full_path = os.path.join(root, file)
                if file.endswith(".py") and not file.startswith("test_") and not file.startswith("setup.py"):
                    tools.extend(self._extract_python_functions(full_path, repo_path))
                elif file.endswith(".md") and ("skill" in root.lower() or "agent" in root.lower() or "rule" in root.lower()):
                    md_tool = self._extract_markdown_definition(full_path, repo_name)
                    if md_tool:
                        tools.append(md_tool)
        return tools

    def _extract_python_functions(self, file_path: str, repo_root: str):
        tools = []
        rel_path = os.path.relpath(file_path, os.getcwd()).replace("\\", "/")
        rel_repo_root = os.path.relpath(repo_root, os.getcwd()).replace("\\", "/")
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            try:
                tree = ast.parse(f.read(), filename=file_path)
            except SyntaxError:
                return []
        for item in tree.body:
            if isinstance(item, ast.FunctionDef) and not item.name.startswith("_"):
                docstring = ast.get_docstring(item) or f"Native Python function '{item.name}'."
                tools.append({
                    "type": "PYTHON_NATIVE",
                    "name": item.name,
                    "file_path": rel_path,
                    "repo_root": rel_repo_root,
                    "description": docstring.split("\n")[0],
                    "args": [arg.arg for arg in item.args.args]
                })
        return tools

    def _extract_markdown_definition(self, file_path: str, repo_name: str):
        rel_path = os.path.relpath(file_path, os.getcwd()).replace("\\", "/")
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            lines = content.splitlines()
            title = lines[0].replace("#", "").strip() if lines else os.path.basename(file_path)
            summary = lines[1].strip() if len(lines) > 1 and lines[1].strip() else title
            return {
                "type": "MARKDOWN_PROMPT",
                "name": title.lower().replace(" ", "_"),
                "file_path": rel_path,
                "description": f"[Markdown Skill/Agent] {summary[:120]}",
                "args": ["project_path", "context_payload"]
            }

    def regenerate_and_split(self, repo_name: str):
        target_path = os.path.join(self.repos_dir, repo_name)
        candidate_tools = self.parse_repository(target_path, repo_name)
        verified_tools = {}
        for tool in candidate_tools:
            tool_id = f"{repo_name}.{tool['name']}" if tool["type"] == "PYTHON_NATIVE" else f"{repo_name}.md.{tool['name']}"
            verified_tools[tool_id] = tool

        self.manifest.update(verified_tools)
        with open(self.manifest_path, "w", encoding="utf-8") as f:
            json.dump(self.manifest, f, indent=2)

        sql_lines = [
            "CREATE TABLE IF NOT EXISTS tools_manifest (",
            "    tool_id TEXT PRIMARY KEY,",
            "    tool_type TEXT,",
            "    name TEXT,",
            "    description TEXT,",
            "    args_json TEXT,",
            "    file_path TEXT",
            ");\n"
        ]
        for tool_id, meta in self.manifest.items():
            args_str = json.dumps(meta.get("args", [])).replace("'", "''")
            desc_str = meta.get("description", "").replace("'", "''")
            file_str = meta.get("file_path", "").replace("\\", "/")
            sql_lines.append(
                f"INSERT OR REPLACE INTO tools_manifest (tool_id, tool_type, name, description, args_json, file_path) "
                f"VALUES ('{tool_id}', '{meta.get('type', 'NATIVE')}', '{meta.get('name')}', '{desc_str}', '{args_str}', '{file_str}');"
            )

        header = sql_lines[:8]
        inserts = sql_lines[8:]
        chunk_size = 100

        for i in range(0, len(inserts), chunk_size):
            chunk_file = f"studio-aether-engine/seed_part_{i//chunk_size + 1}.sql"
            with open(chunk_file, "w", encoding="utf-8") as cf:
                if i == 0:
                    cf.write("\n".join(header) + "\n")
                cf.write("\n".join(inserts[i:i+chunk_size]) + "\n")

        print("Successfully re-generated and cleanly split sanitized SQL chunks!")

if __name__ == "__main__":
    SaaSManifestIngestor().regenerate_and_split("ecc")
