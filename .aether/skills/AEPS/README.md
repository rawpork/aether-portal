# AEPS skills

Link proprietary skill folders here (each containing a `SKILL.md`), for example:

    mklink /J .aether\skills\AEPS\<skill-name> D:\path\to\<skill-name>      (Windows junction)
    ln -s /path/to/<skill-name> .aether/skills/AEPS/<skill-name>            (macOS / Linux)

`npm run build:client` (also run by `wrangler deploy`) scans this folder, following links, and bundles every
`SKILL.md` into the Worker. Mission Control lists them under an agent's **Skills** tab, served to signed-in users
only from `GET /api/skills/aeps`. The linked folders themselves are git-ignored.
